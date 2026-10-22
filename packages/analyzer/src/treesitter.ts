// The tree-sitter backend: one generic engine, one small spec per language.
//
// The engine parses before/after with the language's WASM grammar, diffs the declarations the
// spec extracts (signature vs body), and resolves the spec's references against the file's own
// declarations and its imports. Everything is in-process and synchronous after the first load
// (runtime + grammar load once per process, ~10 ms).
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Language, Parser, type Tree } from "web-tree-sitter";
import { findGrammar, findRuntimeWasm } from "./assets.js";
import type { Analysis, AnalyzeOptions, Definition, ImportBinding, Reference, SyntaxNode, TreeSitterLanguage, Write } from "./language.js";
import { type IndexHit, longestDefined, ModuleLookup } from "./moduleindex.js";

let runtime: Promise<void> | undefined;
const parsers = new Map<string, Promise<Parser>>();

function initRuntime(): Promise<void> {
  runtime ??= Parser.init({ locateFile: () => findRuntimeWasm() } as never);
  return runtime;
}

/** A parser for `language`, loading the runtime and grammar on first use. */
export function parserFor(language: TreeSitterLanguage): Promise<Parser> {
  let parser = parsers.get(language.id);
  if (!parser) {
    parser = (async () => {
      await initRuntime();
      const grammar = await Language.load(new Uint8Array(readFileSync(findGrammar(language.grammar))));
      const p = new Parser();
      p.setLanguage(grammar);
      return p;
    })();
    parsers.set(language.id, parser);
    parser.catch(() => parsers.delete(language.id));
  }
  return parser;
}

function parseTree(parser: Parser, text: string, old?: Tree): Tree {
  const tree = parser.parse(text, old);
  if (!tree) throw new Error("tree-sitter returned no tree");
  return tree;
}

function parse(parser: Parser, text: string): SyntaxNode {
  return parseTree(parser, text).rootNode as unknown as SyntaxNode;
}

/** Row/column (UTF-16 code units, like the indices) of `index` in `text`. */
function point(text: string, index: number): { row: number; column: number } {
  let row = 0;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) {
    row++;
    lineStart = i + 1;
  }
  return { row, column: index - lineStart };
}

/**
 * Mark the span where `after` differs from `before` as edited in `tree` (the parse of
 * `before`), so parsing `after` with it reuses every unchanged subtree. An edit touches a few
 * lines; reparsing incrementally costs a fraction of a full parse (Kotlin's grammar: ~0.3 ms
 * instead of ~60 ms for 2,000 lines). Call only after everything needed from `tree` is read.
 */
export function markEdit(tree: Tree, before: string, after: string): Tree {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let common = 0;
  while (common < max - start && before.charCodeAt(before.length - 1 - common) === after.charCodeAt(after.length - 1 - common)) common++;
  const oldEnd = before.length - common;
  const newEnd = after.length - common;
  tree.edit({
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: point(before, start),
    oldEndPosition: point(before, oldEnd),
    newEndPosition: point(after, newEnd),
  });
  return tree;
}

function definitionMap(defs: Definition[]): Map<string, Definition> {
  // Same-named declarations (overloads, property getter/setter pairs) are one symbol.
  const map = new Map<string, Definition>();
  for (const d of defs) {
    const prev = map.get(d.name);
    map.set(d.name, prev ? { name: d.name, signature: `${prev.signature}\n${d.signature}`, body: `${prev.body}\n${d.body}` } : d);
  }
  return map;
}

/** Collapse whitespace so reformatting is not a signature change. */
export function normalize(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*([()[\]{},:;=<>|*&.])\s*/g, "$1")
    .replace(/,([)\]}])/g, "$1")
    .trim();
}

function longestBinding(path: string[], bindings: ImportBinding[]): { binding: ImportBinding; rest: string[] } | undefined {
  for (let n = path.length; n >= 1; n--) {
    const local = path.slice(0, n).join(".");
    const binding = bindings.find((b) => b.local === local);
    if (binding) return { binding, rest: path.slice(n) };
  }
  return undefined;
}

