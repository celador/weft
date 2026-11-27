// `weft-adapter-opencode` CLI (bundled to dist/weft-opencode.mjs).
//
//   install   .weft/opencode.json (+ token), .opencode/plugin/weft.js, git hooks, agent CLI
//   hook      plugin bridge: one OpenCode plugin message on stdin -> answer JSON on stdout
//             (`hook --by-path --url U --repo R`, from `install --by-path`: a tool call on a file
//             inside another joined checkout, e.g. a child session's worktree, acts as that checkout's agent)
//   (+ the shared commit-msg, pre-commit, heartbeat-loop, status, negotiate, inbox, claim)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities } from "@weft/protocol";
import { Host, readStdin } from "../../claude-code/src/host";
import { ADAPTER_VERSION, type HookInput } from "../../claude-code/src/hooks";
import { obj, str } from "../../claude-code/src/tools";
import { stableNodePath } from "../../claude-code/src/node-path";
import { pluginSource } from "./plugin";
import { fromCore, patchFiles, toCore, type OpenCodeAnswer, type OpenCodeMsg } from "./translate";

const SELF = fileURLToPath(import.meta.url);
export const HOOK_MARK = "weft-opencode";
export const CONFIG_REL = ".weft/opencode.json";
export const PLUGIN_REL = ".opencode/plugin/weft.js";

/**
 * Verified live on OpenCode 1.18.31 (docs/research/hooks.md, "OpenCode"): a throw in
 * tool.execute.before blocks the tool and the model reads the error (L2); text appended to
 * the tool output in tool.execute.after reaches the model (L1); session.idle +
 * client.session.prompt starts another turn (L3). `git commit` through the bash tool is
 * intercepted like any other tool call.
 */
export const CAPABILITIES: Capabilities = {
  level: 3,
  observe: "sync",
  inject: "immediate",
  deny_edit: true,
  refuse_stop: true,
  commit_gate: "tool_interception",
};

export const host = new Host({
  name: "opencode",
  bin: "weft-adapter-opencode",
  configRel: CONFIG_REL,
  harness: "opencode",
  adapter: `@weft/adapter-opencode@${ADAPTER_VERSION}`,
  capabilities: CAPABILITIES,
  self: SELF,
  excludes: [PLUGIN_REL],
  installHarness: (root, _hookCommand, _args, hookArgs) => {
    const p = join(root, PLUGIN_REL);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, pluginSource(stableNodePath(), SELF, HOOK_MARK, hookArgs));
    return [`plugin: ${p}`];
  },
});

function readMaybe(abs: string): string | null {
  try {
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

async function hook(args: string[] = []): Promise<void> {
  let answer: OpenCodeAnswer = {};
  try {
    const msg = JSON.parse(await readStdin()) as OpenCodeMsg;
    const dir = msg.directory ?? process.cwd();
    // Plain: every call acts in the session's checkout. `--by-path` (install --by-path): each tool
    // call acts in its file's own joined checkout (a child session editing its worktree), see Host.load.
    const loadFor = (input?: HookInput) => host.load(dir, { args, input });
    if (msg.sessionID) {
      // apply_patch has no pre-edit check, but its exact before-text is stashed so the
      // post-edit commit diffs against it rather than against git HEAD.
      if (msg.kind === "before" && /^(apply_patch|patch)$/i.test(msg.tool ?? "")) {
        const a = obj(msg.args);
        const files = patchFiles(str(a.patchText) ?? str(a.patch) ?? str(a.input) ?? "");
        for (const [i, f] of files.entries()) {
          const loaded = loadFor({ hook_event_name: "PreToolUse", session_id: msg.sessionID, cwd: dir, tool_name: "Write", tool_input: { file_path: f } });
          if (!loaded) continue;
          const abs = isAbsolute(f) ? f : resolve(msg.directory ?? loaded.root, f);
          const rel = relative(loaded.root, abs);
          if (!rel.startsWith("..")) await host.seedBefore(loaded.root, msg.sessionID, `${msg.callID ?? "patch"}#${i}`, "Write", { [rel]: readMaybe(abs) });
        }
      }
      const outs = [];
      const roots: string[] = [];
      for (const input of toCore(msg)) {
        const loaded = loadFor(input);
        if (!loaded) continue;
        if (!roots.includes(loaded.root)) roots.push(loaded.root);
        outs.push(await host.run(loaded, input, { opencode_event: msg.kind }));
      }
      if (roots.length) {
        // Context the plugin could not deliver earlier is kept per checkout; this answer delivers it from each one involved.
        const carried = msg.kind === "after" || msg.kind === "idle" ? roots.map((r) => host.takeCarry(r, msg.sessionID)).filter(Boolean).join("\n") : "";
        const r = fromCore(msg.kind, outs, carried);
        if (r.carry) host.addCarry(roots[0]!, msg.sessionID, r.carry);
        answer = r.answer;
      }
    }
  } catch {
    answer = {}; // fail open
  }
  process.stdout.write(JSON.stringify(answer));
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === SELF || /weft-adapter-opencode(\.mjs)?$/.test(entry)) {
  host.main(process.argv.slice(2), hook).catch((err) => {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
