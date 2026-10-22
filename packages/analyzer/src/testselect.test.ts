import { describe, expect, it } from "vitest";
import { fileFacts, globToRegExp, selectTests, selectedCommand, type ChangedFile, type FileFacts, type SelectInput } from "./testselect.js";

// A small shop: two independent areas (pricing, users) plus a barrel, a helper and JSON data.
const TRUNK: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop", type: "module" }),
  "README.md": "# shop\n",
  "src/money.ts": `export function round2(n: number): number {\n  return Math.round(n * 100) / 100;\n}\nexport const CURRENCY = "USD";\n`,
  "src/pricing.ts": `import { round2 } from "./money.js";\nexport function lineTotal(price: number, qty: number): number {\n  return round2(price * qty);\n}\nexport function discount(total: number): number {\n  return total > 100 ? total * 0.9 : total;\n}\n`,
  "src/cart.ts": `import { lineTotal } from "./pricing.js";\nexport class Cart {\n  items: Array<{ price: number; qty: number }> = [];\n  total(): number {\n    return this.items.reduce((s, i) => s + lineTotal(i.price, i.qty), 0);\n  }\n}\n`,
  "src/users.ts": `export function displayName(first: string, last: string): string {\n  return \`\${first} \${last}\`;\n}\n`,
  "src/index.ts": `export * from "./pricing.js";\nexport { displayName as nameOf } from "./users.js";\n`,
  "src/catalog.json": `{"apple": 1}\n`,
  "src/catalog.ts": `import data from "./catalog.json" with { type: "json" };\nexport const PRICES: Record<string, number> = data;\n`,
  "test/helpers.ts": `import { Cart } from "../src/cart.js";\nexport function cartOf(...p: number[]): Cart {\n  const c = new Cart();\n  for (const price of p) c.items.push({ price, qty: 1 });\n  return c;\n}\n`,
  "test/cart.test.ts": `import { test } from "node:test";\nimport { cartOf } from "./helpers.js";\ntest("cart", () => cartOf(1, 2).total());\n`,
  "test/discount.test.ts": `import { test } from "node:test";\nimport { discount } from "../src/pricing.js";\ntest("discount", () => discount(200));\n`,
  "test/users.test.ts": `import { test } from "node:test";\nimport { displayName } from "../src/users.js";\ntest("users", () => displayName("a", "b"));\n`,
  "test/barrel.test.ts": `import { test } from "node:test";\nimport * as shop from "../src/index.js";\ntest("barrel", () => shop.nameOf("a", "b"));\n`,
  "test/catalog.test.ts": `import { test } from "node:test";\nimport { PRICES } from "../src/catalog.js";\ntest("catalog", () => PRICES.apple);\n`,
  "test/money.test.ts": `import { test } from "node:test";\nimport { CURRENCY } from "../src/money.js";\ntest("currency", () => CURRENCY);\n`,
};

function input(edits: Record<string, string | null>, extra: Partial<SelectInput> = {}): SelectInput {
  const after: Record<string, string> = { ...TRUNK };
  const changed: ChangedFile[] = [];
  for (const [p, v] of Object.entries(edits)) {
    if (v === null) {
      delete after[p];
      changed.push({ status: "D", path: p });
    } else {
      changed.push({ status: p in TRUNK ? "M" : "A", path: p });
      after[p] = v;
    }
  }
  return { files: Object.keys(after), read: (p) => after[p], readBefore: (p) => TRUNK[p], changed, ...extra };
}
const edit = (p: string, from: string, to: string) => {
  const t = TRUNK[p]!;
  if (!t.includes(from)) throw new Error(`fixture: ${from} not in ${p}`);
  return { [p]: t.replace(from, to) };
};

