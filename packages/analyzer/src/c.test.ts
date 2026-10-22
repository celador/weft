import { describe, expect, it } from "vitest";
import { analyzeSource, languageFor, treeSitterLanguageFor } from "./index.js";

// A small C project: the contract lives in include/pricing.h, the code in src/.
const PRICING_H = `#ifndef PRICING_H
#define PRICING_H

typedef struct {
  int price;
  int qty;
} Item;

#define TAX_RATE 20
#define LINE(item) ((item)->price * (item)->qty)

enum Currency { USD, EUR = 2 };

extern int rounding;

int calc_total(const Item *items, int n);
int format_price(int amount, char *out);

#endif
`;

const PRICING_C = `#include <stdio.h>
#include "pricing.h"

int rounding = 1;

static int line(const Item *item) { return LINE(item); }

int calc_total(const Item *items, int n) {
  int sum = 0;
  for (int i = 0; i < n; i++) sum += line(&items[i]);
  return sum;
}

int format_price(int amount, char *out) { return sprintf(out, "$%d", amount); }
`;

const UTIL_H = `#include "pricing.h"\nint util_round(int x);\n`;

// A small C++ project: a class in a namespace, defined out of line.
const CART_HPP = `#pragma once
#include <vector>
#include "pricing.h"

namespace shop {

using Money = long;

enum class Mode { Net, Gross };

template <typename T>
class Box {
 public:
  T get() const;
};

class Cart : public Base {
 public:
  explicit Cart(int n);
  Money total() const;
  Money tax(Mode mode) const;
  int size = 0;

 private:
  std::vector<Item> items_;
};

Money calc(const Cart &cart);

}  // namespace shop
`;

const CART_CPP = `#include "cart.hpp"

namespace shop {

Cart::Cart(int n) : size(n) {}

Money Cart::total() const {
  return calc_total(items_.data(), size) + tax(Mode::Net);
}

Money Cart::tax(Mode mode) const { return this->size * TAX_RATE; }

}  // namespace shop

shop::Money shop::calc(const Cart &cart) { return cart.total(); }
`;

const files: Record<string, string> = {
  "include/pricing.h": PRICING_H,
  "src/pricing.c": PRICING_C,
  "src/util.h": UTIL_H,
  "src/cart.c": "",
  "include/cart.hpp": CART_HPP,
  "src/cart.cpp": CART_CPP,
};
const exists = (rel: string) => rel in files;
const read = (rel: string) => files[rel];
const run = (path: string, before: string | null, after: string | null, opts = { exists, read }) =>
  analyzeSource({ path, before, after }, opts);
/** Fastest of three runs, in ms: the cost of the analysis, not of a busy machine's scheduler. */
const bestOf3 = async (f: () => Promise<unknown>): Promise<number> => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await f();
    best = Math.min(best, performance.now() - t);
  }
  return best;
};
const writes = async (path: string, before: string, after: string) =>
  (await run(path, before, after)).writes.map((w) => `${w.kind} ${w.key}`);

