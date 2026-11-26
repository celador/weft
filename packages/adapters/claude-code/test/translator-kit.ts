// Shared e2e kit for the harness translators (Cursor, OpenCode, Gemini, watcher): a local
// HTTP coordinator, a second agent that changes calcTotal's signature, and a runner that
// pipes one fixture payload through a real adapter bundle (`node dist/<bundle>.mjs hook`).
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReferenceCoordinator } from "@weft/protocol";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { PRICING_V1, PRICING_V2, checkout, serve } from "./helpers";

export { CART_V1, PRICING_V1, PRICING_V2, checkout } from "./helpers";

export const OLD_CALL = "return `total ${calcTotal(items)}`;";
export const NEW_CALL = "return `total ${calcTotal(items, { taxRate: 0 })}`;";
export const CART_LINE = "return `${items.length} items`;";

export async function coordinator() {
  const coord = new ReferenceCoordinator({ repo: "demo" });
  const { url, server } = await serve(coord);
  /** claude-a changes calcTotal's signature directly on the coordinator; returns its seq. */
  const changeSignature = (): number => {
    const other = coord.hello({
      type: "hello",
      protocol: "wcp/0.1",
      agent: { id: "claude-a", harness: "claude-code" },
      capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" },
      task: { id: "T-1" },
    });
    const sets = analyzeChanges([{ rel: "src/pricing.ts", before: PRICING_V1, after: PRICING_V2 }]);
    const v = coord.submit(other.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: other.delivered_through, files: ["src/pricing.ts"], reads: sets.reads, writes: sets.writes, diff: unifiedDiff("src/pricing.ts", PRICING_V1, PRICING_V2) } });
    return v.seq!;
  };
  return { coord, url, server, changeSignature };
}

/** Install an adapter bundle into a fresh checkout. Returns the checkout and install output. */
export function installed(bundle: string, name: string, url: string, agent: string, extra: string[] = []): { root: string; out: string } {
  const root = checkout(name);
  const out = execFileSync(process.execPath, [bundle, "install", "--url", url, "--repo", "demo", "--agent", agent, "--task", "T-2", "--title", "cart total", ...extra], {
    cwd: root,
    env: { ...process.env, WEFT_TOKEN: "local-test-token" },
    encoding: "utf8",
  });
  return { root, out };
}

/** Run `node <bundle> <args…>` with `input` on stdin (async: the coordinator lives in this process). */
export function runBundle(bundle: string, cwd: string, input: unknown, args: string[] = ["hook"]): Promise<string> {
  return new Promise<string>((res, rej) => {
    const child = execFile(process.execPath, [bundle, ...args], { cwd, encoding: "utf8", env: { ...process.env, WEFT_TOKEN: "" } }, (err, stdout) => (err ? rej(err) : res(stdout)));
    child.stdin!.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

export async function gitCommit(root: string, msg: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((res) => {
    execFile("git", ["-C", root, "commit", "-qam", msg], { encoding: "utf8" }, (err, _o, stderr) => res({ ok: !err, stderr: String(stderr) }));
  });
}

export const gitLog = (root: string) => execFileSync("git", ["-C", root, "log", "-1", "--format=%B"], { encoding: "utf8" });

/** `hook --by-path` arguments pinned to the kit's coordinator (issue #11: `install --by-path` writes these). */
export const byPathArgs = (url: string, repo = "demo"): string[] => ["hook", "--by-path", "--url", url, "--repo", repo, "--mode", "enforce"];

/** Agents that said hello to the coordinator, in order. */
export const joinedAgents = (coord: ReferenceCoordinator): string[] => coord.log.filter((r) => r.kind === "join").map((r) => r.actor.id);

/** `<root>/.weft/log/adapter.log`, or "" when absent. */
export function adapterLog(root: string): string {
  try {
    return readFileSync(join(root, ".weft", "log", "adapter.log"), "utf8");
  } catch {
    return "";
  }
}
