import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeSource } from "../index.js";
import { attribute, changedSpan, declarationAt, LspEnricher, offsetAt, positionAt, splitKey } from "./enrich.js";
import { JsonRpc } from "./jsonrpc.js";
import { detectServer, lspServers, which, type LspServerSpec } from "./servers.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp.mjs");

const PRICING = `class Pricer:
    def __init__(self, rate):
        self.rate = rate

    def quote(self, amount):
        return amount * (1 + self.rate)


def calc_total(prices):
    return sum(prices)
`;
const INIT = `from .pricing import calc_total, Pricer
`;
// Both uses are invisible to tree-sitter: \`calc_total\` comes through the package __init__
// re-export, \`quote\` is called through an instance attribute.
const CART = `from shop import calc_total
from shop.pricing import Pricer


class Cart:
    def __init__(self):
        self.pricer = Pricer()
        self.prices = []

    def total(self):
        return self.pricer.quote(calc_total(self.prices))
`;

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "weft-lsp-"));
  mkdirSync(join(root, "shop"));
  writeFileSync(join(root, "shop/__init__.py"), INIT);
  writeFileSync(join(root, "shop/pricing.py"), PRICING);
  writeFileSync(join(root, "shop/cart.py"), CART);
  return root;
}

function fakeRegistry(log?: string): { servers: LspServerSpec[]; env: NodeJS.ProcessEnv } {
  const spec: LspServerSpec = { ...lspServers[0]!, commands: [{ name: "fake", command: process.execPath, args: [FAKE] }] };
  return { servers: [spec, ...lspServers.slice(1)], env: { ...process.env, ...(log ? { FAKE_LSP_LOG: log } : {}), WEFT_LSP_PYTHON: undefined } };
}

describe("lsp: JSON-RPC framing", () => {
  it("parses split frames, answers server requests, delivers notifications", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const rpc = new JsonRpc(fromServer, toServer, 1000);
    rpc.handle("workspace/configuration", () => [{ ok: true }]);
    const seen: unknown[] = [];
    rpc.on("note", (p) => seen.push(p));
    const sent: string[] = [];
    toServer.on("data", (c: Buffer) => sent.push(c.toString()));
    const frame = (o: object) => {
      const b = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...o }));
      return Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b]);
    };
    const reply = rpc.request("ping", { x: 1 });
    const all = Buffer.concat([frame({ method: "note", params: { n: "é" } }), frame({ id: 7, method: "workspace/configuration", params: {} }), frame({ id: 1, result: "pong" })]);
    for (let i = 0; i < all.length; i += 5) fromServer.write(all.subarray(i, i + 5)); // byte-split, mid-UTF-8 too
    expect(await reply).toBe("pong");
    expect(seen).toEqual([{ n: "é" }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.join("")).toContain('"id":7,"result":[{"ok":true}]');
  });

  it("rejects pending requests when the server goes away, and on timeout", async () => {
    const fromServer = new PassThrough();
    const rpc = new JsonRpc(fromServer, new PassThrough(), 50);
    await expect(rpc.request("slow")).rejects.toThrow(/timed out/);
    const p = rpc.request("x", undefined, 5000);
    fromServer.end();
    await expect(p).rejects.toThrow(/closed/);
    expect(rpc.closed).toBe(true);
  });
});

