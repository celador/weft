// `weft claim` from Codex's shell (spec §7.5): grammar checks before anything is sent, ttl
// bounded by the repo policy from the welcome, firm claims refusing others' edits.
// Mirrors packages/adapters/claude-code/test/claim-cli.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { ReferenceCoordinator, validate, type Hello } from "@weft/protocol";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { CodexAdapter } from "../src/hooks";
import { readState, writeState, type Loaded } from "../src/config";
import type { Transport } from "../src/client";
import { checkout, refTransport, serve } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-codex.mjs");
const X = "src/pricing.ts#calcTotal";
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

function adapter(root: string, c: ReferenceCoordinator, agent = "codex-a", transport: Transport = refTransport(c)): CodexAdapter {
  const loaded: Loaded = { root, token: "t", config: { url: "http://unused", repo: "demo", agent, task: { id: "T-1" }, change: `I-${agent}` } };
  let t = 1_790_000_000_000;
  return new CodexAdapter(loaded, { transport, analyze: (ch, r, p) => analyzeChanges(ch, r, p), diff: (rel, b, a) => unifiedDiff(rel, b, a), now: () => (t += 1000) });
}

const other = (c: ReferenceCoordinator) => {
  const h: Hello = {
    type: "hello",
    protocol: "wcp/0.1",
    agent: { id: "claude-b", harness: "claude-code" },
    capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" },
    task: { id: "T-2" },
  };
  return c.hello(h);
};

const editBy = (c: ReferenceCoordinator, b: ReturnType<typeof other>) =>
  c.submit(b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, writes: [{ key: X, kind: "body" }] } });

describe("weft claim (Codex adapter)", () => {
  it("a firm claim is recorded and refuses another agent's overlapping edit", async () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const r = await adapter(checkout("claim-firm"), c).claim("s", { keys: [X], firm: true, ttl_ms: 60_000 });
    expect(r.code).toBe(0);
    expect(r.text).toContain("codex-a firmly claimed calcTotal");
    expect(r.text).toContain("held until 60s after #2");
    expect(c.log.at(-1)).toMatchObject({ kind: "claim", status: "accepted", agent: "codex-a", writes: [{ key: X }], payload: { firm: true, source: "explicit", ttl_ms: 60_000 } });
    expect(editBy(c, other(c))).toMatchObject({ verdict: "reject", diagnostics: [{ code: "claim_wait", severity: "error" }] });
  });

  it("a soft claim is a lease and only warns another agent's overlapping edit", async () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const r = await adapter(checkout("claim-soft"), c).claim("s", { keys: [X], firm: false });
    expect(r).toMatchObject({ code: 0 });
    expect(r.text).toContain("a 120s lease, renewed while you keep working");
    expect(c.log.at(-1)).toMatchObject({ kind: "claim", status: "accepted", payload: { firm: false, source: "explicit" } });
    expect(c.log.at(-1)!.payload).not.toHaveProperty("ttl_ms");
    expect(editBy(c, other(c))).toMatchObject({ verdict: "accept", diagnostics: [{ code: "claim_wait", severity: "warning" }] });
  });

  it("the claim submissions it builds (firm and soft) validate against the WCP schema", async () => {
    const c = new ReferenceCoordinator({ repo: "demo" });
    const sent: unknown[] = [];
    const base = refTransport(c);
    const a = adapter(checkout("claim-schema"), c, "codex-a", { ...base, submit: (s, m) => (sent.push(m), base.submit(s, m)) });
    expect((await a.claim("s", { keys: [X], firm: true, ttl_ms: 60_000 })).code).toBe(0);
    expect((await a.claim("s", { keys: ["src/pricing.ts#*"], firm: false })).code).toBe(0);
    expect(sent).toMatchObject([
      { type: "submit", mode: "commit", event: { kind: "claim", payload: { firm: true, source: "explicit", ttl_ms: 60_000 } } },
      { type: "submit", mode: "commit", event: { kind: "claim", payload: { firm: false, source: "explicit" } } },
    ]);
    for (const m of sent) expect(validate("Submit", m)).toEqual({ ok: true, value: m });
  });

  it("refuses a ttl above the repo's firm limit without sending anything", async () => {
    const c = new ReferenceCoordinator({ repo: "demo", claims: { lease_ms: 120_000, firm_max_ms: 300_000 } });
    const r = await adapter(checkout("claim-ttl"), c).claim("s", { keys: [X], firm: true, ttl_ms: 300_001 });
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

  it("session state without claim limits (older adapter) re-reads them by resuming, not a new session", async () => {
    const c = new ReferenceCoordinator({ repo: "demo", claims: { lease_ms: 120_000, firm_max_ms: 300_000 } });
    const root = checkout("claim-resume");
    const a = adapter(root, c);
    expect((await a.claim("s", { keys: [X], firm: false })).code).toBe(0);
    const st = readState(root, "s");
    const session = st.wcpSession;
    delete st.claimLimits;
    writeState(root, st);
    const r = await a.claim("s", { keys: [X], firm: true, ttl_ms: 300_001 });
    expect(r).toMatchObject({ code: 2, text: expect.stringContaining("(300000 ms)") });
    expect(readState(root, "s")).toMatchObject({ wcpSession: session, claimLimits: { claims: { firm_max_ms: 300_000 } } });
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
    execFileSync(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", "codex-b", "--task", "T-3"], { cwd: root, env, encoding: "utf8" });
    const weft = join(root, ".weft/bin/weft");
    const sh = promisify(execFile);
    const fail = async (args: string[]) => {
      try {
        const r = await sh(weft, args, { cwd: root });
        return { code: 0, stdout: r.stdout, stderr: r.stderr };
      } catch (err) {
        const e = err as { code: number; stdout?: string; stderr?: string };
        return { code: e.code, stdout: String(e.stdout), stderr: String(e.stderr) };
      }
    };
    expect(await fail(["claim"])).toMatchObject({ code: 2, stdout: expect.stringContaining("weft claim --keys path#symbol") });
    expect(await fail(["claim", "--keys", "../outside.ts#f"])).toMatchObject({ code: 2, stderr: expect.stringContaining("'..' is not allowed") });
    expect(await fail(["claim", "--keys", "/etc/passwd#root"])).toMatchObject({ code: 2, stderr: expect.stringContaining("not absolute") });
    expect(await fail(["claim", "--keys", X, "--ttl", "1000"])).toMatchObject({ code: 2, stderr: expect.stringContaining("firm claims only") });
    expect(await fail(["claim", "--keys", X, "--firm", "--ttl", "700000"])).toMatchObject({ code: 2, stderr: expect.stringContaining("exceeds this repo's limit") });
    expect(coord.log.filter((r) => r.kind === "claim")).toEqual([]);
    const ok = await sh(weft, ["claim", "--keys", X, "--firm", "--ttl", "600000"], { cwd: root });
    expect(ok.stdout).toContain("codex-b firmly claimed calcTotal");
    expect(coord.log.filter((r) => r.kind === "claim")).toMatchObject([{ agent: "codex-b", payload: { firm: true, ttl_ms: 600_000 } }]);
    // Another agent's overlapping edit is now refused.
    expect(editBy(coord, other(coord))).toMatchObject({ verdict: "reject", diagnostics: [{ code: "claim_wait", severity: "error" }] });
  }, 30_000);
});
