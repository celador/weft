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
    const checkout = { exists: opts.exists, read: opts.read, list: opts.list };
    const resolved = new Map<string, string | undefined>();
    const resolve = (module: string): string | undefined => {
      if (!resolved.has(module)) resolved.set(module, language.resolveModule(module, path, opts.exists, checkout));
      return resolved.get(module);
    };
    const packages = packageIndexer(language, parser, path, after, opts);
    let bindings = language
      .imports(afterRoot)
      .filter((b) => !b.all)
      .map((b): ImportBinding => {
        if (b.name === undefined || !language.memberModule || !opts.exists) return b;
        const sub = language.memberModule(b.module, b.name);
        return resolve(sub) ? { local: b.local, module: sub } : b;
      })
      .map((b): ImportBinding => {
        // Java's `PricingKt.calcTotal()`: the facade class stands for Pricing.kt's top level.
        if (!b.facade || !resolve(b.facade)) return b;
        const rest = b.name?.split(".").slice(1) ?? [];
        return rest.length ? { local: b.local, module: b.facade, name: rest.join(".") } : { local: b.local, module: b.facade };
      });
    const packageImports = packages !== undefined && !language.importsFiles;
    if (packageImports) {
      // `import "example.com/shop/pricing-v2"` binds whatever `package` the directory declares.
      bindings = bindings.map((b) => {
        if (!b.guessed) return b;
        const dir = resolve(b.module);
        const name = dir === undefined ? undefined : packages(dir).name;
        return name ? { ...b, local: name } : b;
      });
    }
    // Every imported member that resolves into the checkout is an assumption of this file
    // (the TypeScript adapter does the same for named imports).
    for (const b of bindings) {
      if (b.name === undefined) continue;
      const file = resolve(b.module);
      if (file) reads.add(key(file, b.name));
    }
    /** `rest` looked up in package `dir`: the declaring file's keys for rest[0] and rest[0].rest[1]. */
    const packageReads = (dir: string, rest: string[], exact = false): boolean => {
      const index = packages!(dir);
      let found = false;
      for (let n = Math.min(rest.length, 2); n >= (exact ? rest.length : 1); n--) {
        const name = rest.slice(0, n).join(".");
        const file = index.lookup(name);
        if (file) {
          reads.add(key(file, name));
          found = true;
        }
      }
      return found;
    };
    /**
     * 3. Imports: `name.rest` through a member binding, `module.member` through a module one.
     * "read" when the reference resolved through an import into the checkout; "outside" when it
     * names an import that resolves outside it (stdlib, third-party), which hides same-package
     * names; undefined when no import binds it.
     */
    const viaImport = (ref: Reference): "read" | "outside" | undefined => {
      const hit = longestBinding(ref, bindings);
      if (!hit) return undefined;
      const file = resolve(hit.binding.module);
      // A guessed class name of the file's own package (Kotlin `implicit`) hides nothing.
      if (!file) return hit.binding.implicit && language.importsFiles ? undefined : "outside";
      if (packageImports) {
        if (hit.binding.name === undefined && hit.rest.length) packageReads(file, hit.rest);
      } else if (hit.binding.name !== undefined) {
        reads.add(key(file, hit.binding.name));
        if (hit.rest.length) reads.add(key(file, `${hit.binding.name}.${hit.rest[0]}`));
      } else if (hit.rest.length) {
        // `util.money.round` through module `util`: descend into submodules that are files.
        let module = hit.binding.module;
        let target = file;
        let rest = hit.rest;
        while (rest.length > 1 && language.memberModule && opts.exists) {
          const sub = language.memberModule(module, rest[0]);
          const subFile = resolve(sub);
          if (!subFile) break;
          module = sub;
          target = subFile;
          rest = rest.slice(1);
        }
        reads.add(key(target, rest[0]));
        if (rest.length > 1) reads.add(key(target, `${rest[0]}.${rest[1]}`));
      }
      return "read";
    };
    // 4a. Module index (Swift, C#): declarations of other files in the module/namespace.
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
      // `ref.or`: alternatives tried in order when a reference resolves nowhere (Swift/C# implicit `self`).
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
        const imported = viaImport(ref);
        if (imported === "read") break;
        // 4b. Package index (Go, Kotlin): the other files of this file's own package. An import
        // that resolves outside the checkout hides same-package names.
        if (imported === undefined && packages && ref.length && packageReads(dirOf(path), ref.exact ? ref : ref.slice(0, 2), ref.exact)) break;
      }
    }
  }
  return { reads: [...reads].sort(), writes: writes.sort((a, b) => a.key.localeCompare(b.key)) };
}

/** Checkout-relative directory of `rel` (`""` for the root). */
export function dirOf(rel: string): string {
  const dir = posix.dirname(rel);
  return dir === "." ? "" : dir;
}