describe("lsp: server detection", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-lsp-path-"));
  writeFileSync(join(dir, "basedpyright-langserver"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "gopls"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "pyright-langserver"), "not executable\n", { mode: 0o644 });
  const env = { PATH: dir };

  it("finds the first installed command on PATH (an unexecutable file does not count)", () => {
    expect(which("gopls", env)).toBe(join(dir, "gopls"));
    expect(detectServer("python", env)).toMatchObject({ name: "basedpyright", command: join(dir, "basedpyright-langserver"), args: ["--stdio"] });
    expect(detectServer("go", env)?.name).toBe("gopls");
    expect(detectServer("rust", env)).toBeUndefined();
    expect(detectServer("cobol", env)).toBeUndefined();
  });

  it("covers every server in docs/languages.md", () => {
    const names = lspServers.flatMap((s) => s.commands.map((c) => c.name));
    for (const n of ["pyright", "basedpyright", "gopls", "rust-analyzer", "jdtls", "kotlin-lsp", "sourcekit-lsp", "clangd", "ruby-lsp", "csharp-ls"]) expect(names).toContain(n);
  });

  it("WEFT_LSP_<LANG> overrides, WEFT_LSP=off disables", () => {
    expect(detectServer("python", { ...env, WEFT_LSP_PYTHON: `${join(dir, "gopls")} --stdio -v` })).toMatchObject({ name: "gopls", args: ["--stdio", "-v"] });
    expect(detectServer("python", { ...env, WEFT_LSP_PYTHON: "off" })).toBeUndefined();
    expect(detectServer("go", { ...env, WEFT_LSP: "off" })).toBeUndefined();
  });
});

describe("lsp: positions and keys", () => {
  it("converts offsets and LSP positions in UTF-16 units", () => {
    const t = "a😀b\nxy\n";
    expect(positionAt(t, 3)).toEqual({ line: 0, character: 3 });
    expect(positionAt(t, 5)).toEqual({ line: 1, character: 0 });
    expect(offsetAt(t, { line: 1, character: 1 })).toBe(6);
    expect(offsetAt(t, { line: 9, character: 0 })).toBe(8); // clamped to the last line
  });

  it("finds the changed span as whole lines", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB2\nc\n";
    const [s, e] = changedSpan(before, after)!;
    expect(after.slice(s, e)).toBe("B2");
    expect(changedSpan(null, "x")).toEqual([0, 1]);
    expect(changedSpan("x", "x")).toBeUndefined();
  });

  it("maps a location to the declaration whose name holds it, else the innermost one", () => {
    const defs = [
      { name: "Cart", signature: "", body: "", start: 0, end: 100, nameStart: 6, nameEnd: 10 },
      { name: "Cart.total", signature: "", body: "", start: 20, end: 60, nameStart: 24, nameEnd: 29 },
    ];
    expect(declarationAt(defs, 7)?.name).toBe("Cart");
    expect(declarationAt(defs, 40)?.name).toBe("Cart.total");
    expect(declarationAt(defs, 80)?.name).toBe("Cart");
    expect(declarationAt(defs, 200)).toBeUndefined();
    expect(splitKey("app/shop/a.py#X.y", "app/")).toEqual(["shop/a.py", "X.y"]);
  });

  it("attributes a diagnostic to the first use inside its range", () => {
    const r = (l: number, a: number, b: number) => ({ start: { line: l, character: a }, end: { line: l, character: b } });
    const uses = [{ key: "q", range: r(3, 27, 32) }, { key: "c", range: r(3, 33, 43) }];
    expect(attribute(r(3, 15, 57), uses)).toBe("q");
    expect(attribute(r(3, 33, 56), uses)).toBe("c");
    expect(attribute(r(9, 0, 1), uses)).toBe("q");
  });
});