/** At most this many included files are read per analysis (C/C++ `#include` closure). */
const MAX_INCLUDED_FILES = 64;
const MAX_INCLUDED_BYTES = 1_000_000;

/**
 * Declarations brought into scope by `all` imports (C/C++ `#include`), transitively:
 * qualified name -> the file that declares it (the first include that declares it wins).
 */
function includedDeclarations(
  language: TreeSitterLanguage,
  parser: Parser,
  root: SyntaxNode,
  path: string,
  opts: AnalyzeOptions,
): Map<string, string> {
  const out = new Map<string, string>();
  const read = opts.read;
  if (!read) return out;
  const seen = new Set<string>([path]);
  const queue: Array<{ from: string; root: SyntaxNode }> = [{ from: path, root }];
  while (queue.length) {
    const { from, root: node } = queue.shift()!;
    for (const b of language.imports(node)) {
      if (!b.all || seen.size > MAX_INCLUDED_FILES) continue;
      const file = language.resolveModule(b.module, from, opts.exists);
      if (!file || seen.has(file)) continue;
      seen.add(file);
      let text: string | undefined;
      try {
        text = read(file);
      } catch {
        text = undefined;
      }
      if (text === undefined || text.length > MAX_INCLUDED_BYTES) continue;
      const header = parse(parser, text);
      for (const d of language.definitions(header)) if (!out.has(d.name)) out.set(d.name, file);
      queue.push({ from: file, root: header });
    }
  }
  return out;
}

const KIND_RANK: Record<Write["kind"], number> = { deleted: 3, signature: 2, new: 1, body: 0 };

/**
 * Analyze one file with a tree-sitter language. `path` is checkout-relative; keys carry
 * `opts.prefix`. Reads include uses of this file's own declarations and of imported names
 * that resolve to files in the checkout.
 */
