import { describe, expect, it } from "vitest";
import { cpuMs, EDIT_BUDGET_MS } from "./budget.js";
import { analyzeSource, languageFor } from "./index.js";

const PRICING_V1 = `package com.shop.pricing

import com.shop.model.Item

const val TAX_RATE: Double = 0.2

// Sum of price times quantity.
fun calcTotal(items: List<Item>): Double {
    return items.sumOf { it.price * it.qty }
}

fun Cart.discount(pct: Int): Double = total() * pct / 100

data class Cart(val items: List<Item>, var note: String = "") {
    fun total(): Double = calcTotal(items) + this.tax()

    private fun tax(): Double = calcTotal(items) * TAX_RATE

    companion object {
        fun empty(): Cart = Cart(emptyList())
    }
}

object Registry {
    val carts = mutableListOf<Cart>()
}

enum class Kind {
    RETAIL,
    WHOLESALE,
}
`;

const P = "src/main/kotlin/com/shop/pricing/Pricing.kt";
const files = new Set([
  P,
  "src/main/java/com/shop/model/Item.java",
  "src/main/kotlin/com/shop/pricing/Promo.kt",
  "src/main/kotlin/com/shop/cart/CartView.kt",
  "src/main/kotlin/com/shop/util/Fmt.kt",
]);
const exists = (rel: string) => files.has(rel);
const run = (before: string | null, after: string | null, path = P) => analyzeSource({ path, before, after }, { exists });
const writes = async (before: string, after: string) => (await run(before, after)).writes.map((w) => `${w.kind} ${w.key.split("#")[1]}`);

