// Reads are scoped to the edit (docs/languages.md): every backend reads only what the
// declarations an edit adds or changes reference. One sample per language: `f` calls `h`, `g`
// calls `k`; an edit to `g` reads `k`, not `h`.
import { describe, expect, it } from "vitest";
import { analyze, analyzeSource } from "./index.js";
import { changedLines, editScope } from "./scope.js";

type Sample = { path: string; text: string; from: string; to: string };

const samples: Record<string, Sample> = {
  python: { path: "m.py", text: "def h():\n    return 1\n\ndef k():\n    return 2\n\ndef f():\n    return h()\n\ndef g():\n    return k()\n", from: "return k()", to: "return k() + 1" },
  c: { path: "m.c", text: "int h(void) { return 1; }\nint k(void) { return 2; }\nint f(void) {\n  return h();\n}\nint g(void) {\n  return k();\n}\n", from: "return k();", to: "return k() + 1;" },
  cpp: { path: "m.cpp", text: "int h() { return 1; }\nint k() { return 2; }\nint f() {\n  return h();\n}\nint g() {\n  return k();\n}\n", from: "return k();", to: "return k() + 1;" },
  go: { path: "m.go", text: "package m\n\nfunc h() int { return 1 }\nfunc k() int { return 2 }\nfunc f() int {\n\treturn h()\n}\nfunc g() int {\n\treturn k()\n}\n", from: "return k()", to: "return k() + 1" },
  rust: { path: "src/m.rs", text: "fn h() -> i32 { 1 }\nfn k() -> i32 { 2 }\nfn f() -> i32 {\n    h()\n}\nfn g() -> i32 {\n    k()\n}\n", from: "    k()\n", to: "    k() + 1\n" },
  java: { path: "U.java", text: "class U {\n  static int h() { return 1; }\n  static int k() { return 2; }\n  static int f() {\n    return h();\n  }\n  static int g() {\n    return k();\n  }\n}\n", from: "return k();", to: "return k() + 1;" },
  kotlin: { path: "m.kt", text: "fun h() = 1\nfun k() = 2\nfun f(): Int {\n    return h()\n}\nfun g(): Int {\n    return k()\n}\n", from: "return k()", to: "return k() + 1" },
  swift: { path: "m.swift", text: "func h() -> Int { 1 }\nfunc k() -> Int { 2 }\nfunc f() -> Int {\n    return h()\n}\nfunc g() -> Int {\n    return k()\n}\n", from: "return k()", to: "return k() + 1" },
  csharp: { path: "U.cs", text: "class U {\n  static int h() { return 1; }\n  static int k() { return 2; }\n  static int f() {\n    return h();\n  }\n  static int g() {\n    return k();\n  }\n}\n", from: "return k();", to: "return k() + 1;" },
  ruby: { path: "m.rb", text: "def h\n  1\nend\n\ndef k\n  2\nend\n\ndef f\n  h\nend\n\ndef g\n  k\nend\n", from: "def g\n  k\n", to: "def g\n  k + 1\n" },
  php: { path: "m.php", text: "<?php\nfunction h() { return 1; }\nfunction k() { return 2; }\nfunction f() {\n  return h();\n}\nfunction g() {\n  return k();\n}\n", from: "return k();", to: "return k() + 1;" },
};

const names = (reads: string[]) => reads.map((k) => k.slice(k.indexOf("#") + 1).split(".").pop());

describe("reads are scoped to the edit, in every tree-sitter language", () => {
  for (const [id, s] of Object.entries(samples)) {
    it(`${id}: an edit to g reads k, not h`, async () => {
      expect(s.text).toContain(s.from);
      // Not vacuous: the analyzer sees both calls when the whole file is new.
      expect(names((await analyzeSource({ path: s.path, before: null, after: s.text })).reads)).toEqual(expect.arrayContaining(["h", "k"]));
      const r = await analyzeSource({ path: s.path, before: s.text, after: s.text.replace(s.from, s.to) });
      expect(names(r.reads)).toContain("k");
      expect(names(r.reads)).not.toContain("h");
    });
  }

  it("typescript: an edit to g reads k, not h", () => {
    const text = "function h() { return 1; }\nfunction k() { return 2; }\nfunction f() {\n  return h();\n}\nfunction g() {\n  return k();\n}\n";
    expect(analyze(text, text.replace("return k();", "return k() + 1;"), "m.ts").reads).toEqual(["m.ts#k"]);
  });
});

describe("editScope", () => {
  it("line diff: removed and added lines", () => {
    expect(changedLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual({ removed: [1], added: [1, 3] });
    expect(changedLines([], ["a"])).toEqual({ removed: [], added: [0] });
  });

  it("a new file is in scope as a whole", () => {
    expect(editScope("", "x", [], [])(0)).toBe(true);
  });

  it("whitespace-only lines touch nothing; a changed line touches its innermost declaration", () => {
    const before = "A {\n  m1\n  m2\n}\n";
    const spans = (t: string) => [
      { name: "A", start: 0, end: t.indexOf("}") + 1 },
      { name: "A.m1", start: t.indexOf("m1"), end: t.indexOf("m1") + 2 },
      { name: "A.m2", start: t.indexOf("m2"), end: t.indexOf("m2") + 2 },
    ];
    const blank = before.replace("  m2", "\n  m2");
    const inBlank = editScope(before, blank, spans(before), spans(blank));
    expect([blank.indexOf("m1"), blank.indexOf("m2"), 0].map(inBlank)).toEqual([false, false, false]);
    const after = before.replace("m2", "m2x").replace("A.m2", "A.m2");
    const s2 = [...spans(after)];
    s2[2] = { name: "A.m2", start: after.indexOf("m2x"), end: after.indexOf("m2x") + 3 };
    const scope = editScope(before, after, spans(before), s2);
    expect(scope(after.indexOf("m2x"))).toBe(true);
    expect(scope(after.indexOf("m1"))).toBe(false);
    expect(scope(0)).toBe(false); // the class header: A is not touched by a change to m2
  });
});
