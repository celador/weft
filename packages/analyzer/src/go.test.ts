import { describe, expect, it } from "vitest";
import { EDIT_BUDGET_MS, fastestCpuMs } from "./budget.js";
import { analyzeSource, languageFor } from "./index.js";

const PRICING_V1 = `package pricing

import "fmt"

// TaxRate is the default rate.
const TaxRate float64 = 0.2

type Item struct {
	Price float64
	Qty   int
}

type Pricer interface {
	Price(items []Item) float64
}

func CalcTotal(items []Item) float64 {
	total := 0.0
	for _, i := range items {
		total += i.Price * float64(i.Qty)
	}
	return total
}

func FormatPrice(amount float64) string {
	return fmt.Sprintf("$%.2f", amount)
}

type Cart struct {
	Items []Item
}

func (c *Cart) Total() float64 {
	return CalcTotal(c.Items) + c.Tax()
}
`;

const CART_TAX = `package pricing

func (c *Cart) Tax() float64 {
	return 0
}

func newCart(items []Item) *Cart {
	return &Cart{Items: items}
}
`;

/** An in-memory checkout: a go.mod, package shop/pricing (two files + an external test), package shop/cart. */
const checkout: Record<string, string> = {
  "go.mod": "module example.com/shop\n\ngo 1.22\n",
  "pricing/pricing.go": PRICING_V1,
  "pricing/cart.go": CART_TAX,
  "pricing/pricing_test.go": "package pricing_test\n\nfunc CalcTotal() {}\n",
  "pricing-v2/v2.go": "package pricev2\n\nfunc Quote() float64 { return 1 }\n",
  "cart/cart.go": "package cart\n",
};
const opts = {
  exists: (rel: string) => rel in checkout,
  read: (rel: string) => checkout[rel],
  list: (dir: string) => {
    const prefix = dir ? `${dir}/` : "";
    const out = new Set<string>();
    for (const f of Object.keys(checkout)) if (f.startsWith(prefix)) out.add(f.slice(prefix.length).replace(/\/.*$/, "/"));
    return out.size ? [...out] : undefined;
  },
};
const run = (before: string | null, after: string | null, path = "pricing/pricing.go") => analyzeSource({ path, before, after }, opts);
const writes = async (before: string, after: string, path?: string) => (await run(before, after, path)).writes.map((w) => `${w.kind} ${w.key}`);