describe("c (tree-sitter backend)", () => {
  it("maps paths to backends; a .h written in C++ is C++", () => {
    expect(languageFor("src/a.c")).toEqual({ id: "c", name: "C", backend: "tree-sitter" });
    expect(languageFor("include/a.h")?.id).toBe("c");
    expect(languageFor("src/a.cpp")).toEqual({ id: "cpp", name: "C++", backend: "tree-sitter" });
    expect(languageFor("src/a.cc")?.id).toBe("cpp");
    expect(languageFor("include/a.hpp")?.id).toBe("cpp");
    expect(treeSitterLanguageFor("include/a.h", "namespace a { class B {}; }")?.id).toBe("cpp");
    expect(treeSitterLanguageFor("include/a.h", PRICING_H)?.id).toBe("c");
  });

  it("lists a header's declarations: functions, typedef'd structs and fields, macros, enumerators, globals", async () => {
    expect(await writes("include/pricing.h", "", PRICING_H)).toEqual([
      "new include/pricing.h#calc_total",
      "new include/pricing.h#Currency",
      "new include/pricing.h#EUR",
      "new include/pricing.h#format_price",
      "new include/pricing.h#Item",
      "new include/pricing.h#Item.price",
      "new include/pricing.h#Item.qty",
      "new include/pricing.h#LINE",
      "new include/pricing.h#PRICING_H",
      "new include/pricing.h#rounding",
      "new include/pricing.h#TAX_RATE",
      "new include/pricing.h#USD",
    ]);
    // The include guard is a declaration, not a use.
    expect((await run("include/pricing.h", null, PRICING_H)).reads).toEqual(["include/pricing.h#Item"]);
  });

  it("a prototype change in the header is a signature write; a macro value change is a body write", async () => {
    const sig = PRICING_H.replace("int calc_total(const Item *items, int n);", "int calc_total(const Item *items, int n, int tax_rate);");
    expect(await writes("include/pricing.h", PRICING_H, sig)).toEqual(["signature include/pricing.h#calc_total"]);
    const value = PRICING_H.replace("#define TAX_RATE 20", "#define TAX_RATE 21");
    expect(await writes("include/pricing.h", PRICING_H, value)).toEqual(["body include/pricing.h#TAX_RATE"]);
    const params = PRICING_H.replace("#define LINE(item)", "#define LINE(item, n)");
    expect(await writes("include/pricing.h", PRICING_H, params)).toEqual(["signature include/pricing.h#LINE"]);
  });

  it("a definition in the .c shares its header's key: body-only change = body write on the header key", async () => {
    const body = PRICING_C.replace("int sum = 0;", "int sum = rounding;");
    expect(await writes("src/pricing.c", PRICING_C, body)).toEqual(["body include/pricing.h#calc_total"]);
    // Without access to the header's text, the definition keeps its own file's key.
    const own = await run("src/pricing.c", PRICING_C, body, { exists, read: undefined as never });
    expect(own.writes).toEqual([{ key: "src/pricing.c#calc_total", kind: "body" }]);
  });

  it("a static helper is keyed to the .c; a changed definition signature is a signature write on the header key", async () => {
    const helper = PRICING_C.replace("return LINE(item);", "return LINE(item) * rounding;");
    expect(await writes("src/pricing.c", PRICING_C, helper)).toEqual(["body src/pricing.c#line"]);
    const sig = PRICING_C.replace("int calc_total(const Item *items, int n) {", "int calc_total(const Item *items, int n, int tax_rate) {");
    expect(await writes("src/pricing.c", PRICING_C, sig)).toEqual(["signature include/pricing.h#calc_total"]);
  });

  it("does not treat reformatting a prototype as a signature change", async () => {
    const wrapped = PRICING_H.replace("int calc_total(const Item *items, int n);", "int calc_total(\n    const Item * items,\n    int n\n);");
    expect(await writes("include/pricing.h", PRICING_H, wrapped)).toEqual([]);
  });

  it("reports a rename as deleted + new", async () => {
    const after = PRICING_H.replace("int format_price(", "int format_money(");
    expect(await writes("include/pricing.h", PRICING_H, after)).toEqual([
      "new include/pricing.h#format_money",
      "deleted include/pricing.h#format_price",
    ]);
  });

  it("reads local declarations and included ones (quoted, include/ fallback, <...>, transitive)", async () => {
    const own = await run("src/pricing.c", null, PRICING_C);
    expect(own.reads).toEqual([
      "include/pricing.h#Item",
      "include/pricing.h#LINE",
      "src/pricing.c#line",
    ]);
    const cart = `#include "util.h"\n#include <pricing.h>\n#include <stdlib.h>\n\nint cart_total(Item *items, int n) {\n  return util_round(calc_total(items, n)) + TAX_RATE + EUR;\n}\n`;
    const r = await run("src/cart.c", "", cart);
    expect(r.writes).toEqual([{ key: "src/cart.c#cart_total", kind: "new" }]);
    expect(r.reads).toEqual([
      "include/pricing.h#EUR",
      "include/pricing.h#Item",
      "include/pricing.h#TAX_RATE",
      "include/pricing.h#calc_total",
      "src/util.h#util_round",
    ]);
  });

  it("prefixes keys with the checkout's path in the repository", async () => {
    const r = await analyzeSource({ path: "src/a.c", before: "", after: "int f(void) { return 1; }\n" }, { prefix: "svc/" });
    expect(r.writes).toEqual([{ key: "svc/src/a.c#f", kind: "new" }]);
  });

  it("deleting a file deletes its declarations", async () => {
    expect(await run("src/a.c", "static int f(void) { return 0; }\n", null, { exists, read })).toEqual({
      reads: [],
      writes: [{ key: "src/a.c#f", kind: "deleted" }],
    });
  });

  it("stays inside the edit-time budget (< 300 ms for a 2,000-line file, warm)", async () => {
    const unit = PRICING_C.replace('#include <stdio.h>\n#include "pricing.h"\n', "");
    const big = `#include "pricing.h"\n` + Array.from({ length: 155 }, (_, i) => unit.replaceAll("calc_total", `calc_${i}`).replaceAll("line", `line_${i}`).replaceAll("rounding", `rounding_${i}`).replaceAll("format_price", `fmt_${i}`)).join("\n");
    expect(big.split("\n").length).toBeGreaterThanOrEqual(2000);
    await run("src/pricing.c", big, big);
    expect(await bestOf3(() => run("src/pricing.c", big, big.replace("int calc_7(const Item *items, int n)", "int calc_7(const Item *items, int n, int x)")))).toBeLessThan(300);
  });
});

