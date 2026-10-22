// `weft-adapter-antigravity` CLI (bundled to dist/weft-antigravity.mjs).
//
//   install          .weft/antigravity.json (+ token), .agents/hooks.json (workspace hooks),
//                    git hooks, agent CLI (.weft/bin/weft)
//   hook [<Event>]   Antigravity hook entry: JSON on stdin -> JSON on stdout (always exit 0)
//   (+ the shared commit-msg, pre-commit, heartbeat-loop, status, negotiate, inbox)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities } from "@weft/protocol";
import { Host, readStdin } from "../../claude-code/src/host";
import { ADAPTER_VERSION } from "../../claude-code/src/hooks";
import { EDIT_TOOLS, EVENTS, SHELL_TOOL, eventOf, failOpen, fromCore, hooksPath, rootOf, toCore, type AntigravityEvent, type AntigravityInput } from "./translate";

const SELF = fileURLToPath(import.meta.url);
export const HOOK_NAME = "weft";
export const HOOK_MARK = "weft-antigravity";
export const CONFIG_REL = ".weft/antigravity.json";

/**
 * PreToolUse deny + reason (L2), SessionStart / PreInvocation injectSteps before the next model
 * call (delayed L1: PostToolUse cannot inject), Stop decision:"continue" (L3), git commit
 * intercepted in run_command. All verified live on agy 1.4.5 (demo/evidence/antigravity/).
 */
export const CAPABILITIES: Capabilities = {
  level: 3,
  observe: "sync",
  inject: "delayed",
  deny_edit: true,
  refuse_stop: true,
  commit_gate: "tool_interception",
};

type Handler = { type: "command"; command: string; timeout?: number };
type Group = { matcher?: string; hooks: Handler[] };
type HookDef = { enabled?: boolean } & Partial<Record<AntigravityEvent, Array<Group | Handler>>>;

/** The Weft entry for hooks.json (`{ "<hook-name>": { <Event>: [...] } }`); foreign hook names are kept. */
export function mergeHooks(file: Record<string, HookDef>, command: (event: AntigravityEvent) => string): Record<string, HookDef> {
  const h = (event: AntigravityEvent): Handler => ({ type: "command", command: command(event), timeout: 30 });
  const ours: HookDef = {
    // Only the edit tools and run_command: every matched call must get a `decision` back.
    PreToolUse: [{ matcher: [...EDIT_TOOLS, SHELL_TOOL].join("|"), hooks: [h("PreToolUse")] }],
    PostToolUse: [{ matcher: "*", hooks: [h("PostToolUse")] }],
    // Matcher-less events take handlers directly (docs example `"PreInvocation": [{type, command}]`).
    SessionStart: [h("SessionStart")],
    PreInvocation: [h("PreInvocation")],
    Stop: [h("Stop")],
  };
  const kept = Object.fromEntries(Object.entries(file).filter(([name, def]) => name !== HOOK_NAME && !JSON.stringify(def).includes(HOOK_MARK)));
  return { ...kept, [HOOK_NAME]: ours };
}

export const host = new Host({
  name: "antigravity",
  bin: "weft-adapter-antigravity",
  configRel: CONFIG_REL,
  harness: "antigravity",
  adapter: `@weft/adapter-antigravity@${ADAPTER_VERSION}`,
  capabilities: CAPABILITIES,
  self: SELF,
  excludes: [".agents/hooks.json"],
  installHarness: (root, hookCommand) => {
    const p = hooksPath(root);
    mkdirSync(dirname(p), { recursive: true });
    const prev = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, HookDef>) : {};
    writeFileSync(p, JSON.stringify(mergeHooks(prev, (event) => `${hookCommand} ${event} # ${HOOK_MARK}`), null, 2) + "\n");
    return [`hooks: ${p} (Antigravity 2.0, CLI and IDE read workspace hooks from .agents/hooks.json)`];
  },
});

async function hook(args: string[]): Promise<void> {
  const named = args.find((a): a is AntigravityEvent => (EVENTS as string[]).includes(a));
  let json: Record<string, unknown> = failOpen(named);
  try {
    const raw = JSON.parse(await readStdin()) as AntigravityInput;
    const event = named ?? eventOf(raw);
    json = failOpen(event);
    const loaded = event ? host.load(rootOf(raw)) : undefined;
    const input = loaded && event ? toCore(raw, event) : undefined;
    if (loaded && event && input) {
      const out = await host.run(loaded, input, { antigravity_event: event, ...(raw.toolCall?.name ? { antigravity_tool: raw.toolCall.name } : {}) });
      const canInject = event === "SessionStart" || event === "PreInvocation" || event === "Stop";
      const carried = canInject ? host.takeCarry(loaded.root, input.session_id) : "";
      const r = fromCore(event, out, carried);
      if (r.carry) host.addCarry(loaded.root, input.session_id, r.carry);
      json = r.json;
    }
  } catch {
    // fail open: keeps the answer chosen above (`ask` for PreToolUse, `{}` elsewhere)
  }
  process.stdout.write(JSON.stringify(json));
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === SELF || /weft-adapter-antigravity(\.mjs)?$/.test(entry)) {
  host.main(process.argv.slice(2), hook).catch((err) => {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