describe("go (tree-sitter backend)", () => {
  it("maps .go to the Go backend", () => {
    expect(languageFor("cmd/main.go")).toEqual({ id: "go", name: "Go", backend: "tree-sitter" });
  });

  it("lists every declaration of a new file as new, methods qualified by receiver type", async () => {
    expect(await writes("", PRICING_V1)).toEqual([
      "new pricing/pricing.go#CalcTotal",
      "new pricing/pricing.go#Cart",
      "new pricing/pricing.go#Cart.Total",
      "new pricing/pricing.go#FormatPrice",
      "new pricing/pricing.go#Item",
      "new pricing/pricing.go#Pricer",
      "new pricing/pricing.go#TaxRate",
    ]);
  });

  it("tells a signature change from a body change", async () => {
    const sig = PRICING_V1.replace("func CalcTotal(items []Item) float64 {", "func CalcTotal(items []Item, taxRate float64) float64 {");
    expect(await writes(PRICING_V1, sig)).toEqual(["signature pricing/pricing.go#CalcTotal"]);
    const body = PRICING_V1.replace("return total\n", "return total * 1.0\n");
    expect(await writes(PRICING_V1, body)).toEqual(["body pricing/pricing.go#CalcTotal"]);
    const recv = PRICING_V1.replace("func (c *Cart) Total()", "func (c Cart) Total()");
    expect(await writes(PRICING_V1, recv)).toEqual(["signature pricing/pricing.go#Cart.Total"]);
  });

  it("a struct field or interface method change is a signature change of the type", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("\tQty   int\n", "\tQty   int\n\tSKU   string\n"))).toEqual(["signature pricing/pricing.go#Item"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("Price(items []Item) float64\n}", "Price(items []Item) (float64, error)\n}"))).toEqual(["signature pricing/pricing.go#Pricer"]);
  });

  it("a const's type is its signature, its value the body", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("TaxRate float64 = 0.2", "TaxRate float64 = 0.21"))).toEqual(["body pricing/pricing.go#TaxRate"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("TaxRate float64 = 0.2", "TaxRate float32 = 0.2"))).toEqual(["signature pricing/pricing.go#TaxRate"]);
  });

  it("does not treat reformatting (gofmt, wrapped parameters, trailing comma) as a signature change", async () => {
    const wrapped = PRICING_V1.replace("func CalcTotal(items []Item) float64 {", "func CalcTotal(\n\titems []Item,\n) float64 {");
    expect(await writes(PRICING_V1, wrapped)).not.toContain("signature pricing/pricing.go#CalcTotal");
    const aligned = PRICING_V1.replace("\tPrice float64\n\tQty   int\n", "\tPrice    float64\n\tQty      int\n");
    expect(await writes(PRICING_V1, aligned)).not.toContain("signature pricing/pricing.go#Item");
  });

  it("reports a rename as deleted + new", async () => {
    const after = PRICING_V1.replaceAll("FormatPrice", "FormatMoney");
    expect(await writes(PRICING_V1, after)).toEqual(["new pricing/pricing.go#FormatMoney", "deleted pricing/pricing.go#FormatPrice"]);
  });

  it("reads same-file calls, types, receiver method calls, and other files of its own package", async () => {
    const { reads } = await run(null, PRICING_V1);
    // Cart.Tax is declared in pricing/cart.go (same package); fmt is the stdlib.
    expect(reads).toEqual([
      "pricing/cart.go#Cart.Tax",
      "pricing/pricing.go#CalcTotal",
      "pricing/pricing.go#Cart",
      "pricing/pricing.go#Item",
    ]);
    const other = await run(CART_TAX, CART_TAX.replace("return 0\n", "return CalcTotal(nil) * TaxRate\n"), "pricing/cart.go");
    expect(other.writes).toEqual([{ key: "pricing/cart.go#Cart.Tax", kind: "body" }]);
    // Cart, Item and CalcTotal live in pricing.go; the external test package's CalcTotal
    // (pricing_test.go, `package pricing_test`) is not this package's.
    expect(other.reads).toEqual(["pricing/pricing.go#CalcTotal", "pricing/pricing.go#Cart", "pricing/pricing.go#Item"]);
  });

  it("reads imported package members through go.mod, keyed by the declaring file", async () => {
    const cart = `package cart

import (
	"fmt"
	"example.com/shop/pricing"
	p2 "example.com/shop/pricing"
	"example.com/shop/pricing-v2"
	"github.com/other/lib"
)

func Summary(items []pricing.Item) string {
	c := &p2.Cart{Items: items}
	return fmt.Sprint(pricing.CalcTotal(items), c.Total(), pricev2.Quote(), lib.X())
}
`;
    const r = await run("package cart\n", cart, "cart/cart.go");
    expect(r.writes).toEqual([{ key: "cart/cart.go#Summary", kind: "new" }]);
    expect(r.reads).toEqual([
      "pricing-v2/v2.go#Quote", // binds `pricev2`, the package the directory declares
      "pricing/pricing.go#CalcTotal",
      "pricing/pricing.go#Cart",
      "pricing/pricing.go#Item",
    ]);
  });

  it("without read/list, only same-file reads are found", async () => {
    const r = await analyzeSource({ path: "pricing/pricing.go", before: null, after: PRICING_V1 }, { exists: opts.exists });
    expect(r.reads).toEqual(["pricing/pricing.go#CalcTotal", "pricing/pricing.go#Cart", "pricing/pricing.go#Item"]);
  });

  it("deleting a file deletes its declarations", async () => {
    expect(await run("package x\n\nfunc F() {}\n", null)).toEqual({ reads: [], writes: [{ key: "pricing/pricing.go#F", kind: "deleted" }] });
  });

  it("stays inside the edit-time budget (< 300 ms for a 2,000-line file in a 20-file package, warm)", async () => {
    const body = PRICING_V1.split("\n").slice(2).join("\n");
    const big = `package pricing\n\nimport "fmt"\n${Array.from({ length: 64 }, (_, i) => body.replace('import "fmt"\n', "").replaceAll("CalcTotal", `Calc${i}`).replaceAll("Cart", `Cart${i}`).replaceAll("Item", `Item${i}`).replaceAll("Pricer", `Pricer${i}`).replaceAll("TaxRate", `Rate${i}`).replaceAll("FormatPrice", `Fmt${i}`)).join("\n")}`;
    expect(big.split("\n").length).toBeGreaterThan(2000);
    const files: Record<string, string> = { "go.mod": "module example.com/big\n" };
    for (let f = 0; f < 20; f++) files[`big/f${f}.go`] = big.replaceAll(/\b(Calc|Cart|Item|Pricer|Rate|Fmt)(\d+)/g, `$1$2_${f}`);
    const bigOpts = {
      exists: (rel: string) => rel in files,
      read: (rel: string) => files[rel],
      list: (dir: string) => Object.keys(files).filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    };
    const edit = () => analyzeSource({ path: "big/main.go", before: big, after: big.replace("func Calc7(items []Item7)", "func Calc7(items []Item7, x int)") }, bigOpts);
    await edit();
    expect(await fastestCpuMs(edit)).toBeLessThan(EDIT_BUDGET_MS);
  });
});
