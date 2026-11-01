// `weft usage`, `weft upgrade`, `weft billing` against a stand-in gateway: what they print, what they
// send, and that billing being off on a gateway is explained instead of retried.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../src/main";
import { usageLines } from "../src/billing";

type Reply = { status: number; body?: unknown };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("usageLines", () => {
  const u = (o: Partial<{ events: number; allowance: number; plan: "free" | "paid" }> = {}) => ({ month: "2026-11", events: 1234, allowance: 5000, plan: "free" as const, has_billing_account: false, ...o });
  it("free: events against the allowance", () => {
    const t = strip(usageLines("sp1", "https://gw", u(), true).join("\n"));
    expect(t).toContain("1,234 of 5,000 free events (25%)");
    expect(t).toContain("plan    free");
    expect(t).toContain("npx @celador/weft upgrade");
  });
  it("free and over: says agents keep working uncoordinated and how to upgrade", () => {
    const t = strip(usageLines("sp1", "https://gw", u({ events: 5000 }), true).join("\n"));
    expect(t).toContain("free allowance used up");
    expect(t).toContain("uncoordinated");
    expect(t).toContain("npx @celador/weft upgrade");
  });
  it("paid: shows only what is billed above the allowance, and never a per-seat idea", () => {
    const t = strip(usageLines("sp1", "https://gw", u({ plan: "paid", events: 7000 }), true).join("\n"));
    expect(t).toContain("7,000 events (5,000 of 5,000 included, 2,000 billed this month)");
    expect(t).not.toMatch(/seat|per developer|per user/i);
  });
  it("billing off: nothing is limited", () => {
    expect(strip(usageLines("sp1", "http://127.0.0.1:7878", u({ events: 9999 }), false).join("\n"))).toContain("nothing is limited or charged on this gateway");
  });
  it("an older gateway without usage", () => {
    expect(strip(usageLines("sp1", "https://gw", undefined, undefined).join("\n"))).toContain("does not report usage");
  });
});

describe("weft usage / upgrade / billing", () => {
  const seen: Array<{ method: string; path: string; auth: string }> = [];
  let reply: Record<string, Reply> = {};
  let server: Server;
  let url = "";
  const base = mkdtempSync(join(tmpdir(), "weft-cli-billing-"));
  const repo = join(base, "shop");
  const logs: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const key = `${req.method} ${new URL(req.url!, "http://x").pathname}`;
      seen.push({ method: req.method!, path: new URL(req.url!, "http://x").pathname, auth: req.headers.authorization ?? "" });
      const r = reply[key] ?? { status: 404, body: { type: "error", error: { code: "not_found", message: key } } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body === undefined ? "" : JSON.stringify(r.body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.WEFT_HOME = join(base, "config");
    process.env.WEFT_NO_OPEN = "1";
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(base, "config"), { recursive: true });
    // a checkout that is already set up against the stand-in gateway, with the owner key in the CLI state
    mkdirSync(join(repo, ".weft"), { recursive: true });
    writeFileSync(join(repo, ".weft", "space.json"), JSON.stringify({ url, space: "sp0000000001", repo: "sp0000000001-shop", name: "shop" }));
    writeFileSync(join(base, "config", "cli.json"), JSON.stringify({ default: url, gateways: { [url]: { owner: "weft_owner_secret", space: "sp0000000001" } } }));
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    g("add", "a.txt");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });
  afterAll(() => {
    server.close();
    vi.restoreAllMocks();
  });

  it("parses the three commands", () => {
    for (const c of ["usage", "upgrade", "billing"]) expect(parseArgs([c]).cmd).toBe(c);
  });

  it("usage prints events against the allowance, sends the owner key, and prints no key", async () => {
    reply = { "GET /v1/space": { status: 200, body: { space: { id: "sp0000000001", repos: [], tokens: 1 }, usage: { month: "2026-11", events: 321, allowance: 5000, plan: "free", has_billing_account: false }, billing: { enabled: true } } } };
    logs.length = 0;
    expect(await main(["usage", "--dir", repo])).toBe(0);
    const out = strip(logs.join("\n"));
    expect(out).toContain("321 of 5,000 free events");
    expect(out).not.toContain("weft_owner_secret");
    expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/space", auth: "Bearer weft_owner_secret" });
  });

  it("upgrade prints the Checkout URL", async () => {
    reply = { "POST /v1/space/billing/checkout": { status: 201, body: { type: "billing.checkout", url: "https://checkout.stripe.com/c/pay/cs_test_abc" } } };
    logs.length = 0;
    expect(await main(["upgrade", "--dir", repo, "--no-open"])).toBe(0);
    const out = strip(logs.join("\n"));
    expect(out).toContain("https://checkout.stripe.com/c/pay/cs_test_abc");
    expect(out).toContain("no seats");
  });

  it("billing prints the portal URL", async () => {
    reply = { "POST /v1/space/billing/portal": { status: 201, body: { type: "billing.portal", url: "https://billing.stripe.com/p/session/test_1" } } };
    logs.length = 0;
    expect(await main(["billing", "--dir", repo, "--no-open"])).toBe(0);
    expect(logs.join("\n")).toContain("https://billing.stripe.com/p/session/test_1");
  });

  it("on a gateway with billing off, upgrade explains it at once (no retries)", async () => {
    reply = { "POST /v1/space/billing/checkout": { status: 503, body: { type: "error", error: { code: "unavailable", message: "billing is not enabled on this gateway (hosted usage billing is off; self-hosted and local gateways are free)", retryable: true } } } };
    const before = seen.length;
    await expect(main(["upgrade", "--dir", repo, "--no-open"])).rejects.toThrow(/does not sell a plan/);
    expect(seen.length - before).toBe(1);
  });

  it("without a set-up checkout it says what to run", async () => {
    const empty = mkdtempSync(join(tmpdir(), "weft-cli-empty-"));
    execFileSync("git", ["init", "-q", "-b", "main", empty]);
    await expect(main(["usage", "--dir", empty])).rejects.toThrow(/not set up/);
  });
});
