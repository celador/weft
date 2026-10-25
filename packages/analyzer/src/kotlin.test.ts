import { describe, expect, it } from "vitest";
import { cpuMs, EDIT_BUDGET_MS, fastestCpuMs } from "./budget.js";
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
    expect(await fastestCpuMs(() => run(big, big.replace("calc7(items: List<Item>)", "calc7(items: List<Item>, x: Int)")))).toBeLessThan(EDIT_BUDGET_MS);
  });
});

// A checkout with read/list, for the package index (same-package names) and JVM facades.
const K = "src/main/kotlin/com/shop/pricing";
const J = "src/main/java/com/shop/pricing";
const pkgCheckout: Record<string, string> = {
  [`${K}/Pricing.kt`]: `package com.shop.pricing\n\nfun calcTotal(items: List<Double>): Double = items.sum()\n\nconst val TAX_RATE = 0.2\n\nprivate fun secret(): Int = 1\n\nfun Cart.discount(pct: Int): Double = 0.0\n`,
  [`${K}/Values.kt`]: `package com.shop.pricing\n\ndata class Money(val cents: Long)\n\nval <T> List<T>.second: T get() = this[1]\n`,
  [`${K}/Cart.kt`]: `package com.shop.pricing\n\nclass Cart(val items: List<Double>)\n`,
  [`${K}/Other.kt`]: `package com.shop.other\n\nfun stray(): Int = 0\n`,
  [`${K}/Fmt.kt`]: `@file:JvmName("PriceFormat")\npackage com.shop.pricing\n\nfun formatPrice(d: Double): String = "$" + d\n`,
  [`${J}/Invoice.java`]: `package com.shop.pricing;\n\npublic class Invoice {}\n`,
  "src/main/java/com/shop/real/HelperKt.java": `package com.shop.real;\n\npublic class HelperKt { public static int calcTotal() { return 1; } }\n`,
  "src/main/kotlin/com/shop/real/Helper.kt": `package com.shop.real\n\nfun calcTotal(): Int = 2\n`,
};
const pkgOpts = {
  exists: (rel: string) => rel in pkgCheckout,
  read: (rel: string) => pkgCheckout[rel],
  list: (dir: string) => {
    const prefix = dir ? `${dir}/` : "";
    const out = new Set<string>();
    for (const f of Object.keys(pkgCheckout)) if (f.startsWith(prefix)) out.add(f.slice(prefix.length).replace(/\/.*$/, "/"));
    return out.size ? [...out] : undefined;
  },
};
const readsOf = async (path: string, after: string, opts: object = pkgOpts) => (await analyzeSource({ path, before: null, after }, opts)).reads;

describe("kotlin: same-package declarations in other files (package index)", () => {
  it("reads a top-level function, property and extension of another file of the package, with no import", async () => {
    const src = `package com.shop.pricing\n\nfun checkout(cart: Cart): Double {\n    return calcTotal(cart.items) * TAX_RATE + cart.discount(5)\n}\n`;
    expect(await readsOf(`${K}/Checkout.kt`, src)).toEqual([
      `${K}/Cart.kt#Cart`,
      `${K}/Pricing.kt#TAX_RATE`,
      `${K}/Pricing.kt#calcTotal`,
      `${K}/Pricing.kt#discount`,
    ]);
  });

  it("finds a class declared in a file not named after it", async () => {
    const src = `package com.shop.pricing\n\nfun zero(): Money = Money(0)\n`;
    expect(await readsOf(`${K}/Zero.kt`, src)).toEqual([`${K}/Values.kt#Money`]);
  });

  it("skips private declarations, files of another package, and names the file declares or imports itself", async () => {
    const src = `package com.shop.pricing\n\nimport com.acme.lib.calcTotal\n\nfun formatPrice(d: Double) = d\n\nfun f() = secret() + stray() + calcTotal(listOf()) + formatPrice(1.0)\n`;
    expect(await readsOf(`${K}/F.kt`, src)).toEqual([`${K}/F.kt#formatPrice`]);
  });

  it("a peer's signature change reaches the same-package caller's key", async () => {
    const before = pkgCheckout[`${K}/Pricing.kt`]!;
    const after = before.replace("fun calcTotal(items: List<Double>)", "fun calcTotal(items: List<Double>, rate: Double)");
    const { writes } = await analyzeSource({ path: `${K}/Pricing.kt`, before, after }, pkgOpts);
    expect(writes).toEqual([{ key: `${K}/Pricing.kt#calcTotal`, kind: "signature" }]);
    expect(await readsOf(`${K}/Checkout.kt`, `package com.shop.pricing\n\nfun f() = calcTotal(listOf())\n`)).toContain(`${K}/Pricing.kt#calcTotal`);
  });

  it("without read/list only same-file and import reads are found", async () => {
    const src = `package com.shop.pricing\n\nfun f() = calcTotal(listOf())\n`;
    expect(await readsOf(`${K}/F.kt`, src, { exists: pkgOpts.exists })).toEqual([]);
  });
});

