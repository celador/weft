// `.weft/bin/weft negotiate | claim | inbox` acts as the agent this checkout's config names (its
// token is that agent's). In a checkout where adapters were installed for different agents, the
// `current` marker may name another agent's session: the command must never act in it (#18).
import { afterAll, describe, expect, it } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { cliSession, stateDir, type Loaded } from "../src/config";
import { ClaudeAdapter } from "../src/hooks";
import { checkout, refTransport, serve } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-claude.mjs");
const X = "src/pricing.ts#calcTotal";
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/** A state file as the Codex adapter writes it, for agent `codex-b`, made the checkout's `current`. */
function codexState(root: string, id = "codex-1", wcpSession = "s-codex"): void {
  mkdirSync(stateDir(root), { recursive: true });
  writeFileSync(join(stateDir(root), `${id}.json`), JSON.stringify({ codexSession: id, wcpSession, agent: "codex-b", change: "I-codex-b", base: 1, acked: 0, pending: {}, lastContact: 1 }));
  writeFileSync(join(stateDir(root), "current"), id);
}

describe("the session the agent's own command acts in (#18)", () => {
  it("hello tags the state with the agent and change, and the command keeps to this agent's own session", async () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const root = checkout("cli-session-own");
    const loaded: Loaded = { root, token: "t", config: { url: "http://unused", repo: "demo", agent: "claude-a", task: { id: "T-1" }, change: "I-claude-a" } };
    let t = 1_790_000_000_000;
    const a = new ClaudeAdapter(loaded, { transport: refTransport(c), analyze: (ch, r, p) => analyzeChanges(ch, r, p), diff: (rel, b, af) => unifiedDiff(rel, b, af), now: () => (t += 1000) });
    expect((await a.claim("claude-1", { keys: [X], firm: false })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(stateDir(root), "claude-1.json"), "utf8"))).toMatchObject({ agent: "claude-a", change: "I-claude-a" });
    // Codex (another agent) becomes the newest session in the checkout.
    codexState(root);
    expect(cliSession(root, "claude-a", "I-claude-a")).toEqual({ session: "claude-1" });
    // The claim made through it lands on claude-a's change, not codex-b's.
    const pick = cliSession(root, "claude-a", "I-claude-a") as { session: string };
    expect((await a.claim(pick.session, { keys: ["src/cart.ts#cartSummary"], firm: false })).code).toBe(0);
    expect(c.log.filter((r) => r.kind === "claim").map((r) => r.change)).toEqual(["I-claude-a", "I-claude-a"]);
  });

  it("refuses when the only session in the checkout is another agent's; --session new opens one of its own", () => {
    const root = checkout("cli-session-refuse");
    codexState(root);
    expect(cliSession(root, "claude-a", "I-claude-a")).toEqual({ refused: expect.stringContaining("(codex-1) is codex-b's, not claude-a's") });
    expect(cliSession(root, "claude-a", "I-claude-a", "new")).toEqual({ session: "cli-claude-a" });
    expect(cliSession(root, "claude-a", "I-claude-a", "codex-1")).toEqual({ refused: "weft: session codex-1 belongs to codex-b, not claude-a; nothing was sent." });
  });

  it("the bundled `weft claim` refuses another agent's session and sends nothing; --session new claims as itself", async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const coord = new ReferenceCoordinator({ repo: "demo" });
    const { url, server } = await serve(coord);
    servers.push(server);
    const root = checkout("cli-session-e2e");
    const env = { ...process.env, WEFT_TOKEN: "local-test-token" };
    execFileSync(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", "claude-b", "--task", "T-2"], { cwd: root, env, encoding: "utf8" });
    codexState(root);
    const weft = join(root, ".weft/bin/weft");
    const sh = promisify(execFile);
    const run = async (args: string[]) => {
      try {
        const r = await sh(weft, args, { cwd: root });
        return { code: 0, stdout: r.stdout, stderr: r.stderr };
      } catch (err) {
        const e = err as { code: number; stdout?: string; stderr?: string };
        return { code: e.code, stdout: String(e.stdout), stderr: String(e.stderr) };
      }
    };
    const refused = await run(["claim", "--keys", X]);
    expect(refused).toMatchObject({ code: 2, stderr: expect.stringContaining("is codex-b's, not claude-b's") });
    expect(refused.stderr).toContain("--session new");
    for (const cmd of [["inbox"], ["negotiate", "propose", "share", "split it", "--to", "codex-b", "--keys", X]]) expect((await run(cmd)).code).toBe(2);
    expect(coord.log.filter((r) => r.agent === "claude-b")).toEqual([]);
    const ok = await run(["claim", "--keys", X, "--session", "new"]);
    expect(ok).toMatchObject({ code: 0, stdout: expect.stringContaining("claude-b claimed calcTotal") });
    expect(coord.log.filter((r) => r.kind === "claim")).toMatchObject([{ agent: "claude-b", change: expect.not.stringContaining("codex") }]);
    // Its own session now exists: without --session the command uses it, though Codex is still `current`.
    writeFileSync(join(stateDir(root), "current"), "codex-1");
    expect((await run(["inbox"])).code).toBe(0);
  }, 30_000);
});
