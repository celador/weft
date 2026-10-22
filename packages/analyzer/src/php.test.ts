import { describe, expect, it } from "vitest";
import { analyzeSource, languageFor } from "./index.js";

const PRICING_V1 = `<?php

declare(strict_types=1);

namespace App\\Pricing;

const TAX_RATE = 0.2;

function calc_total(array $items): float
{
    return array_sum(array_map(fn (Item $i) => $i->price * $i->qty, $items));
}

final class Calculator
{
    public const ROUNDING = 2;

    private array $items = [];

    public function __construct(private readonly float $rate = TAX_RATE)
    {
    }

    public function total(array $items): float
    {
        return round(calc_total($items) * (1 + $this->rate) + $this->fee(), self::ROUNDING);
    }

    protected function fee(): float
    {
        return 0.0;
    }
}
`;

const files = new Set([
  "src/Pricing/Calculator.php",
  "src/Pricing/Item.php",
  "src/Pricing/functions.php",
  "src/Util/Fmt.php",
  "src/Shop/Base.php",
  "src/Shop/Cart.php",
  "app/Models/User.php",
]);
const exists = (rel: string) => files.has(rel);
const run = (before: string | null, after: string | null, path = "src/Pricing/Calculator.php") => analyzeSource({ path, before, after }, { exists });
const writes = async (before: string, after: string) => (await run(before, after)).writes.map((w) => `${w.kind} ${w.key}`);

