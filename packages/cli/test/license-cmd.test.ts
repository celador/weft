// `weft license`: the account's license when signed in, recording a key (checked once with the hosted gateway), and the
// one line setup prints without a license. Against a stand-in gateway; never a real network call, never a key printed.
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../src/main";
import { LICENSE_HINT, licenseHint, licenseLines, licensed, readLocalLicense, type LicenseState } from "../src/license";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const KEY = `weft_lic_${"Ab3_".repeat(8)}`;
const state = (o: Partial<LicenseState> = {}): LicenseState => ({ active: true, included_in_pro: false, seats: 3, lifetime_seats: 3, year_seats: 0, term: "lifetime", valid_until: null, renews: false, ...o });

describe("licenseLines", () => {
  it("says lifetime, yearly with its renewal or end date, Pro, none and ended", () => {
    expect(strip(licenseLines(state()).join("\n"))).toContain("Commercial License, 3 users, lifetime (never renews, never ends)");
    const y = strip(licenseLines(state({ seats: 1, lifetime_seats: 0, year_seats: 1, term: "year", valid_until: "2027-11-17T12:00:00.000Z", renews: true })).join("\n"));
    expect(y).toContain("Commercial License, 1 user, yearly, renews Nov 17, 2027");
    expect(strip(licenseLines(state({ lifetime_seats: 0, year_seats: 2, term: "year", valid_until: "2027-01-02T12:00:00.000Z", renews: false })).join("\n"))).toContain("ends Jan 2, 2027");
    expect(strip(licenseLines(state({ seats: 0, lifetime_seats: 0, term: null, included_in_pro: true })).join("\n"))).toContain("included in Weft Pro");
    expect(strip(licenseLines(null).join("\n"))).toContain("none (free for personal use; at work: a commercial license or Weft Pro, https://weft.mx/pricing/)");
    expect(strip(licenseLines(state({ active: false, lifetime_seats: 0, year_seats: 0, seats: 2, term: null })).join("\n"))).toContain("ended");
  });
  it("a recorded yearly license covers the machine only until its paid-through date", () => {
    const at = (s: LicenseState) => ({ source: "key" as const, checked_at: "", gateway: "", license: s });
    expect(licensed(at(state()))).toBe(true);
    expect(licensed(at(state({ lifetime_seats: 0, year_seats: 1, valid_until: new Date(Date.now() + 86400e3).toISOString() })))).toBe(true);
    expect(licensed(at(state({ lifetime_seats: 0, year_seats: 1, valid_until: new Date(Date.now() - 1000).toISOString() })))).toBe(false);
    expect(licensed(at(state({ active: false })))).toBe(false);
    expect(licensed(undefined)).toBe(false);
  });
});

