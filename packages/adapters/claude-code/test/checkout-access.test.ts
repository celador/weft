// checkoutAccess: the one way the analyzer sees the checkout (C/C++ includes, Go/Kotlin package
// index, Swift/C# module index). Paths stay inside the checkout, symlinks are not followed,
// large files are not read, and files the same tool call changes appear as they will after it.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeChanges, checkoutAccess } from "../src/analysis";

function tree(): { root: string; outside: string } {
  const outside = mkdtempSync(join(tmpdir(), "weft-outside-"));
  writeFileSync(join(outside, "secret.go"), "package secret\n");
  const root = mkdtempSync(join(tmpdir(), "weft-checkout-"));
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "a.go"), "package pkg\n");
  writeFileSync(join(root, "pkg", "b.go"), "package pkg\n");
  writeFileSync(join(root, "pkg", "big.go"), "x".repeat((1 << 20) + 1));
  symlinkSync(join(outside, "secret.go"), join(root, "pkg", "link.go"));
  symlinkSync(outside, join(root, "linked"));
  return { root, outside };
}

describe("checkoutAccess", () => {
  it("lists and reads checkout files", () => {
    const { root } = tree();
    const c = checkoutAccess(root);
    expect(c.list("pkg")?.sort()).toEqual(["a.go", "b.go", "big.go"]);
    expect(c.list("")?.sort()).toEqual(["pkg/"]);
    expect(c.read("pkg/a.go")).toBe("package pkg\n");
    expect(c.exists("pkg/a.go")).toBe(true);
  });

  it("refuses `..` and absolute paths for list, read and exists", () => {
    const { root, outside } = tree();
    const c = checkoutAccess(root);
    expect(c.list("..")).toBeUndefined();
    expect(c.list("pkg/../..")).toBeUndefined();
    expect(c.list(outside)).toBeUndefined();
    expect(c.read(`../${outside.split("/").pop()}/secret.go`)).toBeUndefined();
    expect(c.read(join(outside, "secret.go"))).toBeUndefined();
    expect(c.exists("../x")).toBe(false);
  });

  it("does not follow symlinks and skips files over 1 MiB", () => {
    const { root } = tree();
    const c = checkoutAccess(root);
    expect(c.read("pkg/link.go")).toBeUndefined();
    expect(c.list("linked")).toBeUndefined();
    expect(c.read("linked/secret.go")).toBeUndefined();
    expect(c.read("pkg/big.go")).toBeUndefined();
  });

  it("sees pending post-edit text, including created and deleted files", () => {
    const { root } = tree();
    const c = checkoutAccess(root, new Map([["pkg/a.go", "package pkg\nfunc A() {}\n"], ["pkg/b.go", null], ["pkg/new.go", "package pkg\n"]]));
    expect(c.read("pkg/a.go")).toContain("func A");
    expect(c.read("pkg/b.go")).toBeUndefined();
    expect(c.exists("pkg/b.go")).toBe(false);
    expect(c.exists("pkg/new.go")).toBe(true);
    expect(c.list("pkg")?.sort()).toEqual(["a.go", "big.go", "new.go"]);
  });
});

describe("contract reads go through checkoutAccess", () => {
  const pricing = "export interface PriceOptions { rate: number }\nexport function calcTotal(n: number, opts: PriceOptions): number { return n * opts.rate; }\n";
  const cart = (body: string) => `import { calcTotal } from "./pricing";\nexport const total = ${body};\n`;

  it("reads the contract type of an imported function from a checkout file", () => {
    const root = mkdtempSync(join(tmpdir(), "weft-contract-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "pricing.ts"), pricing);
    const { reads } = analyzeChanges([{ rel: "src/cart.ts", before: cart("1"), after: cart("calcTotal(2, { rate: 1 })") }], root);
    expect(reads).toContain("src/pricing.ts#calcTotal");
    expect(reads).toContain("src/pricing.ts#PriceOptions");
  });

  it("does not read the contract through a symlink out of the checkout", () => {
    const outside = mkdtempSync(join(tmpdir(), "weft-outside-"));
    writeFileSync(join(outside, "pricing.ts"), pricing);
    const root = mkdtempSync(join(tmpdir(), "weft-contract-"));
    mkdirSync(join(root, "src"));
    symlinkSync(join(outside, "pricing.ts"), join(root, "src", "pricing.ts"));
    const { reads } = analyzeChanges([{ rel: "src/cart.ts", before: cart("1"), after: cart("calcTotal(2, { rate: 1 })") }], root);
    expect(reads).not.toContain("src/pricing.ts#PriceOptions");
  });
});