describe("php (tree-sitter backend)", () => {
  it("maps paths to the backend", () => {
    expect(languageFor("src/A.php")).toEqual({ id: "php", name: "PHP", backend: "tree-sitter" });
  });

  it("lists every declaration of a new file as new, qualified by class (namespace left out)", async () => {
    expect(await writes("", PRICING_V1)).toEqual([
      "new src/Pricing/Calculator.php#calc_total",
      "new src/Pricing/Calculator.php#Calculator",
      "new src/Pricing/Calculator.php#Calculator.__construct",
      "new src/Pricing/Calculator.php#Calculator.fee",
      "new src/Pricing/Calculator.php#Calculator.items",
      "new src/Pricing/Calculator.php#Calculator.rate",
      "new src/Pricing/Calculator.php#Calculator.ROUNDING",
      "new src/Pricing/Calculator.php#Calculator.total",
      "new src/Pricing/Calculator.php#TAX_RATE",
    ]);
  });

  it("tells a signature change from a body change", async () => {
    const sig = PRICING_V1.replace("function calc_total(array $items): float", "function calc_total(array $items, float $taxRate): float");
    expect(await writes(PRICING_V1, sig)).toEqual(["signature src/Pricing/Calculator.php#calc_total"]);
    const ret = PRICING_V1.replace("function calc_total(array $items): float", "function calc_total(array $items): int");
    expect(await writes(PRICING_V1, ret)).toEqual(["signature src/Pricing/Calculator.php#calc_total"]);
    const body = PRICING_V1.replace("return 0.0;", "return 1.5;");
    expect(await writes(PRICING_V1, body)).toEqual(["body src/Pricing/Calculator.php#Calculator", "body src/Pricing/Calculator.php#Calculator.fee"]);
  });

  it("does not treat reformatting a signature as a signature change", async () => {
    const wrapped = PRICING_V1.replace("public function total(array $items): float", "public function total(\n        array $items,\n    ): float");
    expect(await writes(PRICING_V1, wrapped)).not.toContain("signature src/Pricing/Calculator.php#Calculator.total");
  });

  it("visibility, static, extends and property types are signature; values are body", async () => {
    expect(await writes(PRICING_V1, PRICING_V1.replace("protected function fee()", "private function fee()"))).toContain(
      "signature src/Pricing/Calculator.php#Calculator.fee",
    );
    expect(await writes(PRICING_V1, PRICING_V1.replace("final class Calculator", "final class Calculator extends Base"))).toEqual([
      "signature src/Pricing/Calculator.php#Calculator",
    ]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("private array $items = [];", "private ?array $items = [];"))).toEqual([
      "body src/Pricing/Calculator.php#Calculator",
      "signature src/Pricing/Calculator.php#Calculator.items",
    ]);
    expect(await writes(PRICING_V1, PRICING_V1.replace("const ROUNDING = 2;", "const ROUNDING = 3;"))).toEqual([
      "body src/Pricing/Calculator.php#Calculator",
      "body src/Pricing/Calculator.php#Calculator.ROUNDING",
    ]);
  });

  it("reports a rename as deleted + new", async () => {
    const after = PRICING_V1.replaceAll("calc_total", "compute_total");
    expect(await writes(PRICING_V1, after)).toEqual([
      "deleted src/Pricing/Calculator.php#calc_total",
      "body src/Pricing/Calculator.php#Calculator",
      "body src/Pricing/Calculator.php#Calculator.total",
      "new src/Pricing/Calculator.php#compute_total",
    ]);
  });

  it("declares interfaces, traits, enums and their members", async () => {
    const src = `<?php\ninterface HasTotal { public function total(): float; }\ntrait Logs { public function log(string $m): void {} }\nenum Suit: string { case Hearts = 'H'; public function color(): string { return 'red'; } }\n`;
    expect(await writes("", src)).toEqual([
      "new src/Pricing/Calculator.php#HasTotal",
      "new src/Pricing/Calculator.php#HasTotal.total",
      "new src/Pricing/Calculator.php#Logs",
      "new src/Pricing/Calculator.php#Logs.log",
      "new src/Pricing/Calculator.php#Suit",
      "new src/Pricing/Calculator.php#Suit.color",
      "new src/Pricing/Calculator.php#Suit.Hearts",
    ]);
  });

  it("reads local functions, $this members, self:: constants and constants", async () => {
    const { reads } = await run(null, PRICING_V1);
    expect(reads).toEqual([
      "src/Pricing/Calculator.php#Calculator.ROUNDING",
      "src/Pricing/Calculator.php#Calculator.fee",
      "src/Pricing/Calculator.php#Calculator.rate",
      "src/Pricing/Calculator.php#TAX_RATE",
      "src/Pricing/Calculator.php#calc_total",
      "src/Pricing/Item.php#Item", // same namespace, next to the file
    ]);
  });

  it("reads through use (aliases, groups, function), fully qualified names and the file's namespace (PSR-4)", async () => {
    const cart = `<?php
namespace App\\Shop;

use App\\Pricing\\{Calculator, Item as LineItem};
use App\\Models\\User;
use function App\\Pricing\\calc_total;

class Cart extends Base implements \\Countable
{
    public function summary(User $user, LineItem ...$items): string
    {
        $calc = new Calculator(0.1);
        return \\App\\Util\\Fmt::money($calc->total($items)) . calc_total($items) . strlen('x');
    }

    public function count(): int { return 0; }
}
`;
    const { reads, writes: w } = await run(null, cart, "src/Shop/Cart.php");
    expect(w.map((x) => x.key)).toEqual(["src/Shop/Cart.php#Cart", "src/Shop/Cart.php#Cart.count", "src/Shop/Cart.php#Cart.summary"]);
    expect(reads).toEqual([
      "app/Models/User.php#User", // App\\ => app/ (Laravel)
      "src/Pricing/Calculator.php#Calculator", // App\\ => src/
      "src/Pricing/Calculator.php#Calculator.__construct",
      "src/Pricing/Item.php#Item",
      "src/Pricing/functions.php#calc_total",
      "src/Shop/Base.php#Base",
      "src/Util/Fmt.php#Fmt",
      "src/Util/Fmt.php#Fmt.money",
    ]);
  });

  it("prefixes keys with the checkout's path in the repository", async () => {
    const r = await analyzeSource({ path: "src/x.php", before: "", after: "<?php\nfunction f() { return 1; }\n" }, { prefix: "svc/" });
    expect(r.writes).toEqual([{ key: "svc/src/x.php#f", kind: "new" }]);
  });

  it("deleting a file deletes its declarations", async () => {
    expect(await run("<?php\nfunction f() {}\n", null)).toEqual({ reads: [], writes: [{ key: "src/Pricing/Calculator.php#f", kind: "deleted" }] });
  });

  it("stays inside the edit-time budget (< 300 ms for a 2,000-line file, warm)", async () => {
    const body = PRICING_V1.replace(/^<\?php[\s\S]*?namespace App\\Pricing;\n/, "");
    const big = "<?php\nnamespace App\\Pricing;\n" + Array.from({ length: 70 }, (_, i) => body.replaceAll("calc_total", `calc_${i}`).replaceAll("Calculator", `Calculator${i}`).replaceAll("TAX_RATE", `RATE_${i}`)).join("\n");
    expect(big.split("\n").length).toBeGreaterThanOrEqual(2000);
    await run(big, big);
    const t = performance.now();
    await run(big, big.replace("function calc_7(array $items)", "function calc_7(array $items, $x)"));
    expect(performance.now() - t).toBeLessThan(300);
  });
});