describe("lsp: enrichment against a fake server", () => {
  let root: string;
  let logFile: string;
  let lsp: LspEnricher;
  beforeAll(() => {
    root = checkout();
    logFile = join(root, "fake.log");
    lsp = new LspEnricher({ root, ...fakeRegistry(logFile), diagnosticsTimeoutMs: 3000 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("resolves what tree-sitter cannot: a package re-export and a call through an instance attribute", async () => {
    const exists = (rel: string) => existsSync(join(root, rel));
    const ts = await analyzeSource({ path: "shop/cart.py", before: null, after: CART }, { exists });
    expect(ts.reads).toContain("shop/__init__.py#calc_total"); // the re-export, not the declaration
    expect(ts.reads).not.toContain("shop/pricing.py#calc_total");
    expect(ts.reads).not.toContain("shop/pricing.py#Pricer.quote");

    const r = await lsp.enrich([{ path: "shop/cart.py", before: null, after: CART }], ts.writes);
    expect(r.servers).toEqual(["fake"]);
    expect(r.reads).toEqual(expect.arrayContaining(["shop/pricing.py#calc_total", "shop/pricing.py#Pricer.quote", "shop/pricing.py#Pricer"]));
    // The edit's own declarations are writes, never reads.
    for (const w of ts.writes) expect(r.reads).not.toContain(w.key);
  });

  it("asks only about the changed lines", async () => {
    const before = CART.replace("return self.pricer.quote(calc_total(self.prices))", "return 0.0");
    const r = await lsp.enrich([{ path: "shop/cart.py", before, after: CART }]);
    expect(r.reads).toEqual(["shop/pricing.py#Pricer.quote", "shop/pricing.py#calc_total"]);
  });

  it("lists the callers of a signature change as dependents", async () => {
    const r = await lsp.enrich([{ path: "shop/pricing.py", before: PRICING.replace("(prices)", "(prices, tax)"), after: PRICING }], [{ key: "shop/pricing.py#calc_total", kind: "signature" }]);
    expect(r.dependents).toEqual({ "shop/pricing.py#calc_total": ["shop/cart.py#Cart.total"] });
  });

  it("reports type-aware breakage of a peer's version in memory only, then reverts it", async () => {
    const peer = PRICING.replace("def calc_total(prices):", "def calc_total(prices, tax):");
    const found = await lsp.breakage([{ path: "shop/pricing.py", text: peer }], ["shop/pricing.py#calc_total"]);
    expect(found).toEqual([
      expect.objectContaining({ file: "shop/cart.py", key: "shop/pricing.py#calc_total", message: "fake: calc_total takes 2 arguments", server: "fake", range: expect.objectContaining({ start: { line: 10, character: 33 } }) }),
    ]);
    expect(readFileSync(join(root, "shop/pricing.py"), "utf8")).toBe(PRICING); // disk untouched
    // Reverted: a body-only peer change breaks nothing.
    expect(await lsp.breakage([{ path: "shop/pricing.py", text: PRICING.replace("sum(prices)", "sum(prices) + 0") }], ["shop/pricing.py#calc_total"])).toEqual([]);
  });

  it("does nothing for files without a server or a spec", async () => {
    expect(lsp.available("README.md")).toBeUndefined();
    expect(lsp.available("main.cobol")).toBeUndefined();
    expect(await lsp.enrich([{ path: "notes.txt", before: null, after: "x" }])).toEqual({ reads: [], dependents: {}, servers: [] });
  });

  it("starts one server per language and shuts it down on close", async () => {
    await lsp.close();
    const methods = readFileSync(logFile, "utf8").trim().split("\n");
    expect(methods.filter((m) => m === "initialize")).toHaveLength(1);
    expect(methods.slice(-2)).toEqual(["shutdown", "exit"]);
  });
});

const pyright = which("pyright-langserver") ?? which("basedpyright-langserver");

describe.skipIf(!pyright)("lsp: real pyright", () => {
  it("resolves the re-export and the instance-attribute call, and finds argument breakage", async () => {
    const root = checkout();
    const lsp = new LspEnricher({ root });
    try {
      const r = await lsp.enrich([{ path: "shop/cart.py", before: null, after: CART }]);
      expect(r.reads).toEqual(expect.arrayContaining(["shop/pricing.py#calc_total", "shop/pricing.py#Pricer.quote"]));
      const peer = PRICING.replace("def quote(self, amount):", "def quote(self, amount, currency):");
      const found = await lsp.breakage([{ path: "shop/pricing.py", text: peer }], ["shop/pricing.py#Pricer.quote"]);
      expect(found.map((b) => [b.file, b.key])).toEqual([["shop/cart.py", "shop/pricing.py#Pricer.quote"]]);
      expect(found[0]!.message).toMatch(/currency/);
    } finally {
      await lsp.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
