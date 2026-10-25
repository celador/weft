import { describe, expect, it } from "vitest";
import { EDIT_BUDGET_MS, fastestCpuMs } from "./budget.js";
import { analyzeSource, languageFor } from "./index.js";

const PRICING_V1 = `package com.shop.pricing;

import java.util.List;
import com.shop.model.Item;

/** Prices carts. */
public class Pricing {
    public static final double TAX_RATE = 0.2;
    private final List<Item> items;

    public Pricing(List<Item> items) {
        this.items = items;
    }

    public static double calcTotal(List<Item> items) {
        double sum = 0;
        for (Item i : items) sum += i.price * i.qty;
        return sum;
    }

    public double total() {
        return calcTotal(items) + this.tax();
    }

    double tax() {
        return total() * TAX_RATE;
    }

    public enum Kind { RETAIL, WHOLESALE }
}
`;

const P = "src/main/java/com/shop/pricing/Pricing.java";
const files = new Set([
  P,
  "src/main/java/com/shop/model/Item.java",
  "src/main/java/com/shop/pricing/Discounts.java",
  "src/main/java/com/shop/util/Fmt.java",
  "src/main/java/com/shop/cart/Cart.java",
]);
const exists = (rel: string) => files.has(rel);
const run = (before: string | null, after: string | null, path = P) => analyzeSource({ path, before, after }, { exists });
const writes = async (before: string, after: string) => (await run(before, after)).writes.map((w) => `${w.kind} ${w.key.split("#")[1]}`);

