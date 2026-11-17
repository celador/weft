import { describe, expect, it } from "vitest";
import { EDIT_BUDGET_MS, fastestCpuMs } from "./budget.js";
import { analyzeSource, languageFor } from "./index.js";

const PRICING_V1 = `from dataclasses import dataclass


@dataclass
class Item:
    price: float
    qty: int


TAX_RATE = 0.2


def calc_total(items: list[Item]) -> float:
    return sum(i.price * i.qty for i in items)


class Cart:
    def __init__(self, items: list[Item]):
        self.items = items

    def total(self) -> float:
        return calc_total(self.items) + self.tax()

    def tax(self) -> float:
        return 0.0
`;

const files = new Set(["app/__init__.py", "app/pricing.py", "app/cart.py", "app/util/__init__.py", "app/util/fmt.py"]);
const exists = (rel: string) => files.has(rel);
const run = (before: string | null, after: string | null, path = "app/pricing.py") =>
  analyzeSource({ path, before, after }, { exists });
const writes = async (before: string, after: string) => (await run(before, after)).writes.map((w) => `${w.kind} ${w.key}`);

describe("python (tree-sitter backend)", () => {
  it("maps paths to backends", () => {
    expect(languageFor("a/b.py")).toEqual({ id: "python", name: "Python", backend: "tree-sitter" });
    expect(languageFor("a/b.ts")?.backend).toBe("typescript");
    expect(languageFor("README.md")).toBeUndefined();
  });

  it("lists every declaration of a new file as new, qualified by class", async () => {
    expect(await writes("", PRICING_V1)).toEqual([
      "new app/pricing.py#calc_total",
      "new app/pricing.py#Cart",
      "new app/pricing.py#Cart.__init__",
      "new app/pricing.py#Cart.tax",
      "new app/pricing.py#Cart.total",
      "new app/pricing.py#Item",
      "new app/pricing.py#Item.price",
      "new app/pricing.py#Item.qty",
      "new app/pricing.py#TAX_RATE",
    ]);
  });

  it("tells a signature change from a body change", async () => {
    const sig = PRICING_V1.replace("def calc_total(items: list[Item]) -> float:", "def calc_total(items: list[Item], tax_rate: float) -> float:");
    expect(await writes(PRICING_V1, sig)).toEqual(["signature app/pricing.py#calc_total"]);
    const body = PRICING_V1.replace("return sum(i.price * i.qty for i in items)", "return round(sum(i.price * i.qty for i in items), 2)");
    expect(await writes(PRICING_V1, body)).toEqual(["body app/pricing.py#calc_total"]);
  });

  it("does not treat reformatting a signature as a signature change", async () => {
    const wrapped = PRICING_V1.replace("def calc_total(items: list[Item]) -> float:", "def calc_total(\n    items: list[Item],\n) -> float:");
    expect(await writes(PRICING_V1, wrapped)).not.toContain("signature app/pricing.py#calc_total");
  });

  it("reports a method change as a body change of its class too", async () => {
    const after = PRICING_V1.replace("def tax(self) -> float:", "def tax(self, region: str) -> float:");
    expect(await writes(PRICING_V1, after)).toEqual(["body app/pricing.py#Cart", "signature app/pricing.py#Cart.tax"]);
  });

  it("reports a rename as deleted + new", async () => {
    const after = PRICING_V1.replaceAll("calc_total", "compute_total");
    expect(await writes(PRICING_V1, after)).toEqual([
      "deleted app/pricing.py#calc_total",
      "body app/pricing.py#Cart",
      "body app/pricing.py#Cart.total",
      "new app/pricing.py#compute_total",
    ]);
  });

  it("decorators are part of the signature", async () => {
    const after = PRICING_V1.replace("    def tax(self) -> float:", "    @staticmethod\n    def tax() -> float:");
    expect(await writes(PRICING_V1, after)).toContain("signature app/pricing.py#Cart.tax");
  });

  it("annotation is the signature of an assignment, the value its body", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("TAX_RATE = 0.2", "TAX_RATE = 0.21"))).toEqual(["body app/pricing.py#TAX_RATE"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("TAX_RATE = 0.2", "TAX_RATE: float = 0.2"))).toEqual(["signature app/pricing.py#TAX_RATE"]);
  });

  it("reads local calls, self-calls and type uses", async () => {
    const { reads } = await run(null, PRICING_V1);
    expect(reads).toEqual(["app/pricing.py#Cart.tax", "app/pricing.py#Item", "app/pricing.py#calc_total"]);
  });

  it("reads names imported from checkout modules (absolute, relative, aliased, module imports)", async () => {
    const cart = `import os
from typing import List
from app.pricing import calc_total as total_of, Item
from .util import fmt
import app.pricing as pricing
from . import pricing as p2


def summary(items: List[Item]) -> str:
    return fmt.money(total_of(items)) + str(pricing.TAX_RATE) + str(p2.Cart(items).total())
`;
    const { reads, writes: w } = await run(null, cart, "app/cart.py");
    expect(w).toEqual([{ key: "app/cart.py#summary", kind: "new" }]);
    expect(reads).toEqual([
      "app/pricing.py#Cart",
      "app/pricing.py#Item",
      "app/pricing.py#TAX_RATE",
      "app/pricing.py#calc_total",
      "app/util/fmt.py#money",
    ]);
  });

  describe("reads are scoped to the declarations the edit adds or changes (docs/languages.md)", () => {
    // python-slugify (cold run 2026-11): B's edit to `__all__` read `_decode_entities`, which
    // only `slugify` calls, and so cleared B's open stale_assumption on it.
    const SLUGIFY = `import re
from .cart import Cart

__all__ = ["slugify"]


def _decode_entities(text, hexadecimal=True):
    return text


def _modern_slugify(text):
    return re.sub("x", "", text)


def slugify(text):
    text = _decode_entities(text)
    return Cart(_modern_slugify(text))
`;
    const slug = (after: string) => run(SLUGIFY, after, "app/slugify.py");

    it("an edit to __all__ does not read _decode_entities (or anything the file's functions use)", async () => {
      expect(await slug(SLUGIFY.replace('__all__ = ["slugify"]', '__all__ = ["slugify", "Cart"]'))).toEqual({
        reads: [],
        writes: [{ key: "app/slugify.py#__all__", kind: "body" }],
      });
    });

    it("an edit to one function reads only what that function references", async () => {
      const r = await slug(SLUGIFY.replace("text = _decode_entities(text)", "text = _decode_entities(text, hexadecimal=False)"));
      expect(r.reads).toEqual(["app/cart.py#Cart", "app/slugify.py#_decode_entities", "app/slugify.py#_modern_slugify"]);
      expect((await slug(SLUGIFY.replace('re.sub("x", "", text)', 're.sub("y", "", text)'))).reads).toEqual([]);
    });

    it("an edit adding f() that calls g reads g", async () => {
      const r = await slug(`${SLUGIFY}\n\ndef f(text):\n    return _decode_entities(text)\n`);
      expect(r).toEqual({ reads: ["app/slugify.py#_decode_entities"], writes: [{ key: "app/slugify.py#f", kind: "new" }] });
    });

    it("an import the edit adds is read; an existing one only when touched code uses it", async () => {
      const imported = await slug(SLUGIFY.replace("from .cart import Cart\n", "from .cart import Cart\nfrom .pricing import calc_total\n"));
      expect(imported.reads).toEqual(["app/pricing.py#calc_total"]);
    });

    it("a method edit reads that method's self-calls, not its siblings'", async () => {
      const after = PRICING_V1.replace("return 0.0", "return TAX_RATE");
      expect((await run(PRICING_V1, after)).reads).toEqual([]);
      const total = PRICING_V1.replace("return calc_total(self.items) + self.tax()", "return calc_total(self.items) * 2 + self.tax()");
      expect((await run(PRICING_V1, total)).reads).toEqual(["app/pricing.py#Cart.tax", "app/pricing.py#calc_total"]);
    });
  });

  it("prefixes keys with the checkout's path in the repository", async () => {
    const r = await analyzeSource({ path: "app/pricing.py", before: "", after: "def f():\n    return 1\n" }, { prefix: "svc/" });
    expect(r.writes).toEqual([{ key: "svc/app/pricing.py#f", kind: "new" }]);
  });

  it("deleting a file deletes its declarations", async () => {
    const r = await run("def f():\n    pass\n", null);
    expect(r).toEqual({ reads: [], writes: [{ key: "app/pricing.py#f", kind: "deleted" }] });
  });

  it("stays inside the edit-time budget (< 300 ms CPU for a 2,000-line file, warm)", async () => {
    const big = Array.from({ length: 200 }, (_, i) => PRICING_V1.replaceAll("calc_total", `calc_${i}`).replaceAll("Cart", `Cart${i}`).replaceAll("Item", `Item${i}`)).join("\n");
    await run(big, big);
    expect(await fastestCpuMs(() => run(big, big.replace("calc_7(items", "calc_7(items, x")))).toBeLessThan(EDIT_BUDGET_MS);
  });
});
