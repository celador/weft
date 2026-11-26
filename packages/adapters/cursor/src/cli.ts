// `weft-adapter-cursor` CLI (bundled to dist/weft-cursor.mjs).
//
//   install   .weft/cursor.json (+ token), .cursor/hooks.json (project hooks), git hooks, agent CLI
//   hook      Cursor hook entry: Cursor JSON on stdin -> Cursor JSON on stdout (always exit 0)
//             (`hook --by-path --url U --repo R`, from `install --by-path`: an edit inside another
//             joined checkout, e.g. a subagent's worktree, acts as that checkout's agent)
//   (+ the shared commit-msg, pre-commit, heartbeat-loop, status, negotiate, inbox)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities } from "@weft/protocol";
import { Host, readStdin } from "../../claude-code/src/host";
import { ADAPTER_VERSION, type HookInput } from "../../claude-code/src/hooks";
import type { Loaded } from "../../claude-code/src/config";
import { beforeFromEdits, cwdOf, fromCore, sessionOf, toCore, type CursorInput } from "./translate";

const SELF = fileURLToPath(import.meta.url);
export const HOOK_MARK = "weft-cursor";
export const CONFIG_REL = ".weft/cursor.json";

/**
 * Documented (cursor.com/docs/hooks): preToolUse deny + agent_message (L2), postToolUse
 * additional_context (L1), stop followup_message (L3, bounded by loop_limit). Not yet
 * verified against a live cursor-agent run (see README "Verification status").
 */
export const CAPABILITIES: Capabilities = {
  level: 3,
  observe: "sync",
  inject: "immediate",
  deny_edit: true,
  refuse_stop: true,
  commit_gate: "tool_interception",
};

type HookDef = { command: string; matcher?: string; timeout?: number; loop_limit?: number | null };
type HooksFile = { version: number; hooks: Record<string, HookDef[]> };

/** Merge Weft hooks into a Cursor hooks.json object, replacing previous Weft entries. */
export function mergeHooks(file: Partial<HooksFile>, command: string): HooksFile {
  const hooks: Record<string, HookDef[]> = { ...(file.hooks ?? {}) };
  const want: Record<string, HookDef> = {
    sessionStart: { command, timeout: 30 },
    preToolUse: { command, timeout: 30 },
    postToolUse: { command, timeout: 30 },
    afterFileEdit: { command, timeout: 30 },
    stop: { command, timeout: 30, loop_limit: 5 },
    sessionEnd: { command, timeout: 10 },
  };
  for (const [event, def] of Object.entries(want)) {
    hooks[event] = [...(hooks[event] ?? []).filter((h) => !h.command.includes(HOOK_MARK)), def];
  }
  return { version: file.version ?? 1, hooks };
}

export const host = new Host({
  name: "cursor",
  bin: "weft-adapter-cursor",
  configRel: CONFIG_REL,
  harness: "cursor-cli",
  adapter: `@weft/adapter-cursor@${ADAPTER_VERSION}`,
  capabilities: CAPABILITIES,
  self: SELF,
  excludes: [".cursor/hooks.json"],
  installHarness: (root, hookCommand) => {
    // The command carries the marker so re-installs replace (not duplicate) our entries.
    const command = `${hookCommand} # ${HOOK_MARK}`;
    const p = join(root, ".cursor", "hooks.json");
    mkdirSync(dirname(p), { recursive: true });
    const prev = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Partial<HooksFile>) : {};
    writeFileSync(p, JSON.stringify(mergeHooks(prev, command), null, 2) + "\n");
    return [`hooks: ${p} (project hooks; headless runs need --trust)`];
  },
});

const hash = (s: string | null) => (s === null ? "null" : createHash("sha1").update(s).digest("hex"));

