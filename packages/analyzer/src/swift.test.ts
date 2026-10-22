import { describe, expect, it } from "vitest";
import { cpuMs, EDIT_BUDGET_MS, fastestCpuMs } from "./budget.js";
import { analyzeSource, languageFor } from "./index.js";
import { clearModuleIndexCache } from "./moduleindex.js";

const PRICING = `import Foundation

public struct Item: Equatable {
    public let price: Double
    public var qty: Int = 1
}

public let taxRate = 0.2

public func calcTotal(items: [Item]) -> Double {
    return items.reduce(0) { $0 + $1.price * Double($1.qty) }
}

public func formatPrice(_ amount: Double) -> String {
    String(format: "$%.2f", amount)
}
`;

const CART = `final class Cart {
    var items: [Item]

    init(items: [Item]) {
        self.items = items
    }

    var total: Double {
        calcTotal(items: items) + tax()
    }

    func summary() -> String {
        "\\(items.count) items, \\(self.total)"
    }

    static func empty() -> Cart {
        Cart(items: [])
    }
}
`;

const CART_TAX = `extension Cart {
    func tax() -> Double {
        total * taxRate
    }
}
`;

const FORMAT = `public func money(_ value: Double) -> String {
    "$\\(value)"
}
`;

/** An in-memory checkout: exists / list / read over a path -> contents map. */
function checkout(files: Record<string, string>) {
  const list = (dir: string): string[] | undefined => {
    const prefix = dir ? `${dir}/` : "";
    const out = new Set<string>();
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf("/");
      out.add(slash < 0 ? rest : `${rest.slice(0, slash + 1)}`);
    }
    return out.size ? [...out] : undefined;
  };
  return { exists: (rel: string) => rel in files || !!list(rel), list, read: (rel: string) => files[rel] };
}

const FILES: Record<string, string> = {
  "Package.swift": "// swift-tools-version:5.9\n",
  "Sources/Shop/Pricing.swift": PRICING,
  "Sources/Shop/Cart.swift": CART,
  "Sources/Shop/Cart+Tax.swift": CART_TAX,
  "Sources/Util/Format.swift": FORMAT,
  "Tests/ShopTests/CartTests.swift": "",
};
const fs = checkout(FILES);
const run = (before: string | null, after: string | null, path = "Sources/Shop/Pricing.swift", opts: object = fs) =>
  analyzeSource({ path, before, after }, opts);
const writes = async (before: string, after: string, path?: string) => (await run(before, after, path)).writes.map((w) => `${w.kind} ${w.key.replace(/^.*#/, "")}`);

