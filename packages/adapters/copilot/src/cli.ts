// `weft-adapter-copilot` CLI (bundled to dist/weft-copilot.mjs).
//
//   install   .weft/copilot.json (+ token), .github/hooks/weft.json (Copilot hooks), git hooks, agent CLI
//   hook EVT  Copilot hook entry: JSON on stdin -> JSON on stdout (always exit 0). EVT is the
//             event the entry is registered under (camelCase payloads carry no event name).
//   (+ the shared commit-msg, pre-commit, heartbeat-loop, status, negotiate, inbox)
//
// One hooks file serves Copilot CLI, VS Code agent mode (Local harness and Copilot sessions on
// the Agent Host both read `.github/hooks/*.json`) and the Copilot cloud agent (which reads it
// from the default branch).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities } from "@weft/protocol";
import { Host, readStdin } from "../../claude-code/src/host";
import { ADAPTER_VERSION, type HookOutput } from "../../claude-code/src/hooks";
import { fromCore, normalize, toCore, type CopilotInput } from "./translate";

const SELF = fileURLToPath(import.meta.url);
export const HOOK_MARK = "weft-copilot";
export const CONFIG_REL = ".weft/copilot.json";
export const HOOKS_REL = ".github/hooks/weft.json";

/**
 * Verified live with Copilot CLI 1.0.102 (demo/evidence/copilot): preToolUse deny with the
 * Weft diagnostic as `permissionDecisionReason` (L2), postToolUse `additionalContext` (L1),
 * agentStop `decision:"block"` (L3; the CLI caps forced continuations at 8, the core at 5),
 * `git commit` denied through the bash tool (commit gate). VS Code and the cloud agent: see
 * the README "Verification status".
 */
export const CAPABILITIES: Capabilities = {
  level: 3,
  observe: "sync",
  inject: "immediate",
  deny_edit: true,
  refuse_stop: true,
  commit_gate: "tool_interception",
};

/** Events we register, in Copilot's native camelCase (VS Code's Local parser maps them). */
export const EVENTS = ["sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "sessionEnd"] as const;

type HookDef = { type?: string; bash?: string; command?: string; powershell?: string; timeoutSec?: number; [k: string]: unknown };
type HooksFile = { version: number; hooks: Record<string, HookDef[]>; [k: string]: unknown };

const isOurs = (h: HookDef) => [h.bash, h.command, h.powershell].some((c) => typeof c === "string" && c.includes(HOOK_MARK));

/** Merge Weft hooks into a Copilot hooks file object, replacing previous Weft entries. */
export function mergeHooks(file: Partial<HooksFile>, hookCommand: string): HooksFile {
  const hooks: Record<string, HookDef[]> = { ...(file.hooks ?? {}) };
  for (const event of EVENTS) {
    const command = `${hookCommand} ${event} # ${HOOK_MARK}`;
    const def: HookDef = { type: "command", bash: command, command, timeoutSec: event === "sessionEnd" ? 10 : 30 };
    hooks[event] = [...(hooks[event] ?? []).filter((h) => !isOurs(h)), def];
  }
  return { ...file, version: file.version ?? 1, hooks };
}

export const host = new Host({
  name: "copilot",
  bin: "weft-adapter-copilot",
  configRel: CONFIG_REL,
  harness: "copilot",
  adapter: `@weft/adapter-copilot@${ADAPTER_VERSION}`,
  capabilities: CAPABILITIES,
  self: SELF,
  // The hook command holds absolute machine paths: keep it out of commits (the cloud agent
  // needs a portable file on the default branch instead; see README).
  excludes: [HOOKS_REL],
  installHarness: (root, hookCommand) => {
    const p = join(root, HOOKS_REL);
    mkdirSync(dirname(p), { recursive: true });
    const prev = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Partial<HooksFile>) : {};
    writeFileSync(p, JSON.stringify(mergeHooks(prev, hookCommand), null, 2) + "\n");
    const lines = [`hooks: ${p} (Copilot CLI, VS Code agent mode; headless CLI runs need a trusted folder: --trust-folder)`];
    const claude = join(root, ".claude", "settings.json");
    if (existsSync(claude) && readFileSync(claude, "utf8").includes("weft-claude"))
      lines.push(`NOTE: ${claude} also has Weft (Claude Code) hooks; Copilot CLI documents reading it. Use one adapter per checkout.`);
    return lines;
  },
});

async function hook(args: string[]): Promise<void> {
  let json: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readStdin()) as CopilotInput;
    const n = normalize(raw, args[0]);
    const loaded = n.session ? host.load(n.cwd) : undefined;
    if (loaded && n.event) {
      const inputs = toCore(n);
      const outs: HookOutput[] = [];
      for (const input of inputs) outs.push(await host.run(loaded, input, { copilot_event: n.native, copilot_dialect: n.dialect, copilot_tool: n.tool }));
      const canInject = ["PostToolUse", "PostToolUseFailure", "SessionStart", "Stop"].includes(n.event);
      const carried = canInject ? host.takeCarry(loaded.root, n.session!) : "";
      const r = fromCore(n, outs, carried);
      if (r.carry) host.addCarry(loaded.root, n.session!, r.carry);
      json = r.json;
    }
  } catch {
    json = {}; // fail open (a non-zero exit would DENY a preToolUse: Copilot fails closed)
  }
  process.stdout.write(JSON.stringify(json));
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === SELF || /weft-adapter-copilot(\.mjs)?$/.test(entry)) {
  host.main(process.argv.slice(2), hook).catch((err) => {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
