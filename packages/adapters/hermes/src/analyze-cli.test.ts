import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, handleAsync, importReads, languages } from "./analyze-cli";

describe("analyze-cli handle()", () => {
  it("classifies signature/body/new writes and keeps reads", () => {
    const res = handle({
      files: [
        {
          path: "src/a.ts",
          before: "export function f(a: number) { return a }\nexport function g() { return 1 }\n",
          after: "export function f(a: number, b = 2) { return a + b }\nexport function g() { return 2 }\nexport const k = 1;\n",
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.writes).toEqual(
      expect.arrayContaining([
        { key: "src/a.ts#f", kind: "signature" },
        { key: "src/a.ts#g", kind: "body" },
        { key: "src/a.ts#k", kind: "new" },
      ]),
    );
    expect(res.analyzed).toEqual(["src/a.ts"]);
  });

  it("skips files the TS analyzer does not understand", () => {
    const res = handle({ files: [{ path: "docs/design.md", before: "a", after: "b" }] });
    expect(res).toMatchObject({ ok: true, writes: [], analyzed: [] });
  });

  it("reports bad requests instead of throwing", () => {
    expect(handle({} as never)).toMatchObject({ ok: false });
  });
});

describe("importReads()", () => {
  it("turns relative imports into cross-file reads", () => {
    const text = [
      'import { f, g as gg } from "./a.js";',
      'import * as ns from "./c";',
      'import D from "../d";',
      'import { external } from "node:fs";',
      "export function h(x: ns.T) { return f(3) + ns.k() + gg() }",
    ].join("\n");
    expect(importReads(text, "src/b.ts").sort()).toEqual(
      ["d.ts#default", "src/a.ts#f", "src/a.ts#g", "src/c.ts#T", "src/c.ts#k"].sort(),
    );
  });

  it("resolves against the checkout (index files, prefix)", () => {
    const root = mkdtempSync(join(tmpdir(), "weft-imports-"));
    mkdirSync(join(root, "src/lib"), { recursive: true });
    writeFileSync(join(root, "src/lib/index.ts"), "export const x = 1;\n");
    const reads = importReads('import { x } from "./lib";\n', "ios/src/b.ts", root, "ios/");
    expect(reads).toEqual(["ios/src/lib/index.ts#x"]);
    expect(importReads('import { y } from "./missing";\n', "src/b.ts", root)).toEqual([]);
  });

  it("feeds handle(): an edit reading an imported symbol lists it", () => {
    const res = handle({
      files: [{ path: "src/api/client.ts", before: "", after: 'import { refreshToken } from "../auth/session";\nexport function fetchWithAuth() { return refreshToken() }\n' }],
    });
    expect(res.ok && res.reads).toContain("src/auth/session.ts#refreshToken");
  });
});

describe("tree-sitter languages (handleAsync)", () => {
  it("lists every extension the bundle analyzes", () => {
    const info = languages();
    expect(info.extensions).toEqual(expect.arrayContaining([".ts", ".tsx", ".js", ".py"]));
    expect(info.languages.map((l) => l.id)).toEqual(expect.arrayContaining(["typescript", "python"]));
  });

  it("gives Python edits declaration keys and checkout-resolved reads, with the prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "weft-py-"));
    mkdirSync(join(root, "shop"), { recursive: true });
    writeFileSync(join(root, "shop/__init__.py"), "");
    writeFileSync(join(root, "shop/pricing.py"), "def calc_total(items):\n    return sum(items)\n");
    const res = await handleAsync({
      root,
      prefix: "app/",
      files: [
        {
          path: "app/shop/cart.py",
          before: "class Cart:\n    def total(self, items):\n        return 0\n",
          after: "from shop.pricing import calc_total\n\nclass Cart:\n    def total(self, items, tip):\n        return calc_total(items)\n\ndef helper():\n    pass\n",
        },
        { path: "app/src/a.ts", before: "export function k() { return 1 }\n", after: "export function k() { return 2 }\n" },
        { path: "app/README.md", before: "a", after: "b" },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.writes).toEqual(
      expect.arrayContaining([
        { key: "app/shop/cart.py#Cart.total", kind: "signature" },
        { key: "app/shop/cart.py#helper", kind: "new" },
        { key: "app/src/a.ts#k", kind: "body" },
      ]),
    );
    expect(res.reads).toContain("app/shop/pricing.py#calc_total");
    expect(res.analyzed.sort()).toEqual(["app/shop/cart.py", "app/src/a.ts"]);
    expect(res.languages).toEqual(["python", "typescript"]);
  });

  it("keeps the TS-only path identical", async () => {
    const req = { files: [{ path: "src/a.ts", before: "export function f() { return 1 }\n", after: "export function f(x = 1) { return x }\n" }] };
    const { languages: used, ...rest } = (await handleAsync(req)) as Extract<Awaited<ReturnType<typeof handleAsync>>, { ok: true }>;
    expect(rest).toEqual(handle(req));
    expect(used).toEqual(["typescript"]);
  });
});
