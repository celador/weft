import { describe, expect, it } from "vitest";
import { analyzeSource, languageFor } from "./index.js";
import { underscore } from "./languages/ruby.js";

const PRICING_V1 = `module Pricing
  TAX_RATE = 0.2

  def self.calc_total(items)
    items.sum { |i| i.price * i.qty }
  end

  def self.format_price(amount)
    format("$%.2f", amount)
  end
end

class Cart
  attr_reader :items

  def initialize(items)
    @items = items
  end

  def total
    Pricing.calc_total(items) + tax
  end

  def tax
    0.0
  end
end
`;

const files = new Set([
  "lib/pricing.rb",
  "lib/cart.rb",
  "lib/shop/money.rb",
  "lib/shop.rb",
  "app/models/user.rb",
  "app/models/billing/invoice.rb",
  "app/services/checkout.rb",
]);
const exists = (rel: string) => files.has(rel);
const run = (before: string | null, after: string | null, path = "lib/pricing.rb") => analyzeSource({ path, before, after }, { exists });
const writes = async (before: string, after: string) => (await run(before, after)).writes.map((w) => `${w.kind} ${w.key}`);

describe("ruby (tree-sitter backend)", () => {
  it("maps paths to the backend", () => {
    expect(languageFor("lib/a.rb")).toEqual({ id: "ruby", name: "Ruby", backend: "tree-sitter" });
    expect(languageFor("Rakefile.rake")?.id).toBe("ruby");
  });

  it("lists every declaration of a new file as new, qualified by module/class", async () => {
    expect(await writes("", PRICING_V1)).toEqual([
      "new lib/pricing.rb#Cart",
      "new lib/pricing.rb#Cart.initialize",
      "new lib/pricing.rb#Cart.items",
      "new lib/pricing.rb#Cart.tax",
      "new lib/pricing.rb#Cart.total",
      "new lib/pricing.rb#Pricing",
      "new lib/pricing.rb#Pricing.calc_total",
      "new lib/pricing.rb#Pricing.format_price",
      "new lib/pricing.rb#Pricing.TAX_RATE",
    ]);
  });

  it("tells a signature change from a body change", async () => {
    const sig = PRICING_V1.replace("def self.calc_total(items)", "def self.calc_total(items, tax_rate:)");
    expect(await writes(PRICING_V1, sig)).toEqual(["body lib/pricing.rb#Pricing", "signature lib/pricing.rb#Pricing.calc_total"]);
    const body = PRICING_V1.replace("items.sum { |i| i.price * i.qty }", "items.sum { |i| i.price * i.qty }.round(2)");
    expect(await writes(PRICING_V1, body)).toEqual(["body lib/pricing.rb#Pricing", "body lib/pricing.rb#Pricing.calc_total"]);
  });

  it("does not treat reformatting a signature as a signature change", async () => {
    const wrapped = PRICING_V1.replace("def self.calc_total(items)", "def self.calc_total(\n    items\n  )");
    expect(await writes(PRICING_V1, wrapped)).not.toContain("signature lib/pricing.rb#Pricing.calc_total");
  });

  it("access modifiers, superclasses and attribute kinds are signature", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("  def tax\n", "  private def tax\n"))).toContain("signature lib/pricing.rb#Cart.tax");
    expect(await writes(PRICING_V1, PRICING_V1.replace("class Cart\n", "class Cart < Base\n"))).toEqual(["signature lib/pricing.rb#Cart"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("attr_reader :items", "attr_accessor :items"))).toEqual([
      "body lib/pricing.rb#Cart",
      "signature lib/pricing.rb#Cart.items",
    ]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("TAX_RATE = 0.2", "TAX_RATE = 0.21"))).toEqual([
      "body lib/pricing.rb#Pricing",
      "body lib/pricing.rb#Pricing.TAX_RATE",
    ]);
  });

  it("reports a rename as deleted + new", async () => {
    const after = PRICING_V1.replaceAll("format_price", "format_money");
    expect(await writes(PRICING_V1, after)).toEqual([
      "body lib/pricing.rb#Pricing",
      "new lib/pricing.rb#Pricing.format_money",
      "deleted lib/pricing.rb#Pricing.format_price",
    ]);
  });

  it("merges a reopened class into one key; def self.x and class << self are Class.x", async () => {
    const src = `class Cart\n  def a; end\nend\n\nclass Cart\n  def self.b; end\n  class << self\n    def c(x); end\n  end\nend\n\nclass Shop::Order\nend\n`;
    expect(await writes("", src)).toEqual([
      "new lib/pricing.rb#Cart",
      "new lib/pricing.rb#Cart.a",
      "new lib/pricing.rb#Cart.b",
      "new lib/pricing.rb#Cart.c",
      "new lib/pricing.rb#Shop.Order",
    ]);
    expect(await writes(src, src.replace("def c(x)", "def c(x, y)"))).toEqual(["body lib/pricing.rb#Cart", "signature lib/pricing.rb#Cart.c"]);
  });

  it("reads local constant calls, receiver-less and self calls, attributes, not local variables", async () => {
    const { reads } = await run(null, PRICING_V1);
    expect(reads).toEqual(["lib/pricing.rb#Cart.items", "lib/pricing.rb#Cart.tax", "lib/pricing.rb#Pricing", "lib/pricing.rb#Pricing.calc_total"]);
  });

  it("reads constants from required files, lib/ and Rails autoload paths, with lexical nesting", async () => {
    const checkout = `require_relative "pricing"
require "shop/money"

module Shop
  class Checkout
    def run(items, user_id)
      user = User.find(user_id)
      inv = Billing::Invoice.new(user)
      Pricing.calc_total(items) + Money.fmt(1) + JSON.parse("1")
    end
  end
end
`;
    const { reads, writes: w } = await run(null, checkout, "app/services/checkout.rb");
    expect(w.map((x) => x.key)).toEqual(["app/services/checkout.rb#Shop", "app/services/checkout.rb#Shop.Checkout", "app/services/checkout.rb#Shop.Checkout.run"]);
    expect(reads).toEqual([
      "app/models/billing/invoice.rb#Billing.Invoice",
      "app/models/billing/invoice.rb#Billing.Invoice.initialize",
      "app/models/user.rb#User",
      "app/models/user.rb#User.find",
      "lib/pricing.rb#Pricing", // not next to the file; found under lib/ by name
      "lib/pricing.rb#Pricing.calc_total",
      "lib/shop/money.rb#Shop.Money", // `Money` inside `module Shop`
      "lib/shop/money.rb#Shop.Money.fmt",
    ]);
    // require_relative is relative to the file: from lib/cart.rb, "pricing" is lib/pricing.rb.
    const cart = `require_relative "pricing"\n\nclass Basket\n  def total(items)\n    Pricing.calc_total(items)\n  end\nend\n`;
    expect((await run(null, cart, "lib/cart.rb")).reads).toEqual(["lib/pricing.rb#Pricing", "lib/pricing.rb#Pricing.calc_total"]);
  });

  it("inflects constant names like Zeitwerk", () => {
    expect(underscore("HTTPClient")).toBe("http_client");
    expect(underscore("Money")).toBe("money");
    expect(underscore("OAuth2Token")).toBe("o_auth2_token");
  });

  it("prefixes keys with the checkout's path in the repository", async () => {
    const r = await analyzeSource({ path: "lib/x.rb", before: "", after: "def f\n  1\nend\n" }, { prefix: "svc/" });
    expect(r.writes).toEqual([{ key: "svc/lib/x.rb#f", kind: "new" }]);
  });

  it("deleting a file deletes its declarations", async () => {
    expect(await run("def f\nend\n", null)).toEqual({ reads: [], writes: [{ key: "lib/pricing.rb#f", kind: "deleted" }] });
  });

  it("stays inside the edit-time budget (< 300 ms for a 2,000-line file, warm)", async () => {
    const big = Array.from({ length: 72 }, (_, i) => PRICING_V1.replaceAll("Pricing", `Pricing${i}`).replaceAll("Cart", `Cart${i}`)).join("\n");
    expect(big.split("\n").length).toBeGreaterThanOrEqual(2000);
    await run(big, big);
    const t = performance.now();
    await run(big, big.replace("def self.calc_total(items)", "def self.calc_total(items, x)"));
    expect(performance.now() - t).toBeLessThan(300);
  });
});
