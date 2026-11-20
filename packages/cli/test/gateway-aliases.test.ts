// The Hermes adapter config can name one gateway twice: `url` (this Mac, loopback) and
// `public_url` (other devices, e.g. a tailnet address). The shared human token is saved under
// `public_url or url`, so a client on this Mac asking for `url` must still find it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayAliases, sharedHumanToken } from "../src/gateways";

const LOOP = "http://127.0.0.1:7878";
const PUBLIC = "https://box.tailnet.example:8710";
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function home(adapter: unknown, human: unknown): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), "weft-aliases-"));
  dirs.push(d);
  if (adapter) writeFileSync(join(d, "hermes-adapter.json"), JSON.stringify(adapter));
  if (human) writeFileSync(join(d, "otto-human-token.json"), JSON.stringify(human));
  return { WEFT_HOME: d };
}

describe("gateway aliases", () => {
  it("url finds the human token saved under the same gateway's public_url", () => {
    const env = home({ url: LOOP, public_url: PUBLIC + "/" }, { url: PUBLIC, token: "h1" });
    expect(gatewayAliases(LOOP + "/", env)).toEqual([LOOP, PUBLIC]);
    expect(sharedHumanToken(LOOP, env)).toBe("h1");
    expect(sharedHumanToken(PUBLIC, env)).toBe("h1");
  });

  it("another gateway's token is never returned", () => {
    const env = home({ url: LOOP, public_url: PUBLIC }, { url: PUBLIC, token: "h1" });
    expect(gatewayAliases("https://elsewhere.example", env)).toEqual(["https://elsewhere.example"]);
    expect(sharedHumanToken("https://elsewhere.example", env)).toBeUndefined();
    // public_url is only an alias of the config's own url
    const other = home({ url: "http://127.0.0.1:9999", public_url: PUBLIC }, { url: PUBLIC, token: "h1" });
    expect(sharedHumanToken(LOOP, other)).toBeUndefined();
  });

  it("without public_url the token is keyed on url", () => {
    const env = home({ url: LOOP }, { url: LOOP, token: "h2" });
    expect(gatewayAliases(LOOP, env)).toEqual([LOOP]);
    expect(sharedHumanToken(LOOP, env)).toBe("h2");
  });
});