describe("kotlin (tree-sitter backend)", () => {
  it("maps .kt and .kts to the Kotlin spec", () => {
    expect(languageFor("a/B.kt")).toEqual({ id: "kotlin", name: "Kotlin", backend: "tree-sitter" });
    expect(languageFor("build.gradle.kts")?.id).toBe("kotlin");
  });

  it("lists every declaration of a new file as new; companion members by class, extensions by name", async () => {
    expect(await writes("", PRICING_V1)).toEqual([
      "new calcTotal",
      "new Cart",
      "new Cart.empty",
      "new Cart.items",
      "new Cart.note",
      "new Cart.tax",
      "new Cart.total",
      "new discount",
      "new Kind",
      "new Kind.RETAIL",
      "new Kind.WHOLESALE",
      "new Registry",
      "new Registry.carts",
      "new TAX_RATE",
    ]);
  });

  it("tells a signature change from a body change", async () => {
    const sig = PRICING_V1.replace("fun calcTotal(items: List<Item>): Double {", "fun calcTotal(items: List<Item>, taxRate: Double): Double {");
    expect(await writes(PRICING_V1, sig)).toEqual(["signature calcTotal"]);
    const body = PRICING_V1.replace("return items.sumOf { it.price * it.qty }", "return items.sumOf { it.price * it.qty }.coerceAtLeast(0.0)");
    expect(await writes(PRICING_V1, body)).toEqual(["body calcTotal"]);
    const expr = PRICING_V1.replace("= total() * pct / 100", "= total() * pct / 100.0");
    expect(await writes(PRICING_V1, expr)).toEqual(["body discount"]);
  });

  it("does not treat reformatting, comments or @Deprecated as a signature change", async () => {
    const wrapped = PRICING_V1.replace("fun calcTotal(items: List<Item>): Double {", "fun calcTotal(\n    items: List<Item>,\n): Double {");
    expect(await writes(PRICING_V1, wrapped)).toEqual([]);
    const annotated = PRICING_V1.replace("    fun total(): Double", "    /** The total. */\n    @Deprecated(\"use sum\")\n    fun total(): Double");
    expect(await writes(PRICING_V1, annotated)).not.toContain("signature Cart.total");
  });

  it("@JvmStatic, receivers and val/var are part of the signature", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("        fun empty()", "        @JvmStatic\n        fun empty()"))).toContain("signature Cart.empty");
    expect(await writes(PRICING_V1, PRICING_V1.replace("fun Cart.discount(", "fun Registry.discount("))).toEqual(["signature discount"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("    val carts =", "    var carts ="))).toEqual(["body Registry", "signature Registry.carts"]);
  });

  it("a primary-constructor change is a signature change of the class and its property", async () => {
    const after = PRICING_V1.replace("data class Cart(val items: List<Item>,", "data class Cart(val items: Collection<Item>,");
    expect(await writes(PRICING_V1, after)).toEqual(["signature Cart", "signature Cart.items"]);
    // A default value is the parameter's body.
    expect(await writes(PRICING_V1, PRICING_V1.replace('var note: String = ""', 'var note: String = "-"'))).toEqual(["signature Cart", "body Cart.note"]);
  });

  it("a property's type is its signature, its initializer its body", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("TAX_RATE: Double = 0.2", "TAX_RATE: Double = 0.21"))).toEqual(["body TAX_RATE"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("TAX_RATE: Double = 0.2", "TAX_RATE: Float = 0.2f"))).toEqual(["signature TAX_RATE"]);
  });

  it("reports a rename as deleted + new", async () => {
    const after = PRICING_V1.replaceAll("calcTotal", "computeTotal");
    expect(await writes(PRICING_V1, after)).toEqual([
      "deleted calcTotal",
      "body Cart",
      "body Cart.tax",
      "body Cart.total",
      "new computeTotal",
    ]);
  });

  it("reads local calls, this-calls, companion calls, extension receivers and type uses", async () => {
    const { reads } = await run(null, PRICING_V1);
    expect(reads).toEqual([
      "src/main/java/com/shop/model/Item.java#Item",
      `${P}#Cart`,
      `${P}#Cart.items`,
      `${P}#Cart.tax`,
      `${P}#Cart.total`,
      `${P}#TAX_RATE`,
      `${P}#calcTotal`,
    ]);
  });

  it("reads imported Kotlin and Java declarations: classes, top-level functions, extensions, aliases, wildcards", async () => {
    const view = `package com.shop.cart

import com.shop.model.Item
import com.shop.pricing.Cart
import com.shop.pricing.calcTotal
import com.shop.pricing.discount
import com.shop.pricing.Kind as PriceKind
import com.shop.util.*
import kotlinx.coroutines.flow.Flow

fun render(items: List<Item>): String {
    val cart = Cart.empty()
    return money(calcTotal(items)) + cart.discount(10) + PriceKind.RETAIL + Fmt.SEP
}
`;
    const { reads, writes: w } = await run(null, view, "src/main/kotlin/com/shop/cart/CartView.kt");
    expect(w.map((x) => x.key)).toEqual(["src/main/kotlin/com/shop/cart/CartView.kt#render"]);
    expect(reads).toEqual([
      "src/main/java/com/shop/model/Item.java#Item",
      `${P}#Cart`,
      `${P}#Cart.empty`,
      `${P}#Kind`,
      `${P}#Kind.RETAIL`,
      `${P}#calcTotal`,
      `${P}#discount`,
      "src/main/kotlin/com/shop/util/Fmt.kt#Fmt",
      "src/main/kotlin/com/shop/util/Fmt.kt#Fmt.SEP",
    ]);
  });

  it("resolves classes of its own package without an import", async () => {
    const src = `package com.shop.pricing\n\nfun best(): Double = Promo.NONE\n`;
    const { reads } = await run(null, src, "src/main/kotlin/com/shop/pricing/Best.kt");
    expect(reads).toEqual(["src/main/kotlin/com/shop/pricing/Promo.kt#Promo", "src/main/kotlin/com/shop/pricing/Promo.kt#Promo.NONE"]);
  });

  it("a top-level import never resolves to a Java class file", async () => {
    const both = new Set(["src/main/java/com/shop/util/Util.java"]);
    const src = `package a\n\nimport com.shop.util.helper\n\nfun f() = helper()\n`;
    const r = await analyzeSource({ path: "src/main/kotlin/a/F.kt", before: null, after: src }, { exists: (p) => both.has(p) });
    expect(r.reads).toEqual([]);
  });

  it("deleting a file deletes its declarations", async () => {
    const r = await run("fun f() = 1\n", null);
    expect(r).toEqual({ reads: [], writes: [{ key: `${P}#f`, kind: "deleted" }] });
  });

  it("stays inside the edit-time budget (< 300 ms CPU for a 2,000-line file, warm)", async () => {
    const big = Array.from({ length: 70 }, (_, i) =>
      PRICING_V1.replace(/^(package|import) .*\n/gm, "").replaceAll("calcTotal", `calc${i}`).replaceAll("Cart", `Cart${i}`).replaceAll("Registry", `Registry${i}`).replaceAll("Kind", `Kind${i}`).replaceAll("TAX_RATE", `TAX_${i}`).replaceAll("discount", `discount${i}`),
    ).join("\n");
    expect(big.split("\n").length).toBeGreaterThan(2000);
    await run(big, big);
    expect(await cpuMs(() => run(big, big.replace("calc7(items: List<Item>)", "calc7(items: List<Item>, x: Int)")))).toBeLessThan(EDIT_BUDGET_MS);
  });
});
