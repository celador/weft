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
    const resolved = new Map<string, string | undefined>();
    const resolve = (module: string): string | undefined => {
      if (!resolved.has(module)) resolved.set(module, language.resolveModule(module, path, opts.exists));
      return resolved.get(module);
    };
    const bindings = language.imports(afterRoot).map((b): ImportBinding => {
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
      if (!hit) continue;
      const file = resolve(hit.binding.module);
      if (!file) continue;
      if (hit.binding.name !== undefined) {
        reads.add(key(file, hit.binding.name));
        if (hit.rest.length) reads.add(key(file, `${hit.binding.name}.${hit.rest[0]}`));
      } else if (hit.rest.length) {
        reads.add(key(file, hit.rest[0]));
        if (hit.rest.length > 1) reads.add(key(file, `${hit.rest[0]}.${hit.rest[1]}`));
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