describe("weft license", () => {
  const seen: Array<{ method: string; path: string; auth: string; body: string }> = [];
  let reply: Record<string, { status: number; body?: unknown }> = {};
  let server: Server;
  let url = "";
  const base = mkdtempSync(join(tmpdir(), "weft-cli-license-"));
  const logs: string[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const path = new URL(req.url!, "http://x").pathname;
      seen.push({ method: req.method!, path, auth: req.headers.authorization ?? "", body: raw });
      const r = reply[`${req.method} ${path}`] ?? { status: 404, body: { type: "error", error: { code: "not_found", message: "that license key is not valid" } } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body === undefined ? "" : JSON.stringify(r.body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });
  beforeEach(() => {
    process.env.WEFT_HOME = mkdtempSync(join(base, "home-"));
    seen.length = 0;
    logs.length = 0;
  });
  afterAll(() => {
    server.close();
    vi.restoreAllMocks();
  });

  it("parses `license` and `license <key>`", () => {
    expect(parseArgs(["license"])).toMatchObject({ cmd: "license", o: { positional: [] } });
    expect(parseArgs(["license", KEY]).o.positional).toEqual([KEY]);
  });

  it("license <key>: checks the key with the gateway once, records it 0600, and never prints it", async () => {
    reply = { "POST /v1/license/verify": { status: 200, body: { type: "license", license: state() } } };
    expect(await main(["license", KEY, "--url", url])).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/license/verify", auth: "" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ key: KEY });
    const out = strip(logs.join("\n"));
    expect(out).toContain("license key recorded on this machine (…Ab3_)");
    expect(out).toContain("3 users, lifetime");
    expect(out).not.toContain(KEY);
    const f = join(process.env.WEFT_HOME!, "license.json");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readLocalLicense()).toMatchObject({ key: KEY, source: "key", license: { seats: 3 } });
    // later: `weft license` (not signed in) shows the recorded license without any network call
    seen.length = 0;
    logs.length = 0;
    expect(await main(["license", "--url", url])).toBe(0);
    expect(seen).toHaveLength(0);
    expect(strip(logs.join("\n"))).toContain("key      …Ab3_");
    // and setup stays quiet about licenses on this machine
    expect(licenseHint(false)).toBeUndefined();
    // the key is replaced on weft.mx (or the account deleted): checking it again says so, and it stops counting here
    reply = {};
    await expect(main(["license", KEY, "--url", url])).rejects.toThrow(/not valid/);
    expect(readLocalLicense()).toMatchObject({ key: KEY, license: null });
    expect(licenseHint(false)).toBe(LICENSE_HINT);
  });

  it("a wrong or replaced key is refused and nothing is recorded; a malformed one never leaves the machine", async () => {
    reply = {};
    await expect(main(["license", KEY, "--url", url])).rejects.toThrow(/not valid/);
    expect(readLocalLicense()).toBeUndefined();
    seen.length = 0;
    await expect(main(["license", "weft_lic_nope", "--url", url])).rejects.toThrow(/not a Weft license key/);
    expect(seen).toHaveLength(0);
  });

  it("signed in: shows the account's license from the owner's GET /v1/space and remembers it for setup", async () => {
    writeFileSync(join(process.env.WEFT_HOME!, "cli.json"), JSON.stringify({ gateways: { [url]: { owner: "weft_owner_secret", space: "sp0000000001" } } }));
    reply = { "GET /v1/space": { status: 200, body: { space: { id: "sp0000000001", repos: [], tokens: 1 }, account: "user_abc12345", accounts: true, license: state({ lifetime_seats: 0, year_seats: 1, seats: 1, term: "year", valid_until: "2027-11-17T12:00:00.000Z", renews: true }) } } };
    expect(await main(["license", "--url", url, "--dir", base])).toBe(0);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/space"]);
    expect(seen[0]!.auth).toBe("Bearer weft_owner_secret");
    const out = strip(logs.join("\n"));
    expect(out).toContain("account  user_abc12345");
    expect(out).toContain("1 user, yearly, renews Nov 17, 2027");
    expect(out).not.toContain("weft_owner_secret");
    expect(readLocalLicense()).toMatchObject({ source: "account", license: { year_seats: 1 } });
    expect(licenseHint(false)).toBeUndefined();
  });

  it("no license, no key, not signed in: says so, and setup's hint is exactly one line", async () => {
    expect(await main(["license", "--url", url, "--dir", base])).toBe(0);
    expect(seen).toHaveLength(0);
    expect(strip(logs.join("\n"))).toContain("license  none");
    expect(licenseHint(false)).toBe(LICENSE_HINT);
    expect(LICENSE_HINT).toBe("Free for personal use. Using Weft at work? weft.mx/pricing");
    expect(LICENSE_HINT).not.toContain("\n");
    expect(licenseHint(true)).toBeUndefined(); // Pro includes the license
  });

  it("help lists the command and the license line", async () => {
    expect(await main(["help"])).toBe(0);
    const out = strip(logs.join("\n"));
    expect(out).toContain("license [KEY]");
    expect(out).toContain("License: free for personal use; at work you need a commercial license or Pro (https://weft.mx/license/). Source: AGPL-3.0-only at https://github.com/celador/weft (builds from source: AGPL only).");
  });
});
