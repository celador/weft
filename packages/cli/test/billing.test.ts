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
import { login } from "../src/login";
import { readFileSync } from "node:fs";

type Reply = { status: number; body?: unknown };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("usageLines", () => {
  const u = (o: Partial<{ events: number; allowance: number; plan: "free" | "paid" }> = {}) => ({ month: "2026-11", events: 1234, allowance: 5000, plan: "free" as const, has_billing_account: false, ...o });
  it("free: events against the allowance", () => {
    const t = strip(usageLines("sp1", "https://gw", u(), true).join("\n"));
    expect(t).toContain("1,234 of 5,000 free events (25%)");
    expect(t).toContain("plan    free");
    expect(t).toContain("npx @celador/weft upgrade (Weft Pro)");
  });
  it("free and over: says agents keep working uncoordinated and how to upgrade", () => {
    const t = strip(usageLines("sp1", "https://gw", u({ events: 5000 }), true).join("\n"));
    expect(t).toContain("free allowance used up");
    expect(t).toContain("uncoordinated");
    expect(t).toContain("npx @celador/weft upgrade");
  });
  it("Pro: plan with seats and interval, events with no cut-off", () => {
    const t = strip(usageLines("sp1", "https://gw", { ...u({ plan: "paid", events: 7000 }), seats: 2, interval: "year", fair_use_events: 100000, over_fair_use: false }, true).join("\n"));
    expect(t).toContain("plan    Weft Pro, 2 seats (billed yearly");
    expect(t).toContain("7,000 events (no event cut-off on Pro)");
    expect(t).not.toContain("fair use");
    expect(t).not.toMatch(/\$1|per 1,000|never per seat/);
  });
  it("Pro above fair use: says nothing is cut off", () => {
    const t = strip(usageLines("sp1", "https://gw", { ...u({ plan: "paid", events: 120000 }), seats: 2, interval: "month", fair_use_events: 100000, over_fair_use: true }, true).join("\n"));
    expect(t).toContain("above fair use this month (100,000 = 2 x 50,000 events): nothing is cut off");
  });
  it("a subscription from the earlier usage-based plan still shows its billed overage", () => {
    const t = strip(usageLines("sp1", "https://gw", u({ plan: "paid", events: 7000 }), true).join("\n"));
    expect(t).toContain("7,000 events (5,000 of 5,000 included, 2,000 billed this month)");
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
  let bodyLog: unknown[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (raw) bodyLog.push(JSON.parse(raw));
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

  it("parses the three commands and the Pro flags", () => {
    for (const c of ["usage", "upgrade", "billing"]) expect(parseArgs([c]).cmd).toBe(c);
    expect(parseArgs(["upgrade", "--seats", "3", "--year"]).o).toMatchObject({ seats: 3, year: true });
    expect(parseArgs(["upgrade"]).o).toMatchObject({ year: false });
    expect(parseArgs(["upgrade"]).o.seats).toBeUndefined();
    for (const bad of ["0", "1000", "2.5", "x"]) expect(() => parseArgs(["upgrade", "--seats", bad])).toThrow(/--seats/);
    for (const c of ["login", "logout", "whoami"]) expect(parseArgs([c]).cmd).toBe(c);
    // the anonymous web purchase is gone: no claim codes
    expect(() => parseArgs(["--claim", "ABCD-EFGH-JKMN"])).toThrow(/unknown option --claim/);
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

  it("upgrade asks for Weft Pro with the seats and interval, and prints the Checkout URL", async () => {
    const bodies: unknown[] = [];
    reply = { "POST /v1/space/billing/checkout": { status: 201, body: { type: "billing.checkout", url: "https://checkout.stripe.com/c/pay/cs_test_abc" } } };
    logs.length = 0;
    bodyLog = bodies;
    expect(await main(["upgrade", "--dir", repo, "--no-open", "--seats", "3", "--year"])).toBe(0);
    const out = strip(logs.join("\n"));
    expect(out).toContain("https://checkout.stripe.com/c/pay/cs_test_abc");
    expect(out).toContain("Weft Pro for 3 seats, billed yearly");
    expect(out).not.toMatch(/no seats|per 1,000|usage-based/);
    expect(bodies.at(-1)).toEqual({ seats: 3, interval: "year" });
    expect(await main(["upgrade", "--dir", repo, "--no-open"])).toBe(0);
    expect(bodies.at(-1)).toEqual({ seats: 1, interval: "month" });
  });

  it("login: prints the confirm URL and code, polls with this repo's owner key (the space joins the account), prints no key", async () => {
    const bodies: unknown[] = [];
    bodyLog = bodies;
    let polls = 0;
    reply = {
      "POST /v1/login": { status: 201, body: { type: "login", device_code: "weft_login_devicesecret0123456789abcdef", user_code: "ABCD-EFGH", verification_url: "https://weft.mx/cli/?code=ABCD-EFGH", expires_in: 600, interval: 3 } },
    };
    Object.defineProperty(reply, "POST /v1/login/poll", { enumerable: true, get: () => (++polls < 2 ? { status: 202, body: { type: "login.pending" } } : { status: 200, body: { type: "login.approved", space: "sp0000000001", attached: true, created: false } }) });
    reply["POST /v1/space/viewers"] = { status: 201, body: { token: "weft_dev_x", device: { id: "dev_1", label: "l", created_at: "", last_seen_at: "", expires_at: "" } } };
    logs.length = 0;
    const r = await login(url, { open: false, root: repo, pollMs: 5 });
    expect(r).toEqual({ space: "sp0000000001", attached: true, created: false });
    const out = strip(logs.join("\n"));
    expect(out).toContain("ABCD-EFGH");
    expect(out).toContain("https://weft.mx/cli/?code=ABCD-EFGH");
    expect(out).not.toContain("weft_login_devicesecret");
    expect(out).not.toContain("weft_owner_secret");
    const pollsSeen = seen.filter((x) => x.path === "/v1/login/poll");
    expect(pollsSeen.length).toBe(2);
    expect(pollsSeen.at(-1)!.auth).toBe("Bearer weft_owner_secret");
    expect(bodies.at(-2)).toMatchObject({ device_code: "weft_login_devicesecret0123456789abcdef" });
    // attached: the owner key stays the same
    expect(JSON.parse(readFileSync(join(base, "config", "cli.json"), "utf8")).gateways[url].owner).toBe("weft_owner_secret");
  });

  it("upgrade on a space with no account signs in first (keeping the space), then opens Checkout for the account", async () => {
    let checkouts = 0;
    reply = {
      "POST /v1/login": { status: 201, body: { type: "login", device_code: "weft_login_devicesecret0123456789abcdef", user_code: "WXYZ-2345", verification_url: "https://weft.mx/cli/?code=WXYZ-2345", expires_in: 600, interval: 3 } },
      "POST /v1/login/poll": { status: 200, body: { type: "login.approved", space: "sp0000000001", attached: true, created: false } },
    };
    Object.defineProperty(reply, "POST /v1/space/billing/checkout", {
      enumerable: true,
      get: () =>
        ++checkouts < 2
          ? { status: 403, body: { type: "error", error: { code: "forbidden", message: "Weft Pro is bought by an account: run `npx @celador/weft login`", details: { reason: "login_required" } } } }
          : { status: 201, body: { type: "billing.checkout", url: "https://checkout.stripe.com/c/pay/cs_test_acc" } },
    });
    logs.length = 0;
    // the poll interval comes from the gateway (3 s): this test waits for one poll
    expect(await main(["upgrade", "--dir", repo, "--no-open", "--seats", "2"])).toBe(0);
    const out = strip(logs.join("\n"));
    expect(out).toContain("WXYZ-2345");
    expect(out).toContain("https://checkout.stripe.com/c/pay/cs_test_acc");
    expect(checkouts).toBe(2);
  }, 15_000);

  it("whoami shows the space and its account; logout revokes this machine's key and forgets it", async () => {
    reply = { "GET /v1/space": { status: 200, body: { space: { id: "sp0000000001", repos: [], tokens: 1 }, usage: { month: "2026-11", events: 1, allowance: 5000, plan: "paid", seats: 2, has_billing_account: true }, account: "user_2abcdEFGH", accounts: true } } };
    logs.length = 0;
    expect(await main(["whoami", "--url", url, "--dir", repo])).toBe(0);
    let out = strip(logs.join("\n"));
    expect(out).toContain("sp0000000001");
    expect(out).toContain("user_2abcdEFGH");
    expect(out).toContain("Weft Pro, 2 seats");
    reply = { "POST /v1/space/logout": { status: 204 } };
    logs.length = 0;
    const tmp = mkdtempSync(join(tmpdir(), "weft-cli-nogit-"));
    expect(await main(["logout", "--url", url, "--dir", tmp])).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/space/logout", auth: "Bearer weft_owner_secret" });
    const st = JSON.parse(readFileSync(join(base, "config", "cli.json"), "utf8")).gateways[url];
    expect(st.owner).toBeUndefined();
    out = strip(logs.join("\n"));
    expect(out).toContain("logged out");
    // restore for the tests below
    writeFileSync(join(base, "config", "cli.json"), JSON.stringify({ default: url, gateways: { [url]: { owner: "weft_owner_secret", space: "sp0000000001" } } }));
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