describe("swift (tree-sitter backend)", () => {
  it("maps .swift to the tree-sitter backend", () => {
    expect(languageFor("Sources/Shop/Cart.swift")).toEqual({ id: "swift", name: "Swift", backend: "tree-sitter" });
  });

  it("lists every declaration of a new file, members keyed on their type (extensions too)", async () => {
    expect(await writes("", PRICING)).toEqual(["new calcTotal", "new formatPrice", "new Item", "new Item.price", "new Item.qty", "new taxRate"]);
    expect(await writes("", CART, "Sources/Shop/Cart.swift")).toEqual(["new Cart", "new Cart.empty", "new Cart.init", "new Cart.items", "new Cart.summary", "new Cart.total"]);
    expect(await writes("", CART_TAX, "Sources/Shop/Cart+Tax.swift")).toEqual(["new Cart.tax"]);
  });

  it("tells a signature change from a body change", async () => {
    const sig = PRICING.replace("calcTotal(items: [Item])", "calcTotal(items: [Item], taxRate: Double)");
    expect(await writes(PRICING, sig)).toEqual(["signature calcTotal"]);
    const body = PRICING.replace("return items.reduce(0)", "return items.reduce(0.0)");
    expect(await writes(PRICING, body)).toEqual(["body calcTotal"]);
  });

  it("argument labels are signature; internal parameter names are not", async () => {
    const unlabeled = PRICING.replace("calcTotal(items: [Item])", "calcTotal(_ items: [Item])");
    expect(await writes(PRICING, unlabeled)).toEqual(["signature calcTotal"]);
    const relabeled = PRICING.replace("calcTotal(items: [Item])", "calcTotal(for items: [Item])");
    expect(await writes(PRICING, relabeled)).toEqual(["signature calcTotal"]);
    const internal = PRICING.replace("formatPrice(_ amount: Double)", "formatPrice(_ value: Double)").replace("amount)\n}", "value)\n}");
    expect(await writes(PRICING, internal)).toEqual(["body formatPrice"]);
  });

  it("does not treat reformatting a signature as a signature change", async () => {
    const wrapped = PRICING.replace("calcTotal(items: [Item]) -> Double", "calcTotal(\n    items: [Item],\n) -> Double");
    expect(await writes(PRICING, wrapped)).toEqual([]);
  });

  it("reports a rename as deleted + new", async () => {
    expect(await writes(PRICING, PRICING.replace("func calcTotal", "func computeTotal"))).toEqual(["deleted calcTotal", "new computeTotal"]);
  });

  it("a member change is a body change of its type; a property's type is its signature", async () => {
    const after = CART.replace("func summary() -> String", "func summary(verbose: Bool) -> String");
    expect(await writes(CART, after, "Sources/Shop/Cart.swift")).toEqual(["body Cart", "signature Cart.summary"]);
    expect(await writes(PRICING, PRICING.replace("public let taxRate = 0.2", "public let taxRate = 0.21"))).toEqual(["body taxRate"]);
    expect(await writes(PRICING, PRICING.replace("public let taxRate = 0.2", "public let taxRate: Float = 0.2"))).toEqual(["signature taxRate"]);
    expect(await writes(PRICING, PRICING.replace("public var qty: Int = 1", "public var qty: Int = 2"))).toEqual(["body Item", "body Item.qty"]);
  });

  it("reads local declarations: implicit self, self., types, initializers", async () => {
    const { reads } = await run(null, CART, "Sources/Shop/Cart.swift", {});
    expect(reads).toEqual([
      "Sources/Shop/Cart.swift#Cart",
      "Sources/Shop/Cart.swift#Cart.init",
      "Sources/Shop/Cart.swift#Cart.items",
      "Sources/Shop/Cart.swift#Cart.total",
    ]);
  });

  it("reads declarations of other files of the module, with no import (module index)", async () => {
    clearModuleIndexCache();
    const { reads } = await run(null, CART, "Sources/Shop/Cart.swift");
    expect(reads).toEqual([
      "Sources/Shop/Cart+Tax.swift#Cart.tax",
      "Sources/Shop/Cart.swift#Cart",
      "Sources/Shop/Cart.swift#Cart.init",
      "Sources/Shop/Cart.swift#Cart.items",
      "Sources/Shop/Cart.swift#Cart.total",
      "Sources/Shop/Pricing.swift#Item",
      "Sources/Shop/Pricing.swift#calcTotal",
    ]);
    const ext = await run(null, CART_TAX, "Sources/Shop/Cart+Tax.swift");
    expect(ext.reads).toEqual(["Sources/Shop/Cart.swift#Cart", "Sources/Shop/Cart.swift#Cart.total", "Sources/Shop/Pricing.swift#taxRate"]);
  });

  it("other targets are visible only through `import`, also module-qualified", async () => {
    const src = `func label(_ x: Double) -> String { money(x) }\n`;
    expect((await run(null, src, "Sources/Shop/Label.swift")).reads).toEqual([]);
    expect((await run(null, `import Util\n${src}`, "Sources/Shop/Label.swift")).reads).toEqual(["Sources/Util/Format.swift#money"]);
    expect((await run(null, `import Util\nfunc l() -> String { Util.money(1) }\n`, "Sources/Shop/Label.swift")).reads).toEqual(["Sources/Util/Format.swift#money"]);
    const test = `@testable import Shop\nfunc testTotal() { _ = Shop.calcTotal(items: [Item(price: 1)]) }\n`;
    expect((await run(null, test, "Tests/ShopTests/CartTests.swift")).reads).toEqual(["Sources/Shop/Pricing.swift#Item", "Sources/Shop/Pricing.swift#calcTotal"]);
  });

  it("parameters and local bindings are not references", async () => {
    const src = `func f(taxRate: Double, items: [Item]) -> Double {\n    let calcTotal = 1.0\n    return taxRate * calcTotal + items.reduce(0) { acc, item in acc + item.price }\n}\n`;
    expect((await run(null, src, "Sources/Shop/F.swift")).reads).toEqual(["Sources/Shop/Pricing.swift#Item"]);
  });

  it("Xcode projects: the group folder next to the .xcodeproj is the module", async () => {
    const x = checkout({
      "App.xcodeproj/project.pbxproj": "",
      "App/Model/Pricing.swift": PRICING,
      "App/Views/CartView.swift": "",
      "Other/Pricing.swift": "func calcTotal(items: [Int]) -> Int { 0 }\n",
    });
    const r = await run(null, `func show() -> Double { calcTotal(items: []) }\n`, "App/Views/CartView.swift", x);
    expect(r.reads).toEqual(["App/Model/Pricing.swift#calcTotal"]);
  });

  it("stays inside the edit-time budget (< 300 ms CPU: 2,000-line file, and a 400-file module)", async () => {
    const big = Array.from({ length: 120 }, (_, i) => PRICING.replaceAll("calcTotal", `calc${i}`).replaceAll("Item", `Item${i}`).replaceAll("taxRate", `rate${i}`).replaceAll("formatPrice", `fmt${i}`)).join("\n");
    expect(big.split("\n").length).toBeGreaterThan(2000);
    await run(big, big);
    expect(await fastestCpuMs(() => run(big, big.replace("calc7(items: [Item7])", "calc7(items: [Item7], x: Int)")))).toBeLessThan(EDIT_BUDGET_MS);

    const files: Record<string, string> = { "Package.swift": "" };
    for (let i = 0; i < 400; i++) files[`Sources/Big/File${i}.swift`] = PRICING.replaceAll("calcTotal", `calc${i}`).replaceAll("Item", `Item${i}`).replaceAll("taxRate", `rate${i}`).replaceAll("formatPrice", `fmt${i}`);
    const bigFs = checkout(files);
    const user = `func use() -> Double { calc399(items: [Item12(price: 1)]) + rate5 }\n`;
    clearModuleIndexCache();
    let cold: Awaited<ReturnType<typeof run>> | undefined;
    const coldMs = await cpuMs(async () => {
      cold = await run(null, user, "Sources/Big/Use.swift", bigFs);
    });
    expect(cold?.reads).toEqual(["Sources/Big/File12.swift#Item12", "Sources/Big/File399.swift#calc399", "Sources/Big/File5.swift#rate5"]);
    expect(coldMs).toBeLessThan(EDIT_BUDGET_MS);
    expect(await fastestCpuMs(() => run(null, user, "Sources/Big/Use.swift", bigFs))).toBeLessThan(EDIT_BUDGET_MS);
  });
});
