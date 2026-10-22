// Token and target lookup (docs/harness-coverage.md §3.4) and squiggle placement, in plain Node.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Squiggle, normalize, squiggles } from "@weft/feed";
import { configDir, DEFAULT_URL, localPath, readCheckout, resolveTarget, tokenCandidates } from "../../src/config";
import { diagnosticMessage, placeSymbol, severityOf } from "../../src/place";

function scratch(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "weft-vscode-test-"));
}
function secret(path: string, v: string) {
  writeFileSync(path, v + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe("readCheckout", () => {
  it("reads an adapter config: url, repo, agent, change, prefix, token file", () => {
    const root = scratch();
    mkdirSync(join(root, ".weft"));
    writeFileSync(join(root, ".weft", "claude.json"), JSON.stringify({ url: "http://localhost:8817", repo: "shop", agent: "claude-b", task: { id: "T-2", title: "Cart" }, change: "Ib", prefix: "web/", tokenFile: ".weft/agent-token" }));
    const c = readCheckout(root);
    expect(c).toMatchObject({ url: "http://localhost:8817", repo: "shop", prefix: "web/", tokenFiles: [".weft/agent-token"], from: ".weft/claude.json" });
    expect(c.agents).toEqual([{ agent: "claude-b", change: "Ib", task: "T-2", adapter: "claude" }]);
  });

  it("npx weft's space.json wins over adapter configs", () => {
    const root = scratch();
    mkdirSync(join(root, ".weft"));
    writeFileSync(join(root, ".weft", "space.json"), JSON.stringify({ url: "https://weft-hosted.elier.ai", space: "sp_1", repo: "app", name: "app" }));
    writeFileSync(join(root, ".weft", "codex.json"), JSON.stringify({ url: "https://weft-hosted.elier.ai", repo: "app", agent: "codex-1", change: "Ic" }));
    const c = readCheckout(root);
    expect([c.url, c.repo, c.from]).toEqual(["https://weft-hosted.elier.ai", "app", ".weft/space.json"]);
    expect(c.agents.map((a) => a.agent)).toEqual(["codex-1"]);
  });

  it("a folder without .weft/ is empty", () => {
    expect(readCheckout(scratch())).toMatchObject({ agents: [], tokenFiles: [], prefix: "" });
  });
});

describe("resolveTarget", () => {
  it("settings, then env, then .weft/, then the default", () => {
    const checkout = { root: "/x", url: "http://c", repo: "r-c", agents: [], prefix: "", tokenFiles: [], from: ".weft/claude.json" };
    expect(resolveTarget({ env: {}, checkout })).toMatchObject({ url: "http://c", urlFrom: ".weft/claude.json", repo: "r-c" });
    expect(resolveTarget({ env: { WEFT_URL: "http://e/", WEFT_REPO: "r-e" }, checkout })).toMatchObject({ url: "http://e", urlFrom: "WEFT_URL", repo: "r-e" });
    expect(resolveTarget({ settingUrl: "http://s", settingRepo: "r-s", env: { WEFT_URL: "http://e" }, checkout })).toMatchObject({ url: "http://s", repo: "r-s", repoFrom: "setting weft.repo" });
    expect(resolveTarget({ env: {} })).toEqual({ url: DEFAULT_URL, urlFrom: "default" });
  });
});

describe("tokenCandidates: WEFT_TOKEN, then .weft/, then ~/.config/weft, then SecretStorage", () => {
  it("orders every source and de-duplicates", () => {
    const root = scratch();
    const home = scratch();
    mkdirSync(join(root, ".weft"));
    secret(join(root, ".weft", "human-token"), "t-human");
    secret(join(root, ".weft", "token"), "t-agent");
    const cfg = join(home, ".config", "weft");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "cli.json"), JSON.stringify({ gateways: { "http://g": { kind: "local", viewer: "t-viewer", owner: "t-owner" } } }));
    secret(join(cfg, "shop.token"), "t-repo");
    secret(join(cfg, "token"), "t-agent"); // same as the checkout's: listed once
    const checkout = { ...readCheckout(root), tokenFiles: [".weft/token"] };
    const got = tokenCandidates({ env: { WEFT_TOKEN: "t-env" }, checkout, url: "http://g", repo: "shop", secret: "t-secret", home });
    expect(got.map((t) => [t.token, t.source, t.where])).toEqual([
      ["t-env", "env", "WEFT_TOKEN"],
      ["t-human", "repo", ".weft/human-token"],
      ["t-agent", "repo", ".weft/token"],
      ["t-viewer", "config", "~/.config/weft/cli.json (viewer key)"],
      ["t-repo", "config", "~/.config/weft/shop.token"],
      ["t-secret", "secret", "Weft: Set token (SecretStorage)"],
    ]);
    // The owner token (space API only, no WCP scopes) is never used for the feed.
    expect(got.some((t) => t.token === "t-owner")).toBe(false);
  });

  it("WEFT_HOME and XDG_CONFIG_HOME move ~/.config/weft like npx weft does", () => {
    expect(configDir({ WEFT_HOME: "/w" }, "/h")).toBe("/w");
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/weft");
    expect(configDir({}, "/h")).toBe("/h/.config/weft");
  });

  it("nothing found is an empty list", () => {
    expect(tokenCandidates({ env: {}, url: "http://g", home: scratch() })).toEqual([]);
  });
});