describe("java -> kotlin facades (`FooKt`, @file:JvmName)", () => {
  it("PricingKt.calcTotal() through an import reads the Kotlin file's top-level key", async () => {
    const src = `package com.shop.billing;\n\nimport com.shop.pricing.PricingKt;\n\nclass Bill {\n    double total() { return PricingKt.calcTotal(java.util.List.of()) * PricingKt.TAX_RATE; }\n}\n`;
    expect(await readsOf("src/main/java/com/shop/billing/Bill.java", src)).toEqual([`${K}/Pricing.kt#TAX_RATE`, `${K}/Pricing.kt#calcTotal`]);
  });

  it("a static import of a facade member reads the member", async () => {
    const src = `package com.shop.billing;\n\nimport static com.shop.pricing.PricingKt.calcTotal;\n\nclass Bill {\n    double total() { return calcTotal(java.util.List.of()); }\n}\n`;
    expect(await readsOf("src/main/java/com/shop/billing/Bill.java", src)).toEqual([`${K}/Pricing.kt#calcTotal`]);
  });

  it("same package, no import, Kotlin under src/main/kotlin and Java under src/main/java", async () => {
    const src = `package com.shop.pricing;\n\nclass Bill {\n    double total() { return PricingKt.calcTotal(java.util.List.of()); }\n}\n`;
    expect(await readsOf(`${J}/Bill.java`, src)).toEqual([`${K}/Pricing.kt#calcTotal`]);
  });

  it("@file:JvmName names the facade, and the default FooKt name no longer applies", async () => {
    const renamed = `package com.shop.billing;\n\nimport com.shop.pricing.PriceFormat;\n\nclass Bill {\n    String s() { return PriceFormat.formatPrice(1.0); }\n}\n`;
    expect(await readsOf("src/main/java/com/shop/billing/Bill.java", renamed)).toEqual([`${K}/Fmt.kt#formatPrice`]);
    const stale = `package com.shop.billing;\n\nimport com.shop.pricing.FmtKt;\n\nclass Bill {\n    String s() { return FmtKt.formatPrice(1.0); }\n}\n`;
    expect(await readsOf("src/main/java/com/shop/billing/Bill.java", stale)).not.toContain(`${K}/Fmt.kt#formatPrice`);
  });

  it("a real class named like a facade wins", async () => {
    const src = `package com.shop.billing;\n\nimport com.shop.real.HelperKt;\n\nclass Bill {\n    int t() { return HelperKt.calcTotal(); }\n}\n`;
    expect(await readsOf("src/main/java/com/shop/billing/Bill.java", src)).toEqual([
      "src/main/java/com/shop/real/HelperKt.java#HelperKt",
      "src/main/java/com/shop/real/HelperKt.java#HelperKt.calcTotal",
    ]);
  });

  it("stays inside the edit-time budget with a 300-file package (< 300 ms CPU, warm)", async () => {
    const big: Record<string, string> = { ...pkgCheckout };
    for (let i = 0; i < 300; i++) big[`${K}/Gen${i}.kt`] = `package com.shop.pricing\n\n` + Array.from({ length: 20 }, (_, j) => `fun gen${i}_${j}(x: Int): Int = x + ${j}\n`).join("");
    const opts = {
      exists: (rel: string) => rel in big,
      read: (rel: string) => big[rel],
      list: (dir: string) => Object.keys(big).filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")).map((f) => f.slice(dir.length + 1)),
    };
    const src = `package com.shop.pricing\n\nfun f(cart: Cart) = calcTotal(cart.items) + gen7_3(1) + gen250_19(2)\n`;
    await analyzeSource({ path: `${K}/F.kt`, before: null, after: src }, opts);
    let reads: string[] = [];
    const ms = await cpuMs(async () => {
      reads = (await analyzeSource({ path: `${K}/F.kt`, before: src, after: src.replace("+ gen7_3(1)", "+ gen7_3(3)") }, opts)).reads;
    });
    expect(reads).toContain(`${K}/Gen250.kt#gen250_19`);
    expect(ms).toBeLessThan(EDIT_BUDGET_MS);
  });
});
