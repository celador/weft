// The tree-sitter backend: one generic engine, one small spec per language.
//
// The engine parses before/after with the language's WASM grammar, diffs the declarations the
// spec extracts (signature vs body), and resolves the spec's references against the file's own
// declarations and its imports. Everything is in-process and synchronous after the first load
// (runtime + grammar load once per process, ~10 ms).
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { findGrammar, findRuntimeWasm } from "./assets.js";
import type { Analysis, AnalyzeOptions, Definition, ImportBinding, SyntaxNode, TreeSitterLanguage, Write } from "./language.js";

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

function parse(parser: Parser, text: string): SyntaxNode {
  const tree = parser.parse(text);
  if (!tree) throw new Error("tree-sitter returned no tree");
  return tree.rootNode as unknown as SyntaxNode;
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

  const oldDefs = definitionMap(before ? language.definitions(parse(parser, before)) : []);
  const afterRoot = after ? parse(parser, after) : undefined;
  const newDefs = definitionMap(afterRoot ? language.definitions(afterRoot) : []);

  const writes: Write[] = [];
  for (const [name, d] of newDefs) {
    const old = oldDefs.get(name);
    if (!old) writes.push({ key: key(path, name), kind: "new" });
    else if (normalize(old.signature) !== normalize(d.signature)) writes.push({ key: key(path, name), kind: "signature" });
    else if (old.body !== d.body) writes.push({ key: key(path, name), kind: "body" });
  }
  for (const name of oldDefs.keys()) if (!newDefs.has(name)) writes.push({ key: key(path, name), kind: "deleted" });

  const reads = new Set<string>();
  if (afterRoot) {
    const checkout = { exists: opts.exists, read: opts.read, list: opts.list };
    const resolved = new Map<string, string | undefined>();
    const resolve = (module: string): string | undefined => {
      if (!resolved.has(module)) resolved.set(module, language.resolveModule(module, path, opts.exists, checkout));
      return resolved.get(module);
    };
    const packages = packageIndexer(language, parser, path, after, opts);
    let bindings = language.imports(afterRoot).map((b): ImportBinding => {
      if (b.name === undefined || !language.memberModule || !opts.exists) return b;
      const sub = language.memberModule(b.module, b.name);
      return resolve(sub) ? { local: b.local, module: sub } : b;
    });
    if (packages) {
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
    for (const ref of language.references(afterRoot)) {
      // 1. This file's own declarations: the longest defined prefix (`Cart.tax`, else `Cart`).
      let local: string | undefined;
      for (let n = ref.length; n >= (ref.exact ? ref.length : 1) && !local; n--) {
        const name = ref.slice(0, n).join(".");
        if (newDefs.has(name)) local = name;
      }
      if (local) {
        reads.add(key(path, local));
        continue;
      }
      // 2. Imports: `name.rest` through a member binding, `module.member` through a module one.
      const hit = longestBinding(ref, bindings);
      if (hit) {
        const file = resolve(hit.binding.module);
        if (!file) continue;
        if (packages) {
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
        continue;
      }
      // 3. Package-scoped languages: the other files of this file's own package.
      if (packages && ref.length) packageReads(dirOf(path), ref.exact ? ref : ref.slice(0, 2), ref.exact);
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
        for (const d of language.definitions(parse(parser, text))) if (!names.has(d.name)) names.set(d.name, rel);
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