describe("selectTests: affected tests from the analyzer write set", () => {
  it("a body change runs only the tests that reach the symbol, transitively through callers and helpers", () => {
    const s = selectTests(input(edit("src/money.ts", "Math.round(n * 100) / 100", "Math.round(n * 1000) / 1000")));
    expect(s.mode).toBe("subset");
    expect(s.writes).toEqual([{ key: "src/money.ts#round2", kind: "body" }]);
    // round2 <- pricing.lineTotal <- cart.Cart <- helpers.cartOf <- cart.test; barrel re-exports pricing (export *)
    expect(s.selected).toEqual(["test/barrel.test.ts", "test/cart.test.ts"]);
    expect(s.total).toBe(6);
    expect(s.why["test/cart.test.ts"]).toBe("reaches ./helpers.js#cartOf");
  });

  it("symbol precision: a sibling export in the same file does not drag in unrelated tests", () => {
    const s = selectTests(input(edit("src/pricing.ts", "total * 0.9", "total * 0.8")));
    expect(s.selected).toEqual(["test/barrel.test.ts", "test/discount.test.ts"]);
    const m = selectTests(input(edit("src/money.ts", `"USD"`, `"EUR"`)));
    expect(m.selected).toEqual(["test/money.test.ts"]);
  });

  it("follows named re-exports with renames and namespace imports", () => {
    const s = selectTests(input(edit("src/users.ts", "${first} ${last}", "${last}, ${first}")));
    expect(s.selected).toEqual(["test/barrel.test.ts", "test/users.test.ts"]);
  });

  it("a changed test file is always selected; a new test file too", () => {
    const s = selectTests(input({ ...edit("test/users.test.ts", `"a", "b"`, `"x", "y"`), "test/new.test.ts": `import { test } from "node:test";\ntest("new", () => 1);\n` }));
    expect(s.selected).toEqual(["test/new.test.ts", "test/users.test.ts"]);
    expect(s.why["test/new.test.ts"]).toBe("test file changed");
  });

  it("imported JSON data taints its importers", () => {
    const s = selectTests(input({ "src/catalog.json": `{"apple": 2}\n` }));
    expect(s.mode).toBe("subset");
    expect(s.selected).toEqual(["test/catalog.test.ts"]);
  });

  it("an import change outside any declaration taints the whole module", () => {
    const s = selectTests(input({ "src/users.ts": `import { CURRENCY } from "./money.js";\n${TRUNK["src/users.ts"]}export const C = CURRENCY;\n` }));
    expect(s.selected).toEqual(["test/barrel.test.ts", "test/users.test.ts"]);
  });

  it("docs-only change selects nothing (subset of 0)", () => {
    const s = selectTests(input({ "README.md": "# shop!\n" }));
    expect(s).toMatchObject({ mode: "subset", selected: [], total: 6 });
  });

  it("deleting a module selects the tests that imported it", () => {
    const s = selectTests(input({ "src/users.ts": null }));
    expect(s.selected).toEqual(["test/barrel.test.ts", "test/users.test.ts"]);
  });

  it("dynamic imports: literal specifiers are edges, non-literal ones make the test always run", () => {
    const files: Record<string, string> = { ...TRUNK, "test/dyn.test.ts": `import { test } from "node:test";\ntest("dyn", async () => (await import("../src/users.js")).displayName("a", "b"));\n`, "test/plugin.test.ts": `import { test } from "node:test";\nconst name = "users";\ntest("p", async () => import(\`../src/\${name}.js\`));\n` };
    const base: SelectInput = { files: Object.keys(files), read: (p) => (p === "src/money.ts" ? files[p]!.replace('"USD"', '"EUR"') : files[p]), readBefore: (p) => files[p], changed: [{ status: "M", path: "src/money.ts" }] };
    const s = selectTests(base);
    expect(s.selected).toEqual(["test/money.test.ts", "test/plugin.test.ts"]);
    expect(s.why["test/plugin.test.ts"]).toBe("reaches a dynamic or unresolved import");
    const u = selectTests({ ...base, read: (p) => (p === "src/users.ts" ? files[p]!.replace("${first} ${last}", "${last}") : files[p]), changed: [{ status: "M", path: "src/users.ts" }] });
    expect(u.selected).toEqual(["test/barrel.test.ts", "test/dyn.test.ts", "test/plugin.test.ts", "test/users.test.ts"]);
  });

  it("workspace packages resolve through package.json exports (and dist -> src)", () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "root", private: true }),
      "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./util": "./src/util.ts" } }),
      "packages/core/src/index.ts": `export function core(): number {\n  return 1;\n}\n`,
      "packages/core/src/util.ts": `export const U = 1;\n`,
      "apps/web/src/a.test.ts": `import { core } from "@acme/core";\ncore();\n`,
      "apps/web/src/b.test.ts": `import { U } from "@acme/core/util";\nU;\n`,
    };
    const s = selectTests({ files: Object.keys(files), read: (p) => (p === "packages/core/src/index.ts" ? files[p]!.replace("return 1", "return 2") : files[p]), readBefore: (p) => files[p], changed: [{ status: "M", path: "packages/core/src/index.ts" }] });
    expect(s).toMatchObject({ mode: "subset", selected: ["apps/web/src/a.test.ts"] });
  });

  it("cache: facts keyed by blob sha are reused", () => {
    const cache = new Map<string, FileFacts>();
    const blobs = Object.fromEntries(Object.keys(TRUNK).map((p) => [p, `blob:${p}`]));
    const a = selectTests(input(edit("src/money.ts", `"USD"`, `"EUR"`), { blobs: { ...blobs, "src/money.ts": "blob:money2" }, cache }));
    const b = selectTests(input(edit("src/users.ts", "${first} ${last}", "${last}"), { blobs: { ...blobs, "src/users.ts": "blob:users2" }, cache }));
    expect(a.graph.cached).toBe(0);
    expect(b).toMatchObject({ graph: { files: a.graph.files, parsed: 2, cached: a.graph.files - 2 } }); // trunk money.ts + new users.ts parsed, the rest reused
    expect(b.selected).toEqual(["test/barrel.test.ts", "test/users.test.ts"]);
  });
});