it("localPath strips the adapter prefix", () => {
  expect(localPath("src/a.ts")).toBe("src/a.ts");
  expect(localPath("web/src/a.ts", "web")).toBe("src/a.ts");
  expect(localPath("api/src/a.ts", "web/")).toBeUndefined();
});

describe("placeSymbol", () => {
  const src = ["import { x } from './x';", "", "// calcTotal sums items", "export function calcTotal(items: Item[]): number {", "  return items.reduce((s, i) => s + i.price, 0);", "}", "export const cartTotal = (i: Item[]) => calcTotal(i);"].join("\n");
  it("underlines the declaration, not the first mention", () => {
    expect(placeSymbol(src, "calcTotal")).toEqual({ line: 3, start: 16, end: 25, how: "declaration" });
    expect(placeSymbol(src, "cartTotal")).toEqual({ line: 6, start: 13, end: 22, how: "declaration" });
  });
  it("uses the record's range when there is one", () => {
    expect(placeSymbol(src, "calcTotal", { line: 7, column: 30 })).toEqual({ line: 6, start: 40, end: 49, how: "range" });
  });
  it("falls back to a mention, then the top of the file", () => {
    expect(placeSymbol("x = Item\n", "Item")).toEqual({ line: 0, start: 4, end: 8, how: "mention" });
    expect(placeSymbol("abc\n", "zzz")).toEqual({ line: 0, start: 0, end: 3, how: "file" });
    expect(placeSymbol("abc\n", "*").how).toBe("file");
  });
});

it("severity mapping and the Problems-panel message carry the cause", () => {
  const e = normalize({
    repo: "shop",
    seq: 6,
    ts: "2026-10-22T13:40:00Z",
    kind: "edit",
    status: "rejected",
    mode: "check",
    agent: "claude-b",
    change: "Ib",
    actor: { type: "agent", id: "claude-b" },
    diagnostics: [{ severity: "error", code: "stale_assumption", file: "src/pricing.ts", symbol: "src/pricing.ts#calcTotal", message: "calcTotal changed under you.", suggestion: "Re-read src/pricing.ts.", caused_by_seq: 4, caused_by_agent: "claude-a" }],
  });
  const [q] = squiggles([e]) as [Squiggle];
  expect([severityOf("error"), severityOf("warning"), severityOf("info")]).toEqual([0, 1, 2]);
  const m = diagnosticMessage(q);
  expect(m).toContain("calcTotal:");
  expect(m).toContain("calcTotal changed under you.");
  expect(m).toContain("Suggestion: Re-read src/pricing.ts.");
  expect(m).toContain("Edit blocked by Weft · caused by claude-a · event #4.");
});
