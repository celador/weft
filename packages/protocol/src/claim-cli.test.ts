import { describe, expect, it } from "vitest";
import { claimKeyError, maxClaimTtl, parseClaim } from "./claim-cli";

describe("weft claim: grammar and key validation", () => {
  it("parses keys, --firm and --ttl", () => {
    expect(parseClaim(["--keys", "src/auth/session.ts#SessionStore.get, src/api/client.ts#fetchWithAuth"])).toEqual({
      keys: ["src/auth/session.ts#SessionStore.get", "src/api/client.ts#fetchWithAuth"],
      firm: false,
    });
    expect(parseClaim(["--firm", "--keys", "src/a.ts#f", "--ttl", "60000"])).toEqual({ keys: ["src/a.ts#f"], firm: true, ttl_ms: 60000 });
    expect(parseClaim(["--keys", "docs/readme.md#*,src/a.ts#f,src/a.ts#f"]).keys).toEqual(["docs/readme.md#*", "src/a.ts#f"]);
    expect(parseClaim(["--keys", "src/ü.ts#größe.$x_1"]).keys).toEqual(["src/ü.ts#größe.$x_1"]);
  });

  it.each([
    ["/etc/passwd#x", /absolute/],
    ["~/x.ts#f", /absolute/],
    ["C:/x.ts#f", /absolute/],
    ["../secret.ts#f", /'\.\.'/],
    ["src/../../x.ts#f", /'\.\.'/],
    ["./src/a.ts#f", /'\.'/],
    ["src//a.ts#f", /empty path segment/],
    ["src\\a.ts#f", /separators/],
    ["src/a.ts", /exactly one #/],
    ["#f", /exactly one #/],
    ["src/a.ts#", /exactly one #/],
    ["src/a.ts#f#g", /exactly one #/],
    ["src/a b.ts#f", /whitespace/],
    ["src/a.ts#f()", /dotted declaration name/],
    ["src/a.ts#a..b", /dotted declaration name/],
    ["src/a.ts#1abc", /dotted declaration name/],
    ["src/a\u0000.ts#f", /control character/],
    [`${"a/".repeat(600)}x.ts#f`, /longer than/],
  ])("refuses %j", (key, why) => {
    expect(claimKeyError(key)).toMatch(why);
    expect(() => parseClaim(["--keys", key])).toThrow(/invalid key/);
  });

  it("refuses bad flags and ttl values", () => {
    expect(() => parseClaim([])).toThrow(/--keys is required/);
    expect(() => parseClaim(["--keys"])).toThrow(/--keys is required/);
    expect(() => parseClaim(["--keys", "--firm"])).toThrow(/--keys is required/);
    expect(() => parseClaim(["--keys", " , "])).toThrow(/empty/);
    expect(() => parseClaim(["--keys", "src/a.ts#f", "--ttl", "1000"])).toThrow(/firm claims only/);
    expect(() => parseClaim(["--keys", "src/a.ts#f", "--firm", "--ttl", "1e3"])).toThrow(/whole number/);
    expect(() => parseClaim(["--keys", "src/a.ts#f", "--firm", "--ttl", "0"])).toThrow(/at least 1/);
    expect(() => parseClaim(["--keys", "src/a.ts#f", "--force"])).toThrow(/unexpected argument/);
    expect(() => parseClaim(["src/a.ts#f"])).toThrow(/unexpected argument/);
  });

  it("bounds --ttl by the repo policy the coordinator announced", () => {
    expect(maxClaimTtl({ claim_ttl_ms: 120_000, policy: { claims: { lease_ms: 120_000, firm_max_ms: 600_000 } } })).toBe(600_000);
    expect(maxClaimTtl({ claim_ttl_ms: 1_800_000, policy: {} })).toBe(1_800_000);
  });
});
