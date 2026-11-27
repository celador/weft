// `weft-adapter-gemini` CLI (bundled to dist/weft-gemini.mjs). FIXTURE-TESTED ONLY (see translate.ts).
//
//   install   .weft/gemini.json (+ token), .gemini/settings.json hooks, git hooks, agent CLI
//   hook      Gemini CLI hook entry: JSON on stdin -> JSON on stdout (always exit 0)
//             (`hook --by-path --url U --repo R`, from `install --by-path`: an edit inside another
//             joined checkout acts as that checkout's agent)
//   (+ the shared commit-msg, pre-commit, heartbeat-loop, status, negotiate, inbox)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities } from "@weft/protocol";
import { Host, readStdin } from "../../claude-code/src/host";
import { ADAPTER_VERSION } from "../../claude-code/src/hooks";
import { fromCore, toCore, type GeminiInput } from "./translate";

const SELF = fileURLToPath(import.meta.url);
export const HOOK_MARK = "weft-gemini";
export const CONFIG_REL = ".weft/gemini.json";

/** Documented L3 (BeforeTool deny, AfterTool context, AfterAgent retry). Fixture-tested only. */
export const CAPABILITIES: Capabilities = {
  level: 3,
  observe: "sync",
  inject: "immediate",
  deny_edit: true,
  refuse_stop: true,
  commit_gate: "tool_interception",
};

type HookCfg = { type: "command"; command: string; name?: string; timeout?: number };
type Group = { matcher?: string; sequential?: boolean; hooks: HookCfg[] };

/** Merge Weft hooks into a Gemini settings object (hooks.<Event>[] matcher groups), replacing previous Weft groups. */
export function mergeSettings(settings: Record<string, unknown>, command: string): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, Group[]>) ?? {}) };
  const ours = (matcher?: string): Group => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, name: HOOK_MARK, timeout: 30_000 }] });
  const want: Record<string, Group> = {
    SessionStart: ours(),
    BeforeAgent: ours(),
    BeforeTool: ours("write_file|replace|run_shell_command"),
    AfterTool: ours(".*"),
    AfterAgent: ours(),
    SessionEnd: ours(),
  };
  for (const [event, group] of Object.entries(want)) {
    const kept = (hooks[event] ?? []).map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.name !== HOOK_MARK && !h.command.includes(HOOK_MARK)) })).filter((g) => g.hooks.length);
    hooks[event] = [...kept, group];
  }
  return { ...settings, hooks };
}

export const host = new Host({
  name: "gemini",
  bin: "weft-adapter-gemini",
  configRel: CONFIG_REL,
  harness: "gemini-cli",
  adapter: `@weft/adapter-gemini@${ADAPTER_VERSION}`,
  capabilities: CAPABILITIES,
  self: SELF,
  excludes: [".gemini/settings.json"],
  installHarness: (root, hookCommand) => {
    const p = join(root, ".gemini", "settings.json");
    mkdirSync(dirname(p), { recursive: true });
    const prev = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
    writeFileSync(p, JSON.stringify(mergeSettings(prev, `${hookCommand} # ${HOOK_MARK}`), null, 2) + "\n");
    return [`hooks: ${p}`, "NOTE: fixture-tested only — no live Gemini CLI run has verified this adapter"];
  },
});

async function hook(args: string[] = []): Promise<void> {
  let json: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readStdin()) as GeminiInput;
    const core = toCore(raw);
    const loaded = host.load(raw.cwd ?? process.env.GEMINI_PROJECT_DIR ?? process.cwd(), { args, input: core });
    const input = loaded ? core : undefined;
    if (loaded && input) {
      const out = await host.run(loaded, input, { gemini_event: raw.hook_event_name });
      const canInject = ["AfterTool", "AfterAgent", "BeforeAgent", "SessionStart"].includes(raw.hook_event_name);
      const carried = canInject ? host.takeCarry(loaded.root, input.session_id) : "";
      const r = fromCore(raw.hook_event_name, out, carried);
      if (r.carry) host.addCarry(loaded.root, input.session_id, r.carry);
      json = r.json;
    }
  } catch {
    json = {}; // fail open
  }
  process.stdout.write(JSON.stringify(json)); // "Silence is mandatory": nothing but the JSON
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === SELF || /weft-adapter-gemini(\.mjs)?$/.test(entry)) {
  host.main(process.argv.slice(2), hook).catch((err) => {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