export async function analyzeTreeSitter(
  language: TreeSitterLanguage,
  before: string,
  after: string,
  path: string,
  opts: AnalyzeOptions = {},
): Promise<Analysis> {
  const parser = await parserFor(language);
  const prefix = opts.prefix ?? "";
  const key = (file: string, name: string): string => `${prefix}${file}#${name}`;

  const beforeTree = before ? parseTree(parser, before) : undefined;
  const beforeRoot = beforeTree?.rootNode as unknown as SyntaxNode | undefined;
  const oldDefs = definitionMap(beforeRoot ? language.definitions(beforeRoot) : []);
  const afterTree = after ? parseTree(parser, after, beforeTree && markEdit(beforeTree, before, after)) : undefined;
  const afterRoot = afterTree?.rootNode as unknown as SyntaxNode | undefined;
  const newDefs = definitionMap(afterRoot ? language.definitions(afterRoot) : []);

  // C/C++: declarations of included headers, and which of this file's definitions they own.
  const scopeRoot = afterRoot ?? beforeRoot;
  const included = scopeRoot && opts.read ? includedDeclarations(language, parser, scopeRoot, path, opts) : new Map<string, string>();
  beforeTree?.delete(); // its declarations are read; the new tree shares what it still needs
  const rekey = included.size > 0 && (language.keyToIncludes?.(path) ?? false);
  // `Cart.total` defined out of line under `using namespace shop;` is the header's `shop.Cart.total`.
  const bySuffix = new Map<string, string[]>();
  if (rekey) {
    for (const name of included.keys()) {
      const parts = name.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join(".");
        bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), name]);
      }
    }
  }
  const ownKey = (name: string): string => {
    if (rekey) {
      const file = included.get(name);
      if (file) return key(file, name);
      const candidates = name.includes(".") ? bySuffix.get(name) : undefined;
      if (candidates?.length === 1) return key(included.get(candidates[0])!, candidates[0]);
    }
    return key(path, name);
  };

  const byKey = new Map<string, Write>();
  const write = (k: string, kind: Write["kind"]): void => {
    const prev = byKey.get(k);
    if (!prev || KIND_RANK[kind] > KIND_RANK[prev.kind]) byKey.set(k, { key: k, kind });
  };
  for (const [name, d] of newDefs) {
    const old = oldDefs.get(name);
    if (!old) write(ownKey(name), "new");
    else if (normalize(old.signature) !== normalize(d.signature)) write(ownKey(name), "signature");
    else if (old.body !== d.body) write(ownKey(name), "body");
  }
  for (const name of oldDefs.keys()) if (!newDefs.has(name)) write(ownKey(name), "deleted");
  const writes = [...byKey.values()];

  const reads = new Set<string>();
  if (afterRoot) {
    const resolved = new Map<string, string | undefined>();
    const resolve = (module: string): string | undefined => {
      if (!resolved.has(module)) resolved.set(module, language.resolveModule(module, path, opts.exists, opts.read));
      return resolved.get(module);
    };
    const bindings = language
      .imports(afterRoot)
      .filter((b) => !b.all)
      .map((b): ImportBinding => {
        if (b.name === undefined || !language.memberModule || !opts.exists) return b;
        const sub = language.memberModule(b.module, b.name);
        return resolve(sub) ? { local: b.local, module: sub } : b;
      });
    // Every imported member that resolves into the checkout is an assumption of this file
    // (the TypeScript adapter does the same for named imports).
    for (const b of bindings) {
      if (b.name === undefined) continue;
      const file = resolve(b.module);
      if (file) reads.add(key(file, b.name));
    }
    // 3. Imports: `name.rest` through a member binding, `module.member` through a module one.
    const viaImport = (ref: Reference): boolean => {
      const hit = longestBinding(ref, bindings);
      if (!hit) return false;
      const file = resolve(hit.binding.module);
      if (!file) return false;
      if (hit.binding.name !== undefined) {
        reads.add(key(file, hit.binding.name));
        if (hit.rest.length) reads.add(key(file, `${hit.binding.name}.${hit.rest[0]}`));
      } else if (hit.rest.length) {
        reads.add(key(file, hit.rest[0]));
        if (hit.rest.length > 1) reads.add(key(file, `${hit.rest[0]}.${hit.rest[1]}`));
      }
      return true;
    };
    // 4. Index-based languages (Swift, C#): declarations of other files in the module/namespace.
    const fs = language.index && opts.list && opts.read
      ? { exists: opts.exists ?? ((rel: string) => opts.read!(rel) !== undefined), list: opts.list, read: opts.read }
      : undefined;
    let index: ModuleLookup | undefined;
    const viaIndex = (ref: Reference): IndexHit | undefined => {
      if (!language.index || !fs) return undefined;
      index ??= new ModuleLookup(language, language.index, parser, path, afterRoot!, bindings, fs, parse, definitionMap);
      return index.lookup(ref);
    };

    for (const first of language.references(afterRoot)) {
      for (let ref: Reference | undefined = first; ref; ref = ref.or) {
        // 1. This file's own declarations: the longest defined prefix (`Cart.tax`, else `Cart`).
        const local = longestDefined(ref, newDefs);
        // A longer match elsewhere wins (`Cart.rate` declared in an extension in another file).
        const elsewhere = !local || local.depth < ref.length ? viaIndex(ref) : undefined;
        if (elsewhere && (!local || elsewhere.depth > local.depth)) {
          for (const k of elsewhere.keys) reads.add(key(k.file, k.name));
          break;
        }
        if (local) {
          reads.add(ownKey(local.name));
          break;
        }
        // 2. Declarations of included files (C/C++ headers), keyed to the declaring file.
        if (included.size) {
          const inc = longestDefined(ref, included);
          if (inc) {
            reads.add(key(included.get(inc.name)!, inc.name));
            break;
          }
        }
        if (viaImport(ref)) break;
      }
    }
  }
  return { reads: [...reads].sort(), writes: writes.sort((a, b) => a.key.localeCompare(b.key)) };
}

/** First candidate that exists in the checkout (or, without `exists`, the first candidate). */
export function firstExisting(candidates: string[], exists?: (rel: string) => boolean): string | undefined {
  const clean = candidates.map((c) => posix.normalize(c).replace(/^\.\//, "")).filter((c) => !c.startsWith("../"));
  if (!exists) return clean[0];
  return clean.find((c) => exists(c));
}
