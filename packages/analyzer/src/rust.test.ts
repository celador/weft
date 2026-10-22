import { describe, expect, it } from "vitest";
import { cpuMs, EDIT_BUDGET_MS } from "./budget.js";
import { analyzeSource, languageFor } from "./index.js";

const PRICING_V1 = `use std::fmt;

/// Default tax rate.
pub const TAX_RATE: f64 = 0.2;

#[derive(Debug, Clone)]
pub struct Item {
    pub price: f64,
    pub qty: u32,
}

pub enum Discount {
    None,
    Percent(f64),
}

pub trait Pricer {
    fn price(&self, items: &[Item]) -> f64;
}

pub fn calc_total(items: &[Item]) -> f64 {
    items.iter().map(|i| i.price * i.qty as f64).sum()
}

pub fn format_price(amount: f64) -> String {
    format!("\${:.2}", amount)
}

pub struct Cart {
    pub items: Vec<Item>,
}

impl Cart {
    pub fn new(items: Vec<Item>) -> Self {
        Self { items }
    }

    pub fn total(&self) -> f64 {
        calc_total(&self.items) + self.tax()
    }

    fn tax(&self) -> f64 {
        0.0
    }
}

impl fmt::Display for Cart {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", format_price(self.total()))
    }
}
`;

const files = new Set(["Cargo.toml", "src/lib.rs", "src/pricing.rs", "src/cart.rs", "src/util/mod.rs", "src/util/money.rs"]);
const exists = (rel: string) => files.has(rel);
const run = (before: string | null, after: string | null, path = "src/pricing.rs") => analyzeSource({ path, before, after }, { exists });
const writes = async (before: string, after: string) => (await run(before, after)).writes.map((w) => `${w.kind} ${w.key}`);