type PackageIndex = {
  /** The package name importers bind (`package x` of most files, external tests ignored). */
  name?: string;
  /** The checkout file that declares `name` in this package, if any. */
  lookup(name: string): string | undefined;
};

/** Most files a package index reads, and the largest file it reads (characters). */
const MAX_PACKAGE_FILES = 400;
const MAX_PACKAGE_FILE = 1 << 20;

/**
 * For package-scoped languages: a lazy, per-analysis declaration index of package
 * directories (declaration name -> declaring file). Files are read once; a file is parsed only
 * when its textual name list (`packageDeclaredNames`) matches a lookup. The edited file is never
 * indexed from disk (the hook may run before the edit lands): its own declarations are already
 * resolved locally. Undefined when the language is not package-scoped; lookups find nothing
 * when the checkout cannot be listed and read.
 */
function packageIndexer(
  language: TreeSitterLanguage,
  parser: Parser,
  path: string,
  afterText: string,
  opts: AnalyzeOptions,
): ((dir: string) => PackageIndex) | undefined {
  if (!language.packageFiles) return undefined;
  const { read, list } = opts;
  const own = dirOf(path);
  const ownPackage = language.packageName?.(afterText);
  const cache = new Map<string, PackageIndex>();
  return (dir: string): PackageIndex => {
    const hit = cache.get(dir);
    if (hit) return hit;
    const names = new Map<string, string>();
    const pending = new Map<string, Set<string>>(); // top-level name -> files not yet parsed
    const texts = new Map<string, string>();
    const counts = new Map<string, number>();
    const unparsed: string[] = [];
    if (read && list) {
      const files = language.packageFiles!(dir, list(dir) ?? [], path).slice(0, MAX_PACKAGE_FILES);
      for (const f of files) {
        const rel = dir ? `${dir}/${f}` : f;
        if (rel === path) continue;
        const text = read(rel);
        if (text === undefined || text.length > MAX_PACKAGE_FILE) continue;
        const pkg = language.packageName?.(text);
        if (dir === own && ownPackage && pkg && pkg !== ownPackage) continue; // `package x_test` next to `package x`
        if (pkg) counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
        texts.set(rel, text);
        if (!language.packageDeclaredNames) {
          unparsed.push(rel);
          continue;
        }
        for (const n of language.packageDeclaredNames(text)) {
          const top = n.split(".")[0];
          let set = pending.get(top);
          if (!set) pending.set(top, (set = new Set()));
          set.add(rel);
        }
      }
    }
    const index = (rel: string): void => {
      const text = texts.get(rel);
      if (text === undefined) return;
      texts.delete(rel);
      try {
        for (const d of language.definitions(parse(parser, text))) {
          if (language.packageVisible && !language.packageVisible(d)) continue;
          if (!names.has(d.name)) names.set(d.name, rel);
        }
      } catch {
        /* unparsable file: no declarations */
      }
    };
    const named = [...counts].filter(([n]) => !n.endsWith("_test")).sort((x, y) => y[1] - x[1]);
    const result: PackageIndex = {
      name: dir === own ? ownPackage : named[0]?.[0],
      lookup(name: string): string | undefined {
        if (unparsed.length) unparsed.splice(0).forEach(index);
        const top = name.split(".")[0];
        const files = pending.get(top);
        if (files) {
          pending.delete(top);
          [...files].sort().forEach(index);
        }
        return names.get(name);
      },
    };
    cache.set(dir, result);
    return result;
  };
}

/** First candidate that exists in the checkout (or, without `exists`, the first candidate). */
export function firstExisting(candidates: string[], exists?: (rel: string) => boolean): string | undefined {
  const clean = candidates.map((c) => posix.normalize(c).replace(/^\.\//, "")).filter((c) => !c.startsWith("../"));
  if (!exists) return clean[0];
  return clean.find((c) => exists(c));
}

/** An identifier occurrence: its text and JS string offsets in the parsed text. */
export type Identifier = { text: string; start: number; end: number };
/** Declarations (with offsets, when the spec provides them) and identifiers of one text. */
export type Outline = { definitions: Definition[]; identifiers: Identifier[] };

/** Parse `text` once and list its declarations and identifiers (used by the `lsp` backend). */
export async function outlineTreeSitter(language: TreeSitterLanguage, text: string): Promise<Outline> {
  const parser = await parserFor(language);
  const root = parse(parser, text);
  const types = new Set(language.identifierTypes ?? ["identifier"]);
  const identifiers: Identifier[] = [];
  const visit = (node: SyntaxNode): void => {
    if (types.has(node.type)) identifiers.push({ text: node.text, start: node.startIndex, end: node.endIndex });
    for (const c of node.namedChildren) if (c) visit(c);
  };
  visit(root);
  return { definitions: language.definitions(root), identifiers };
}
