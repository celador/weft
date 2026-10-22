// Python edits through the adapter's analysis (tree-sitter backend of @weft/analyzer).
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeChanges, analyzeChangesAsync } from "../src/analysis";

const PRICING = "def calc_total(items):\n    return sum(items)\n";
const CART_V1 = "from .pricing import calc_total\n\n\ndef summary(items):\n    return str(len(items))\n";
const CART_V2 = CART_V1.replace("str(len(items))", "str(calc_total(items))");

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "weft-py-"));
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app/__init__.py"), "");
  writeFileSync(join(root, "app/pricing.py"), PRICING);
  writeFileSync(join(root, "app/cart.py"), CART_V1);
  return root;
}

describe("python analysis in the adapter", () => {
  it("gives declaration keys and import-resolved reads", async () => {
    const sets = await analyzeChangesAsync([{ rel: "app/cart.py", before: CART_V1, after: CART_V2 }], checkout(), "svc/");
    expect(sets).toEqual({ reads: ["svc/app/pricing.py#calc_total"], writes: [{ key: "svc/app/cart.py#summary", kind: "body" }] });
  });

  it("signature change of the callee", async () => {
    const sets = await analyzeChangesAsync([{ rel: "app/pricing.py", before: PRICING, after: PRICING.replace("(items)", "(items, tax)") }], checkout());
    expect(sets.writes).toEqual([{ key: "app/pricing.py#calc_total", kind: "signature" }]);
  });

  it("mixed edits: TypeScript is analyzed exactly as before, other files keep whole-file keys", async () => {
    const changes = [
      { rel: "src/a.ts", before: "export function f() { return 1; }\n", after: "export function f(x: number) { return x; }\n" },
      { rel: "README.md", before: "a", after: "b" },
      { rel: "app/pricing.py", before: PRICING, after: PRICING.replace("sum(items)", "sum(items) + 0") },
    ];
    const sets = await analyzeChangesAsync(changes, checkout());
    const ts = analyzeChanges(changes.slice(0, 2), checkout());
    expect(sets.writes).toEqual([...ts.writes, { key: "app/pricing.py#calc_total", kind: "body" }].sort((a, b) => a.key.localeCompare(b.key)));
  });
});