describe("rust (tree-sitter backend)", () => {
  it("maps .rs to the Rust backend", () => {
    expect(languageFor("src/main.rs")).toEqual({ id: "rust", name: "Rust", backend: "tree-sitter" });
  });

  it("lists every declaration of a new file as new, impl methods qualified by their type", async () => {
    expect(await writes("", PRICING_V1)).toEqual([
      "new src/pricing.rs#calc_total",
      "new src/pricing.rs#Cart",
      "new src/pricing.rs#Cart.fmt",
      "new src/pricing.rs#Cart.new",
      "new src/pricing.rs#Cart.tax",
      "new src/pricing.rs#Cart.total",
      "new src/pricing.rs#Discount",
      "new src/pricing.rs#format_price",
      "new src/pricing.rs#Item",
      "new src/pricing.rs#Pricer",
      "new src/pricing.rs#Pricer.price",
      "new src/pricing.rs#TAX_RATE",
    ]);
  });

  it("tells a signature change from a body change", async () => {
    const sig = PRICING_V1.replace("pub fn calc_total(items: &[Item]) -> f64 {", "pub fn calc_total(items: &[Item], tax_rate: f64) -> f64 {");
    expect(await writes(PRICING_V1, sig)).toEqual(["signature src/pricing.rs#calc_total"]);
    const body = PRICING_V1.replace("i.price * i.qty as f64).sum()", "i.price * i.qty as f64).sum::<f64>()");
    expect(await writes(PRICING_V1, body)).toEqual(["body src/pricing.rs#calc_total"]);
    const method = PRICING_V1.replace("fn tax(&self) -> f64 {", "fn tax(&self, region: &str) -> f64 {");
    expect(await writes(PRICING_V1, method)).toEqual(["signature src/pricing.rs#Cart.tax"]);
  });

  it("fields, variants and attributes are part of the signature; a const's value is its body", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("pub qty: u32,", "pub qty: u32,\n    pub sku: String,"))).toEqual(["signature src/pricing.rs#Item"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("    Percent(f64),", "    Percent(f64),\n    Fixed(f64),"))).toEqual(["signature src/pricing.rs#Discount"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("#[derive(Debug, Clone)]", "#[derive(Debug)]"))).toEqual(["signature src/pricing.rs#Item"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("TAX_RATE: f64 = 0.2", "TAX_RATE: f64 = 0.21"))).toEqual(["body src/pricing.rs#TAX_RATE"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("TAX_RATE: f64 = 0.2", "TAX_RATE: f32 = 0.2"))).toEqual(["signature src/pricing.rs#TAX_RATE"]);
  });

  it("does not treat reformatting (rustfmt, wrapped parameters, trailing comma) as a signature change", async () => {
    const wrapped = PRICING_V1.replace("pub fn calc_total(items: &[Item]) -> f64 {", "pub fn calc_total(\n    items: &[Item],\n) -> f64 {");
    expect(await writes(PRICING_V1, wrapped)).not.toContain("signature src/pricing.rs#calc_total");
    const fields = PRICING_V1.replace("    pub price: f64,\n    pub qty: u32,\n", "    pub price:   f64,\n    pub qty:     u32,\n");
    expect(await writes(PRICING_V1, fields)).not.toContain("signature src/pricing.rs#Item");
  });

  it("reports a rename as deleted + new", async () => {
    const after = PRICING_V1.replaceAll("format_price", "format_money");
    expect(await writes(PRICING_V1, after)).toEqual([
      "body src/pricing.rs#Cart.fmt",
      "new src/pricing.rs#format_money",
      "deleted src/pricing.rs#format_price",
    ]);
  });

  it("reads local calls, Self/self calls, types, and calls inside macro arguments", async () => {
    const { reads } = await run(null, PRICING_V1);
    expect(reads).toEqual([
      "src/pricing.rs#Cart",
      "src/pricing.rs#Cart.tax",
      "src/pricing.rs#Cart.total", // self.total() inside write!(..)
      "src/pricing.rs#Item",
      "src/pricing.rs#calc_total",
      "src/pricing.rs#format_price", // inside write!(..)
    ]);
  });

  it("reads names imported from crate modules (use trees, aliases, self, mod, super, crate:: paths)", async () => {
    const cart = `use std::collections::HashMap;
use crate::pricing::{self, calc_total, Item as LineItem};
use crate::util::money;

pub fn summary(items: &[LineItem]) -> String {
    let c = pricing::Cart::new(items.to_vec());
    let _m: HashMap<u8, u8> = HashMap::new();
    format!("{} {} {}", calc_total(items), money::round(c.total()), crate::pricing::TAX_RATE)
}
`;
    const r = await run(null, cart, "src/cart.rs");
    expect(r.writes).toEqual([{ key: "src/cart.rs#summary", kind: "new" }]);
    expect(r.reads).toEqual([
      "src/pricing.rs#Cart",
      "src/pricing.rs#Cart.new",
      "src/pricing.rs#Item",
      "src/pricing.rs#TAX_RATE", // crate::pricing::TAX_RATE inside format!(..)
      "src/pricing.rs#calc_total",
      "src/util/money.rs#round",
    ]);
    const money = `use super::super::pricing::Item;\n\npub fn round(x: f64) -> f64 { x }\npub fn of(i: &Item) -> f64 { super::helper(i.price) }\n`;
    expect((await run(null, money, "src/util/money.rs")).reads).toEqual(["src/pricing.rs#Item", "src/util/mod.rs#helper"]);
    const lib = `mod pricing;\nmod util;\n\npub fn run() -> f64 { pricing::calc_total(&[]) + util::money::round(1.0) }\n`;
    expect((await run(null, lib, "src/lib.rs")).reads).toEqual(["src/pricing.rs#calc_total", "src/util/money.rs#round"]);
  });

  it("prefixes keys with the checkout's path in the repository", async () => {
    const r = await analyzeSource({ path: "src/lib.rs", before: "", after: "pub fn f() {}\n" }, { prefix: "crates/core/" });
    expect(r.writes).toEqual([{ key: "crates/core/src/lib.rs#f", kind: "new" }]);
  });

  it("deleting a file deletes its declarations", async () => {
    expect(await run("fn f() {}\n", null)).toEqual({ reads: [], writes: [{ key: "src/pricing.rs#f", kind: "deleted" }] });
  });

  it("stays inside the edit-time budget (< 300 ms for a 2,000-line file, warm)", async () => {
    const big = Array.from({ length: 40 }, (_, i) =>
      PRICING_V1.replace("use std::fmt;\n", "").replaceAll("calc_total", `calc_${i}`).replaceAll("Cart", `Cart${i}`).replaceAll("Item", `Item${i}`).replaceAll("Pricer", `Pricer${i}`).replaceAll("Discount", `Discount${i}`).replaceAll("TAX_RATE", `RATE_${i}`).replaceAll("format_price", `fmt_${i}`),
    ).join("\n");
    expect(big.split("\n").length).toBeGreaterThan(2000);
    await run(big, big);
    expect(await cpuMs(() => run(big, big.replace("pub fn calc_7(items: &[Item7])", "pub fn calc_7(items: &[Item7], x: u8)")))).toBeLessThan(EDIT_BUDGET_MS);
  });
});