describe("selectTests: fallback to the full suite", () => {
  const all = ["test/barrel.test.ts", "test/cart.test.ts", "test/catalog.test.ts", "test/discount.test.ts", "test/money.test.ts", "test/users.test.ts"];
  it.each([
    ["risk tier high", input(edit("src/money.ts", `"USD"`, `"EUR"`), { risk: "high" }), "risk tier high"],
    ["package.json", input({ "package.json": JSON.stringify({ name: "shop", type: "module", dependencies: { x: "1" } }) }), "config/deps/test infra changed: package.json"],
    ["lockfile", input({ "pnpm-lock.yaml": "lockfileVersion: 9\n" }), "config/deps/test infra changed: pnpm-lock.yaml"],
    ["tsconfig", input({ "tsconfig.json": "{}" }), "config/deps/test infra changed: tsconfig.json"],
    ["test runner config", input({ "vitest.config.ts": "export default {}\n" }), "config/deps/test infra changed: vitest.config.ts"],
    ["CI", input({ ".github/workflows/ci.yml": "on: push\n" }), "config/deps/test infra changed: .github/workflows/ci.yml"],
    ["parse error", input({ "src/users.ts": "export function displayName(first: string {\n" }), "analyzer cannot parse src/users.ts"],
    ["runtime fixture", input({ "test/fixtures/order.csv": "a,b\n" }), "non-code file changed that no module imports (tests may read it at runtime): test/fixtures/order.csv"],
    ["other language", input({ "tools/gen.py": "print(1)\n" }), "no TS/JS graph for tools/gen.py"],
    ["auth path", input({ "src/auth/session.ts": "export const S = 1;\n" }), "high-risk path changed: src/auth/session.ts"],
  ])("%s", (_name, inp, reason) => {
    const s = selectTests(inp);
    expect(s.mode).toBe("full");
    expect(s.reason).toContain(reason);
    expect(s.selected).toEqual(all);
  });

  it("medium risk still selects; full_at_risk can lower the threshold", () => {
    expect(selectTests(input(edit("src/money.ts", `"USD"`, `"EUR"`), { risk: "medium" })).mode).toBe("subset");
    expect(selectTests(input(edit("src/money.ts", `"USD"`, `"EUR"`), { risk: "medium", config: { full_at_risk: "medium" } })).reason).toBe("risk tier medium");
  });

  it("configured infra globs and max_fraction", () => {
    expect(selectTests(input({ "src/users.ts": TRUNK["src/users.ts"] + "\n" }, { config: { infra: ["src/users.ts"] } })).reason).toBe("config/deps/test infra changed: src/users.ts");
    const s = selectTests(input(edit("src/money.ts", "Math.round(n * 100) / 100", "n"), { config: { max_fraction: 0.2 } }));
    expect(s.mode).toBe("full");
    expect(s.reason).toMatch(/above max_fraction/);
  });

  it("no tests found", () => {
    expect(selectTests({ files: ["src/a.ts"], read: () => "export const a = 1;\n", readBefore: () => "export const a = 0;\n", changed: [{ status: "M", path: "src/a.ts" }] }).reason).toBe("no test files matched the test globs");
  });
});

describe("helpers", () => {
  it("globs", () => {
    expect(globToRegExp("**/*.test.{ts,js}").test("a/b/c.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.{ts,js}").test("c.test.js")).toBe(true);
    expect(globToRegExp("**/*.test.{ts,js}").test("c.test.tsx")).toBe(false);
    expect(globToRegExp(".weft/**").test(".weft/preview.json")).toBe(true);
    expect(globToRegExp("**/tsconfig*.json").test("packages/x/tsconfig.build.json")).toBe(true);
  });
  it("selected command: placeholder or appended", () => {
    expect(selectedCommand(["node", "--test"], ["a.test.ts", "b.test.ts"])).toEqual(["node", "--test", "a.test.ts", "b.test.ts"]);
    expect(selectedCommand(["pnpm", "vitest", "run", "{files}", "--reporter=dot"], ["a.ts"])).toEqual(["pnpm", "vitest", "run", "a.ts", "--reporter=dot"]);
    expect(selectedCommand("npm test --", ["it's.test.ts"])).toEqual(["sh", "-c", "npm test -- 'it'\\''s.test.ts'"]);
  });
  it("facts: imports, exports, declarations and module-level references", () => {
    const f = fileFacts("x.ts", `import a, { b as c } from "./y";\nimport * as ns from "./z";\nimport "./side";\nexport { c as d };\nexport * from "./w";\nexport default function main() { return c() + ns.q; }\nconst { p, q } = a;\nrun(p);\n`);
    expect(f.imports).toEqual({ a: ["./y", "default"], c: ["./y", "b"], ns: ["./z", "*"] });
    expect(f.side).toEqual(["./side"]);
    expect(f.exports).toEqual({ d: "c", default: "main" });
    expect(f.star).toEqual(["./w"]);
    expect(f.decls.main).toEqual(expect.arrayContaining(["c", "ns", "q"]));
    expect(f.decls.p).toEqual(["a"]);
    expect(f.module).toEqual(expect.arrayContaining(["run", "p"]));
    expect(f.parse_error).toBeNull();
  });
});
