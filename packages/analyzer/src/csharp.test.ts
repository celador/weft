import { describe, expect, it } from "vitest";
import { analyzeSource, languageFor } from "./index.js";
import { clearModuleIndexCache } from "./moduleindex.js";

const PRICING = `namespace Shop.Pricing;

public record Item(decimal Price, int Qty);

public static class PriceCalculator
{
    public const decimal DefaultRate = 0.2m;

    public static decimal CalcTotal(IEnumerable<Item> items)
    {
        return items.Sum(i => i.Price * i.Qty);
    }

    public static string FormatPrice(decimal amount) => amount.ToString("C");
}
`;

const CART = `using Shop.Pricing;

namespace Shop.Cart
{
    public partial class Cart
    {
        private readonly List<Item> _items;

        public Cart(List<Item> items) { _items = items; }

        public decimal Total => PriceCalculator.CalcTotal(_items) + Tax();

        public List<Item> Items { get; } = new();

        public static Cart Empty() => new Cart(new List<Item>());
    }
}
`;

const CART_TAX = `namespace Shop.Cart;

public partial class Cart
{
    public decimal Tax() => this.Total * 0.2m;
}
`;

function checkout(files: Record<string, string>) {
  const list = (dir: string): string[] | undefined => {
    const prefix = dir ? `${dir}/` : "";
    const out = new Set<string>();
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf("/");
      out.add(slash < 0 ? rest : rest.slice(0, slash + 1));
    }
    return out.size ? [...out] : undefined;
  };
  return { exists: (rel: string) => rel in files || !!list(rel), list, read: (rel: string) => files[rel] };
}

const FILES: Record<string, string> = {
  "Shop.sln": "",
  "src/Shop/Shop.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />",
  "src/Shop/Pricing/PriceCalculator.cs": PRICING,
  "src/Shop/Cart/Cart.cs": CART,
  "src/Shop/Cart/Cart.Tax.cs": CART_TAX,
  "src/Legacy/Legacy.csproj": "",
  "src/Legacy/PriceCalculator.cs": "namespace Legacy.Pricing { public static class PriceCalculator { public static decimal CalcTotal(object items) => 0; } }\n",
};
const fs = checkout(FILES);
const PRICING_PATH = "src/Shop/Pricing/PriceCalculator.cs";
const run = (before: string | null, after: string | null, path = PRICING_PATH, opts: object = fs) => analyzeSource({ path, before, after }, opts);
const writes = async (before: string, after: string, path?: string) => (await run(before, after, path)).writes.map((w) => `${w.kind} ${w.key.replace(/^.*#/, "")}`);