async function hook(args: string[] = []): Promise<void> {
  let json: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readStdin()) as CursorInput;
    const event = raw.hook_event_name;
    if (event === "preToolUse") json = { permission: "allow" }; // fail open with a valid answer
    const cwd = cwdOf(raw);
    // Routed by the edited file under --by-path (afterFileEdit names it in file_path).
    const routeInput: HookInput | undefined =
      event === "afterFileEdit" ? (raw.file_path ? { hook_event_name: "PostToolUse", session_id: "", cwd, tool_name: "Write", tool_input: { file_path: raw.file_path } } : undefined) : toCore(raw);
    const loaded = host.load(cwd, { args, input: routeInput });
    const session = sessionOf(raw);
    if (loaded && session) {
      if (event === "afterFileEdit") {
        await afterFileEdit(raw, loaded, session);
        json = {};
      } else {
        const input = toCore(raw);
        if (input) {
          const out = await host.run(loaded, input, { cursor_event: event });
          if (event === "postToolUse" && input.tool_name && ["Edit", "Write", "MultiEdit"].includes(input.tool_name)) remember(loaded.root, session, input.tool_input);
          const carried = event === "postToolUse" || event === "stop" || event === "sessionStart" ? host.takeCarry(loaded.root, session) : "";
          const r = fromCore(event, out, carried);
          if (r.carry) host.addCarry(loaded.root, session, r.carry);
          json = r.json;
        }
      }
    }
  } catch {
    /* fail open: keep the default answer */
  }
  process.stdout.write(JSON.stringify(json));
}

/** Hash of the text the adapter last accounted for per file (afterFileEdit dedupe). */
function remember(root: string, session: string, toolInput: Record<string, unknown> | undefined): void {
  const p = typeof toolInput?.file_path === "string" ? resolve(root, toolInput.file_path) : undefined;
  if (!p) return;
  const st = join(root, ".weft", "state", `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.cursor-seen.json`);
  try {
    const seen = existsSync(st) ? (JSON.parse(readFileSync(st, "utf8")) as Record<string, string>) : {};
    seen[relative(root, p)] = hash(existsSync(p) ? readFileSync(p, "utf8") : null);
    mkdirSync(dirname(st), { recursive: true });
    writeFileSync(st, JSON.stringify(seen));
  } catch {
    /* best effort */
  }
}

/**
 * afterFileEdit fires for every agent edit, including ones postToolUse already accounted
 * for. Only an edit whose resulting text the adapter has not seen is committed (e.g. an
 * edit tool that Cursor does not route through pre/postToolUse). Its before-text is
 * reconstructed from the edit records when possible.
 */
async function afterFileEdit(raw: CursorInput, loaded: Loaded, session: string): Promise<void> {
  const root = loaded.root;
  if (!raw.file_path) return;
  const abs = resolve(root, raw.file_path);
  const rel = relative(root, abs);
  if (rel.startsWith("..")) return;
  const now = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  const st = join(root, ".weft", "state", `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.cursor-seen.json`);
  const seen = existsSync(st) ? (JSON.parse(readFileSync(st, "utf8")) as Record<string, string>) : {};
  if (seen[rel] === hash(now)) return;
  const callId = `afterFileEdit-${Date.now()}`;
  const before = now !== null && raw.edits?.length ? beforeFromEdits(now, raw.edits) : undefined;
  if (before !== undefined) await host.seedBefore(root, session, callId, "Write", { [rel]: before });
  const out = await host.run(loaded, { hook_event_name: "PostToolUse", session_id: session, cwd: root, tool_name: "Write", tool_input: { file_path: abs }, tool_use_id: callId }, { cursor_event: "afterFileEdit" });
  remember(root, session, { file_path: abs });
  // afterFileEdit has no model-facing output: deliver at the next postToolUse/stop.
  const text = (out as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput?.additionalContext;
  if (text) host.addCarry(root, session, text);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === SELF || /weft-adapter-cursor(\.mjs)?$/.test(entry)) {
  host.main(process.argv.slice(2), hook).catch((err) => {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