describe("cpp (tree-sitter backend)", () => {
  it("qualifies by namespace and class; template parameters, access and aliases are declarations' signatures", async () => {
    expect(await writes("include/cart.hpp", "", CART_HPP)).toEqual([
      "new include/cart.hpp#shop.Box",
      "new include/cart.hpp#shop.Box.get",
      "new include/cart.hpp#shop.calc",
      "new include/cart.hpp#shop.Cart",
      "new include/cart.hpp#shop.Cart.Cart",
      "new include/cart.hpp#shop.Cart.items_",
      "new include/cart.hpp#shop.Cart.size",
      "new include/cart.hpp#shop.Cart.tax",
      "new include/cart.hpp#shop.Cart.total",
      "new include/cart.hpp#shop.Mode",
      "new include/cart.hpp#shop.Mode.Gross",
      "new include/cart.hpp#shop.Mode.Net",
      "new include/cart.hpp#shop.Money",
    ]);
    const tmpl = CART_HPP.replace("template <typename T>\nclass Box", "template <typename T, int N>\nclass Box");
    expect(await writes("include/cart.hpp", CART_HPP, tmpl)).toEqual(["signature include/cart.hpp#shop.Box"]);
    const access = CART_HPP.replace("  Money tax(Mode mode) const;\n  int size = 0;\n\n private:\n", "  int size = 0;\n\n private:\n  Money tax(Mode mode) const;\n");
    expect(await writes("include/cart.hpp", CART_HPP, access)).toEqual(["body include/cart.hpp#shop.Cart", "signature include/cart.hpp#shop.Cart.tax"]);
    const alias = CART_HPP.replace("using Money = long;", "using Money = double;");
    expect(await writes("include/cart.hpp", CART_HPP, alias)).toEqual(["signature include/cart.hpp#shop.Money"]);
  });

  it("an out-of-line member definition is keyed like its in-class declaration, on the header", async () => {
    const body = CART_CPP.replace("return this->size * TAX_RATE;", "return this->size * TAX_RATE / 100;");
    expect(await writes("src/cart.cpp", CART_CPP, body)).toEqual(["body include/cart.hpp#shop.Cart.tax"]);
    const sig = CART_CPP.replace("Money Cart::total() const {", "Money Cart::total(bool gross) const {");
    expect(await writes("src/cart.cpp", CART_CPP, sig)).toEqual(["signature include/cart.hpp#shop.Cart.total"]);
    // Constructor initializer lists are body.
    const init = CART_CPP.replace(": size(n) {}", ": size(n + 1) {}");
    expect(await writes("src/cart.cpp", CART_CPP, init)).toEqual(["body include/cart.hpp#shop.Cart.Cart"]);
    // `using namespace shop;` + `Cart::tax` is the header's shop.Cart.tax.
    const usingNs = `#include "cart.hpp"\nusing namespace shop;\nMoney Cart::tax(Mode mode) const { return 0; }\n`;
    expect((await run("src/cart.cpp", usingNs, usingNs.replace("return 0;", "return 1;"))).writes).toEqual([
      { key: "include/cart.hpp#shop.Cart.tax", kind: "body" },
    ]);
  });

  it("reads members through implicit this, this->, typed parameters, qualified names, and included headers", async () => {
    // `cart.total()` reads shop.Cart.total through the parameter's declared type.
    const r = await run("src/cart.cpp", null, CART_CPP);
    expect(r.reads).toEqual([
      "include/cart.hpp#shop.Cart",
      "include/cart.hpp#shop.Cart.items_",
      "include/cart.hpp#shop.Cart.size",
      "include/cart.hpp#shop.Cart.tax",
      "include/cart.hpp#shop.Cart.total",
      "include/cart.hpp#shop.Mode",
      "include/cart.hpp#shop.Mode.Net",
      "include/cart.hpp#shop.Money",
      "include/pricing.h#TAX_RATE",
      "include/pricing.h#calc_total",
    ]);
  });

  it("reformatting a member declaration is not a signature change; rename = deleted + new", async () => {
    const wrapped = CART_HPP.replace("  Money tax(Mode mode) const;", "  Money tax(\n      Mode mode\n  ) const;");
    expect(await writes("include/cart.hpp", CART_HPP, wrapped)).toEqual(["body include/cart.hpp#shop.Cart"]);
    const renamed = CART_HPP.replace("Money calc(const Cart &cart);", "Money compute(const Cart &cart);");
    expect(await writes("include/cart.hpp", CART_HPP, renamed)).toEqual([
      "deleted include/cart.hpp#shop.calc",
      "new include/cart.hpp#shop.compute",
    ]);
  });

  it("stays inside the edit-time budget (< 300 ms for a 2,000-line file, warm)", async () => {
    const unit = CART_HPP.replace("#pragma once\n#include <vector>\n#include \"pricing.h\"\n", "");
    const big = Array.from({ length: 72 }, (_, i) => unit.replaceAll("shop", `shop${i}`)).join("\n");
    expect(big.split("\n").length).toBeGreaterThanOrEqual(2000);
    await run("include/big.hpp", big, big);
    expect(await bestOf3(() => run("include/big.hpp", big, big.replace("namespace shop7 {\n\nusing Money = long;", "namespace shop7 {\n\nusing Money = double;")))).toBeLessThan(300);
  });
});
