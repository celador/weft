// The engine parses `after` incrementally from the parse of `before` (treesitter.ts markEdit).
// The result must be the tree a full parse of `after` gives, for every language and any edit.
import { describe, expect, it } from "vitest";
import { treeSitterLanguages } from "./languages/index.js";
import { markEdit, parserFor } from "./treesitter.js";

const SAMPLES: Record<string, string> = {
  go: `package pricing\n\nimport "fmt"\n\n// Señor’s cart 🛒.\ntype Cart struct {\n\tItems []Item\n}\n\nfunc (c *Cart) Total() int {\n\treturn CalcTotal(c.Items)\n}\n\nfunc CalcTotal(items []Item) int {\n\tfmt.Println("total")\n\treturn len(items)\n}\n`,
  rust: `use crate::pricing::{self, Item};\n\n/// Señor’s cart 🛒.\n#[derive(Debug)]\npub struct Cart {\n    items: Vec<Item>,\n}\n\nimpl Cart {\n    pub fn total(&self) -> u32 {\n        pricing::calc_total(&self.items)\n    }\n}\n`,
  python: `import os\n\n\nclass Cart:\n    """Señor’s cart 🛒."""\n\n    def total(self, items):\n        return sum(i.price for i in items)\n\n\ndef calc_total(items):\n    return Cart().total(items)\n`,
  java: `package a;\n\n/** Señor’s cart 🛒. */\npublic class Cart {\n    static final String NAME = "carrito ñ";\n\n    double total(java.util.List<Item> items) {\n        return items.stream().mapToDouble(i -> i.price).sum();\n    }\n}\n`,
  kotlin: `package a\n\n// Señor’s cart 🛒.\nclass Cart(val items: List<Item>) {\n    val name = "carrito ñ"\n\n    fun total(): Double = items.sumOf { it.price * it.qty }\n}\n\nfun calcTotal(items: List<Item>) = Cart(items).total()\n`,
  swift: `import Foundation\n\n/// Señor’s cart 🛒.\nstruct Cart {\n    let name = "carrito ñ"\n    var items: [Item]\n\n    func total() -> Double {\n        items.reduce(0) { $0 + $1.price * Double($1.qty) }\n    }\n}\n\nextension Cart {\n    func tax(rate: Double = 0.2) -> Double { total() * rate }\n}\n\nfunc calcTotal(items: [Item]) -> Double { Cart(items: items).total() }\n`,
  csharp: `using System.Linq;\n\nnamespace Shop;\n\n/// <summary>Señor’s cart 🛒.</summary>\npublic class Cart\n{\n    public const string Name = "carrito ñ";\n    public List<Item> Items { get; } = new();\n\n    public decimal Total() => Items.Sum(i => i.Price * i.Qty);\n\n    public static decimal CalcTotal(List<Item> items) => new Cart().Total();\n}\n`,
};

/** Deterministic edits: insert, delete and replace at spread-out positions, including next to non-ASCII text. */
function edits(text: string): string[] {
  const out: string[] = [];
  const at = (f: number) => Math.floor(text.length * f);
  for (const f of [0, 0.13, 0.31, 0.5, 0.77, 0.97]) {
    const i = at(f);
    out.push(text.slice(0, i) + "é🛒 x\n" + text.slice(i));
    out.push(text.slice(0, i) + text.slice(Math.min(text.length, i + 7)));
    out.push(text.slice(0, i) + "(y, z)" + text.slice(Math.min(text.length, i + 3)));
  }
  const tag = text.indexOf("🛒");
  out.push(text.slice(0, tag) + "🧾🧾" + text.slice(tag + 2));
  out.push(text + "\n\n" + text);
  out.push("");
  return out;
}

describe("incremental reparse", () => {
  for (const language of treeSitterLanguages) {
    const sample = SAMPLES[language.id];
    if (!sample) continue;
    it(`${language.id}: equals a full parse for every edit`, async () => {
      const parser = await parserFor(language);
      for (const after of edits(sample)) {
        const old = parser.parse(sample)!;
        const incremental = parser.parse(after, markEdit(old, sample, after))!;
        const full = parser.parse(after)!;
        expect(incremental.rootNode.toString()).toBe(full.rootNode.toString());
        expect([incremental.rootNode.startIndex, incremental.rootNode.endIndex, incremental.rootNode.text]).toEqual([full.rootNode.startIndex, full.rootNode.endIndex, full.rootNode.text]);
        old.delete();
        incremental.delete();
        full.delete();
      }
    });
  }
});
