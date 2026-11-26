// `weft-adapter-opencode` CLI (bundled to dist/weft-opencode.mjs).
//
//   install   .weft/opencode.json (+ token), .opencode/plugin/weft.js, git hooks, agent CLI
//   hook      plugin bridge: one OpenCode plugin message on stdin -> answer JSON on stdout
//   (+ the shared commit-msg, pre-commit, heartbeat-loop, status, negotiate, inbox, claim)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities } from "@weft/protocol";
import { Host, readStdin } from "../../claude-code/src/host";
import { ADAPTER_VERSION } from "../../claude-code/src/hooks";
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
  installHarness: (root) => {
    const p = join(root, PLUGIN_REL);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, pluginSource(stableNodePath(), SELF, HOOK_MARK));
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

async function hook(): Promise<void> {
  let answer: OpenCodeAnswer = {};
  try {
    const msg = JSON.parse(await readStdin()) as OpenCodeMsg;
    const loaded = host.load(msg.directory ?? process.cwd());
    if (loaded && msg.sessionID) {
      const root = loaded.root;
      // apply_patch has no pre-edit check, but its exact before-text is stashed so the
      // post-edit commit diffs against it rather than against git HEAD.
      if (msg.kind === "before" && /^(apply_patch|patch)$/i.test(msg.tool ?? "")) {
        const a = obj(msg.args);
        const files = patchFiles(str(a.patchText) ?? str(a.patch) ?? str(a.input) ?? "");
        for (const [i, f] of files.entries()) {
          const abs = isAbsolute(f) ? f : resolve(msg.directory ?? root, f);
          const rel = relative(root, abs);
          if (!rel.startsWith("..")) await host.seedBefore(root, msg.sessionID, `${msg.callID ?? "patch"}#${i}`, "Write", { [rel]: readMaybe(abs) });
        }
      }
      const outs = [];
      for (const input of toCore(msg)) outs.push(await host.run(loaded, input, { opencode_event: msg.kind }));
      const carried = msg.kind === "after" || msg.kind === "idle" ? host.takeCarry(root, msg.sessionID) : "";
      const r = fromCore(msg.kind, outs, carried);
      if (r.carry) host.addCarry(root, msg.sessionID, r.carry);
      answer = r.answer;
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