describe("c# (tree-sitter backend)", () => {
  it("maps .cs to the tree-sitter backend", () => {
    expect(languageFor("src/Shop/Cart/Cart.cs")).toEqual({ id: "csharp", name: "C#", backend: "tree-sitter" });
  });

  it("lists every declaration of a new file, qualified by type, not namespace", async () => {
    expect(await writes("", PRICING)).toEqual([
      "new Item",
      "new PriceCalculator",
      "new PriceCalculator.CalcTotal",
      "new PriceCalculator.DefaultRate",
      "new PriceCalculator.FormatPrice",
    ]);
    expect(await writes("", CART, "src/Shop/Cart/Cart.cs")).toEqual(["new Cart", "new Cart._items", "new Cart.Empty", "new Cart.Items", "new Cart.new", "new Cart.Total"]);
  });

  it("tells a signature change from a body change (block and expression bodies)", async () => {
    const sig = PRICING.replace("CalcTotal(IEnumerable<Item> items)", "CalcTotal(IEnumerable<Item> items, decimal taxRate)");
    expect(await writes(PRICING, sig)).toEqual(["body PriceCalculator", "signature PriceCalculator.CalcTotal"]);
    const body = PRICING.replace("i.Price * i.Qty", "i.Price * i.Qty * 1m");
    expect(await writes(PRICING, body)).toEqual(["body PriceCalculator", "body PriceCalculator.CalcTotal"]);
    const arrow = PRICING.replace('ToString("C")', 'ToString("N2")');
    expect(await writes(PRICING, arrow)).toEqual(["body PriceCalculator", "body PriceCalculator.FormatPrice"]);
  });

  it("does not treat reformatting a signature as a signature change", async () => {
    const wrapped = PRICING.replace("CalcTotal(IEnumerable<Item> items)", "CalcTotal(\n        IEnumerable<Item> items\n    )");
    expect(await writes(PRICING, wrapped)).not.toContain("signature PriceCalculator.CalcTotal");
  });

  it("reports a rename as deleted + new", async () => {
    expect(await writes(PRICING, PRICING.replace("CalcTotal(", "ComputeTotal("))).toEqual([
      "body PriceCalculator",
      "deleted PriceCalculator.CalcTotal",
      "new PriceCalculator.ComputeTotal",
    ]);
  });

  it("properties: accessor list and type are signature; initializers and bodies are body", async () => {
    const p = "src/Shop/Cart/Cart.cs";
    expect(await writes(CART, CART.replace("{ get; } = new();", "{ get; set; } = new();"), p)).toEqual(["body Cart", "signature Cart.Items"]);
    expect(await writes(CART, CART.replace("+ Tax();", "+ Tax() + 1;"), p)).toEqual(["body Cart", "body Cart.Total"]);
    expect(await writes(PRICING, PRICING.replace("DefaultRate = 0.2m", "DefaultRate = 0.21m"))).toEqual(["body PriceCalculator", "body PriceCalculator.DefaultRate"]);
    expect(await writes(PRICING, PRICING.replace("record Item(decimal Price, int Qty)", "record Item(decimal Price, int Qty, string Sku)"))).toEqual(["signature Item"]);
  });

  it("reads local declarations: implicit this, this., types, constructors", async () => {
    const { reads } = await run(null, CART, "src/Shop/Cart/Cart.cs", {});
    expect(reads).toEqual(["src/Shop/Cart/Cart.cs#Cart", "src/Shop/Cart/Cart.cs#Cart._items", "src/Shop/Cart/Cart.cs#Cart.new"]);
  });

  it("reads other files through `using` namespaces (index of the solution), partial classes included", async () => {
    clearModuleIndexCache();
    const { reads } = await run(null, CART, "src/Shop/Cart/Cart.cs");
    expect(reads).toEqual([
      "src/Shop/Cart/Cart.Tax.cs#Cart.Tax",
      "src/Shop/Cart/Cart.cs#Cart",
      "src/Shop/Cart/Cart.cs#Cart._items",
      "src/Shop/Cart/Cart.cs#Cart.new",
      "src/Shop/Pricing/PriceCalculator.cs#Item",
      "src/Shop/Pricing/PriceCalculator.cs#PriceCalculator.CalcTotal",
    ]);
    expect((await run(null, CART_TAX, "src/Shop/Cart/Cart.Tax.cs")).reads).toEqual(["src/Shop/Cart/Cart.cs#Cart.Total"]);
  });

  it("namespaces pick the right type; qualified names, aliases and using static resolve", async () => {
    const legacy = `using Legacy.Pricing;\nclass A { decimal M() => PriceCalculator.CalcTotal(null); }\n`;
    expect((await run(null, legacy, "src/Shop/A.cs")).reads).toEqual(["src/Legacy/PriceCalculator.cs#PriceCalculator.CalcTotal"]);
    const qualified = `class A { decimal M() => Shop.Pricing.PriceCalculator.CalcTotal(null); }\n`;
    expect((await run(null, qualified, "src/Shop/A.cs")).reads).toEqual([`${PRICING_PATH}#PriceCalculator.CalcTotal`]);
    const relative = `namespace Shop.Cart { class A { decimal M() => Pricing.PriceCalculator.CalcTotal(null); } }\n`;
    expect((await run(null, relative, "src/Shop/A.cs")).reads).toEqual([`${PRICING_PATH}#PriceCalculator.CalcTotal`]);
    const alias = `using PC = Shop.Pricing.PriceCalculator;\nclass A { decimal M() => PC.CalcTotal(null); }\n`;
    expect((await run(null, alias, "src/Shop/A.cs")).reads).toEqual([`${PRICING_PATH}#PriceCalculator.CalcTotal`]);
    const statics = `using static Shop.Pricing.PriceCalculator;\nclass A { decimal M() => CalcTotal(null); }\n`;
    expect((await run(null, statics, "src/Shop/A.cs")).reads).toEqual([`${PRICING_PATH}#PriceCalculator.CalcTotal`]);
  });

  it("parameters, locals and lambda variables are not references", async () => {
    const src = `using Shop.Pricing;\nclass A { decimal M(decimal Tax, List<Item> items) { var CalcTotal = 1m; foreach (var FormatPrice in items) {} return Tax + CalcTotal + items.Sum(PriceCalculator => PriceCalculator.Price); } }\n`;
    expect((await run(null, src, "src/Shop/A.cs")).reads).toEqual([`${PRICING_PATH}#Item`]);
  });

  it("stays inside the edit-time budget (< 300 ms: 2,000-line file, and a 400-file solution)", async () => {
    const big = `namespace Big;\n${Array.from({ length: 140 }, (_, i) => PRICING.replace("namespace Shop.Pricing;\n", "").replaceAll("PriceCalculator", `Calc${i}`).replaceAll("Item", `Item${i}`)).join("\n")}`;
    expect(big.split("\n").length).toBeGreaterThan(2000);
    await run(big, big);
    let t = performance.now();
    await run(big, big.replace("Calc7.CalcTotal", "x").replace("CalcTotal(IEnumerable<Item7> items)", "CalcTotal(IEnumerable<Item7> items, int x)"));
    expect(performance.now() - t).toBeLessThan(300);

    const files: Record<string, string> = { "Big.sln": "" };
    for (let i = 0; i < 400; i++) files[`src/F${i}.cs`] = PRICING.replace("Shop.Pricing", "Big").replaceAll("PriceCalculator", `Calc${i}`).replaceAll("Item", `Item${i}`);
    const bigFs = checkout(files);
    const user = `namespace Big;\nclass Use { decimal M() => Calc399.CalcTotal(new List<Item12>()); }\n`;
    clearModuleIndexCache();
    t = performance.now();
    const cold = await run(null, user, "src/Use.cs", bigFs);
    expect(performance.now() - t).toBeLessThan(300);
    expect(cold.reads).toEqual(["src/F12.cs#Item12", "src/F399.cs#Calc399.CalcTotal"]);
  });
});