describe("java (tree-sitter backend)", () => {
  it("maps .java to the Java spec", () => {
    expect(languageFor("a/B.java")).toEqual({ id: "java", name: "Java", backend: "tree-sitter" });
  });

  it("lists every declaration of a new file as new, qualified by class", async () => {
    expect(await writes("", PRICING_V1)).toEqual([
      "new Pricing",
      "new Pricing.calcTotal",
      "new Pricing.items",
      "new Pricing.Kind",
      "new Pricing.Kind.RETAIL",
      "new Pricing.Kind.WHOLESALE",
      "new Pricing.tax",
      "new Pricing.TAX_RATE",
      "new Pricing.total",
    ]);
  });

  it("tells a signature change from a body change", async () => {
    const sig = PRICING_V1.replace("calcTotal(List<Item> items) {", "calcTotal(List<Item> items, double taxRate) {");
    expect(await writes(PRICING_V1, sig)).toEqual(["body Pricing", "signature Pricing.calcTotal"]);
    const body = PRICING_V1.replace("return sum;", "return Math.round(sum * 100) / 100.0;");
    expect(await writes(PRICING_V1, body)).toEqual(["body Pricing", "body Pricing.calcTotal"]);
    const ret = PRICING_V1.replace("public static double calcTotal", "public static long calcTotal");
    expect(await writes(PRICING_V1, ret)).toContain("signature Pricing.calcTotal");
    const throwsClause = PRICING_V1.replace("calcTotal(List<Item> items) {", "calcTotal(List<Item> items) throws java.io.IOException {");
    expect(await writes(PRICING_V1, throwsClause)).toContain("signature Pricing.calcTotal");
  });

  it("does not treat reformatting, comments or @Override as a signature change", async () => {
    const wrapped = PRICING_V1.replace("public static double calcTotal(List<Item> items) {", "public static double calcTotal(\n            List<Item> items\n    ) {");
    expect(await writes(PRICING_V1, wrapped)).toEqual(["body Pricing"]);
    const annotated = PRICING_V1.replace("    public double total() {", "    /** The total. */\n    @Override\n    public double total() {");
    expect(await writes(PRICING_V1, annotated)).not.toContain("signature Pricing.total");
  });

  it("annotations that change how callers call it are part of the signature", async () => {
    const after = PRICING_V1.replace("    double tax() {", "    @Nullable\n    double tax() {");
    expect(await writes(PRICING_V1, after)).toContain("signature Pricing.tax");
  });

  it("a constructor change is a signature change of its class", async () => {
    const after = PRICING_V1.replace("public Pricing(List<Item> items) {", "public Pricing(List<Item> items, double rate) {");
    expect(await writes(PRICING_V1, after)).toEqual(["signature Pricing"]);
  });

  it("overloads share one key", async () => {
    const after = PRICING_V1.replace("    double tax() {", "    double tax(double rate) {\n        return rate;\n    }\n\n    double tax() {");
    expect(await writes(PRICING_V1, after)).toEqual(["body Pricing", "signature Pricing.tax"]);
  });

  it("a field's type is its signature, its initializer its body", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("TAX_RATE = 0.2", "TAX_RATE = 0.21"))).toEqual(["body Pricing", "body Pricing.TAX_RATE"]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("static final double TAX_RATE", "static final float TAX_RATE"))).toEqual([
      "body Pricing",
      "signature Pricing.TAX_RATE",
    ]);
  });

  it("reports a rename as deleted + new", async () => {
    const after = PRICING_V1.replaceAll("calcTotal", "computeTotal");
    expect(await writes(PRICING_V1, after)).toEqual(["body Pricing", "deleted Pricing.calcTotal", "new Pricing.computeTotal", "body Pricing.total"]);
  });

  it("records, interfaces and enum constants", async () => {
    const src = `package a;\n\npublic record Pair(int left, String right) {\n    static Pair of(int l) { return new Pair(l, \"\"); }\n}\n\ninterface Calc {\n    double total();\n}\n`;
    expect((await run("", src, "src/main/java/a/Pair.java")).writes.map((w) => w.key.split("#")[1])).toEqual([
      "Calc",
      "Calc.total",
      "Pair",
      "Pair.left",
      "Pair.of",
      "Pair.right",
    ]);
    // A record component is part of the record's signature (its canonical constructor).
    const after = src.replace("int left, String right", "long left, String right");
    expect(await (await run(src, after, "src/main/java/a/Pair.java")).writes.map((w) => `${w.kind} ${w.key.split("#")[1]}`)).toEqual([
      "signature Pair",
      "signature Pair.left",
    ]);
  });

  it("reads local calls, this-calls, unqualified fields and type uses", async () => {
    const { reads } = await run(null, PRICING_V1);
    expect(reads).toEqual([
      "src/main/java/com/shop/model/Item.java#Item",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing.TAX_RATE",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing.calcTotal",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing.items",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing.tax",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing.total",
    ]);
  });

  it("reads imported classes and members: single-type, static, wildcard, same package; ignores the JDK", async () => {
    const cart = `package com.shop.cart;

import java.util.List;
import com.shop.pricing.Pricing;
import com.shop.pricing.Pricing.Kind;
import static com.shop.util.Fmt.money;
import com.shop.model.*;

public class Cart {
    String summary(List<Item> items) {
        Pricing p = new Pricing(items);
        Kind k = Kind.RETAIL;
        return money(Pricing.calcTotal(items)) + p.total() + Discounts.NONE;
    }
}
`;
    const { reads, writes: w } = await run(null, cart, "src/main/java/com/shop/cart/Cart.java");
    expect(w.map((x) => x.key)).toEqual(["src/main/java/com/shop/cart/Cart.java#Cart", "src/main/java/com/shop/cart/Cart.java#Cart.summary"]);
    expect(reads).toEqual([
      "src/main/java/com/shop/model/Item.java#Item",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing.Kind",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing.Kind.RETAIL",
      "src/main/java/com/shop/pricing/Pricing.java#Pricing.calcTotal",
      "src/main/java/com/shop/util/Fmt.java#Fmt.money",
    ]);
  });

  it("resolves classes of its own package without an import", async () => {
    const src = `package com.shop.pricing;\n\nclass Promo {\n    double off() { return Discounts.NONE; }\n}\n`;
    const { reads } = await run(null, src, "src/main/java/com/shop/pricing/Promo.java");
    expect(reads).toEqual(["src/main/java/com/shop/pricing/Discounts.java#Discounts", "src/main/java/com/shop/pricing/Discounts.java#Discounts.NONE"]);
  });

  it("resolves multi-module layouts (app/src/main/java) and needs the checkout for absolute imports", async () => {
    const mm = new Set(["app/src/main/java/com/shop/model/Item.java"]);
    const src = `package com.shop.web;\n\nimport com.shop.model.Item;\n\nclass Page {\n    Item first;\n}\n`;
    const r = await analyzeSource({ path: "app/src/main/java/com/shop/web/Page.java", before: null, after: src }, { exists: (p) => mm.has(p) });
    expect(r.reads).toEqual(["app/src/main/java/com/shop/model/Item.java#Item"]);
    const blind = await analyzeSource({ path: "app/src/main/java/com/shop/web/Page.java", before: null, after: src });
    expect(blind.reads).toEqual([]);
  });

  it("deleting a file deletes its declarations", async () => {
    const r = await run("class A {\n    void f() {}\n}\n", null);
    expect(r.writes.map((w) => `${w.kind} ${w.key.split("#")[1]}`)).toEqual(["deleted A", "deleted A.f"]);
  });

  it("stays inside the edit-time budget (< 300 ms CPU for a 2,000-line file, warm)", async () => {
    const big = Array.from({ length: 75 }, (_, i) => PRICING_V1.replace(/^(package|import) .*\n/gm, "").replaceAll("Pricing", `Pricing${i}`).replaceAll("calcTotal", `calc${i}`)).join("\n");
    expect(big.split("\n").length).toBeGreaterThan(2000);
    await run(big, big);
    expect(await fastestCpuMs(() => run(big, big.replace("calc7(List<Item> items)", "calc7(List<Item> items, double x)")))).toBeLessThan(EDIT_BUDGET_MS);
  });
});
