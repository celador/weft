// `weft claim` from the agent's shell (spec §7.5): grammar checks before anything is sent,
// ttl bounded by the repo policy from the welcome, firm claims refusing others' edits.
import { afterAll, describe, expect, it } from "vitest";
import { ReferenceCoordinator, type Hello } from "@weft/protocol";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { ClaudeAdapter } from "../src/hooks";
import type { Loaded } from "../src/config";
import { checkout, refTransport, serve } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-claude.mjs");
const X = "src/pricing.ts#calcTotal";
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

function adapter(root: string, c: ReferenceCoordinator, agent = "claude-a"): ClaudeAdapter {
  const loaded: Loaded = { root, token: "t", config: { url: "http://unused", repo: "demo", agent, task: { id: "T-1" }, change: `I-${agent}` } };
  let t = 1_790_000_000_000;
  return new ClaudeAdapter(loaded, { transport: refTransport(c), analyze: (ch, r, p) => analyzeChanges(ch, r, p), diff: (rel, b, a) => unifiedDiff(rel, b, a), now: () => (t += 1000) });
}

const other = (c: ReferenceCoordinator) => {
  const h: Hello = {
    type: "hello",
    protocol: "wcp/0.1",
    agent: { id: "codex-b", harness: "codex" },
    capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" },
    task: { id: "T-2" },
  };
  return c.hello(h);
};

describe("weft claim (adapter)", () => {
  it("a firm claim is recorded and refuses another agent's overlapping edit", async () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const a = adapter(checkout("claim-firm"), c);
    const r = await a.claim("s", { keys: [X], firm: true, ttl_ms: 60_000 });
    expect(r.code).toBe(0);
    expect(r.text).toContain("claude-a firmly claimed calcTotal");
    expect(r.text).toContain("held until 60s after #2");
    expect(c.log.at(-1)).toMatchObject({ kind: "claim", status: "accepted", writes: [{ key: X }], payload: { firm: true, source: "explicit", ttl_ms: 60_000 } });
    const b = other(c);
    const v = c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, writes: [{ key: X, kind: "body" }] } });
    expect(v).toMatchObject({ verdict: "reject", diagnostics: [{ code: "claim_wait", severity: "error" }] });
  });

  it("a soft claim is a lease", async () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const r = await adapter(checkout("claim-soft"), c).claim("s", { keys: [X], firm: false });
    expect(r).toMatchObject({ code: 0 });
    expect(r.text).toContain("a 120s lease, renewed while you keep working");
  });

  it("refuses a ttl above the repo's firm limit without sending anything", async () => {
    const c = new ReferenceCoordinator({ repo: "demo", claims: { lease_ms: 120_000, firm_max_ms: 300_000 } });
    const a = adapter(checkout("claim-ttl"), c);
    const r = await a.claim("s", { keys: [X], firm: true, ttl_ms: 300_001 });
    expect(r).toMatchObject({ code: 2 });
    expect(r.text).toContain("exceeds this repo's limit for firm claims (300000 ms)");
    expect(c.log.filter((x) => x.kind === "claim")).toEqual([]);
  });

  it("on a repo created before the claims policy the bound is the claim TTL", async () => {
    const c = new ReferenceCoordinator({ repo: "demo", claims: null });
    const a = adapter(checkout("claim-legacy"), c);
    expect((await a.claim("s", { keys: [X], firm: true, ttl_ms: 1_800_001 })).code).toBe(2);
    expect((await a.claim("s", { keys: [X], firm: true, ttl_ms: 1_800_000 })).code).toBe(0);
  });

  it("reports a refused claim with exit code 1", async () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const b = other(c);
    c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "claim", base_seq: b.delivered_through, writes: [{ key: X, kind: "body" }], payload: { firm: true, source: "explicit" } } });
    const r = await adapter(checkout("claim-refused"), c).claim("s", { keys: [X], firm: false });
    expect(r.code).toBe(1);
    expect(r.text).toContain("[weft] claim refused");
    expect(r.text).toContain("claim_wait");
  });

  it("the bundled `weft claim` validates keys locally and claims over HTTP", async () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const coord = new ReferenceCoordinator({ repo: "demo" });
    const { url, server } = await serve(coord);
    servers.push(server);
    const root = checkout("claim-cli");
    const env = { ...process.env, WEFT_TOKEN: "local-test-token" };
    execFileSync(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", "claude-b", "--task", "T-2"], { cwd: root, env, encoding: "utf8" });
    const weft = join(root, ".weft/bin/weft");
    const sh = promisify(execFile);
    const fail = async (args: string[]) => {
      try {
        await sh(weft, args, { cwd: root });
        return { code: 0, stderr: "" };
      } catch (err) {
        return { code: (err as { code: number }).code, stderr: String((err as { stderr?: string }).stderr) };
      }
    };
    expect(await fail(["claim", "--keys", "../outside.ts#f"])).toMatchObject({ code: 2, stderr: expect.stringContaining("'..' is not allowed") });
    expect(await fail(["claim", "--keys", "/etc/passwd#root"])).toMatchObject({ code: 2, stderr: expect.stringContaining("not absolute") });
    expect(await fail(["claim", "--keys", X, "--firm", "--ttl", "700000"])).toMatchObject({ code: 2, stderr: expect.stringContaining("exceeds this repo's limit") });
    expect(coord.log.filter((r) => r.kind === "claim")).toEqual([]);
    const ok = await sh(weft, ["claim", "--keys", X, "--firm", "--ttl", "600000"], { cwd: root });
    expect(ok.stdout).toContain("claude-b firmly claimed calcTotal");
    expect(coord.log.filter((r) => r.kind === "claim")).toMatchObject([{ agent: "claude-b", payload: { firm: true, ttl_ms: 600_000 } }]);
  }, 30_000);
});
