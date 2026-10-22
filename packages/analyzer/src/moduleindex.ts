// Declaration index for languages without per-file imports (Swift, C#).
//
// Swift sees every declaration of its module (a SwiftPM target or Xcode group) without an
// import; C#'s `using` names a namespace, not a file. To turn a reference into a
// `path#Qualified.name` key, the engine needs to know which file of the module declares it.
//
// Design (docs/languages.md, "Module index"):
//   - Scope: the language's `index.scopes()` names the directories to search (Swift: the
//     file's target plus the targets it imports; C#: the solution or project directory).
//   - Lazy: the index is built only when a reference matches nothing in the edited file itself,
//     and at most once per analysis.
//   - Cheap first pass: every file in scope is read and a single regex pass
//     (`index.declaredNames`) lists the names it may declare. No parse.
//   - Parse on demand: only files whose names match an unresolved reference are parsed, and the
//     result is cached per process by file contents, so long-lived adapters (watcher, MCP) parse
//     each file once until it changes.
//   - Bounded: at most MAX_FILES files and MAX_DEPTH directory levels per scope; build output,
//     dependency and hidden directories are skipped.
//   - Namespaces: a reference may name a declaration unqualified when its namespace is visible
//     (`index.visibleNamespaces`: C# usings + enclosing namespaces; Swift the module and its
//     imports), or qualified by its namespace (`Shop.Pricing.PriceCalculator`, `Pricing.calcTotal`).
import { posix } from "node:path";
import type { Parser } from "web-tree-sitter";
import type { CheckoutFs, Definition, ImportBinding, ModuleIndex, Reference, SyntaxNode, TreeSitterLanguage } from "./language.js";

export const MAX_FILES = 4000;
const MAX_DEPTH = 12;
const SKIP_DIR = /^(?:\.|node_modules\/$|\.build\/$|DerivedData\/$|Pods\/$|Carthage\/$|bin\/$|obj\/$)/;

export type IndexHit = { depth: number; keys: { file: string; name: string }[] };

type Parsed = { defs: Map<string, Definition>; ns: Map<string, string> };
type Cached = { text: string; names: Set<string>; parsed?: Parsed };

/** Per-process cache, keyed by language + checkout-relative path, invalidated by contents. */
const cache = new Map<string, Cached>();

/** For tests: forget everything cached. */
export function clearModuleIndexCache(): void {
  cache.clear();
}

/** The longest prefix of `ref` that `defs` declares (only the whole path when `ref.exact`). */
export function longestDefined(ref: string[] & { exact?: boolean; min?: number }, defs: Map<string, unknown>): { name: string; depth: number } | undefined {
  for (let n = ref.length; n >= (ref.exact ? ref.length : Math.max(1, ref.min ?? 1)); n--) {
    const name = ref.slice(0, n).join(".");
    if (defs.has(name)) return { name, depth: n };
  }
  return undefined;
}

export class ModuleLookup {
  private byName?: Map<string, string[]>;
  private readonly visible: string[];

  constructor(
    private readonly language: TreeSitterLanguage,
    private readonly index: ModuleIndex,
    private readonly parser: Parser,
    private readonly path: string,
    root: SyntaxNode,
    private readonly bindings: ImportBinding[],
    private readonly fs: CheckoutFs,
    private readonly parse: (parser: Parser, text: string) => SyntaxNode,
    private readonly definitionMap: (defs: Definition[]) => Map<string, Definition>,
  ) {
    this.visible = index.visibleNamespaces(root, path, bindings);
  }

  /** Files of the scopes (recursively), excluding the edited file. */
  private files(): string[] {
    const out = new Set<string>();
    const exts = this.language.extensions;
    const walk = (dir: string, depth: number): void => {
      if (out.size >= MAX_FILES || depth > MAX_DEPTH) return;
      const entries = this.fs.list(dir);
      if (!entries) return;
      for (const e of [...entries].sort()) {
        if (out.size >= MAX_FILES) return;
        const rel = dir ? `${dir}/${e}` : e;
        if (e.endsWith("/")) {
          if (!SKIP_DIR.test(e)) walk(rel.slice(0, -1), depth + 1);
        } else if (exts.includes(posix.extname(e).toLowerCase()) && rel !== this.path) out.add(rel);
      }
    };
    for (const scope of new Set(this.index.scopes(this.path, this.bindings, this.fs))) walk(scope === "." ? "" : scope.replace(/\/$/, ""), 0);
    return [...out];
  }

  private entry(rel: string): Cached | undefined {
    const text = this.fs.read(rel);
    if (text === undefined) return undefined;
    const k = `${this.language.id}\0${rel}`;
    let c = cache.get(k);
    if (!c || c.text !== text) {
      c = { text, names: new Set(this.index.declaredNames(text)) };
      cache.set(k, c);
    }
    return c;
  }

  private build(): Map<string, string[]> {
    const byName = new Map<string, string[]>();
    for (const rel of this.files()) {
      const c = this.entry(rel);
      if (!c) continue;
      for (const n of c.names) {
        const list = byName.get(n);
        if (list) list.push(rel);
        else byName.set(n, [rel]);
      }
    }
    return byName;
  }

  private parsed(rel: string): Parsed | undefined {
    const c = this.entry(rel);
    if (!c) return undefined;
    if (!c.parsed) {
      try {
        const root = this.parse(this.parser, c.text);
        c.parsed = { defs: this.definitionMap(this.language.definitions(root)), ns: this.index.namespaces(root, rel) };
      } catch {
        c.parsed = { defs: new Map(), ns: new Map() };
      }
    }
    return c.parsed;
  }

  /** May `prefix` (dotted, "" = none) qualify a declaration in namespace `ns` from this file? */
  private allows(ns: string, prefix: string): boolean {
    if (!prefix) return this.visible.includes(ns);
    if (prefix === ns) return true;
    return this.visible.some((v) => v !== "" && `${v}.${prefix}` === ns);
  }

  /** The declarations `ref` names in other files of the scope, by longest match. */
  lookup(ref: Reference): IndexHit | undefined {
    return this.search(ref, false) ?? (this.index.looseNamespaces ? this.search(ref, true) : undefined);
  }

  private search(ref: Reference, loose: boolean): IndexHit | undefined {
    this.byName ??= this.build();
    let best: IndexHit | undefined;
    for (let p = 0; p < (loose || ref.anchored ? 1 : ref.length); p++) {
      const files = this.byName.get(ref[p]);
      if (!files) continue;
      const prefix = ref.slice(0, p).join(".");
      const rest: Reference = ref.slice(p);
      rest.exact = ref.exact;
      if (ref.min !== undefined) rest.min = ref.min - p;
      for (const file of files) {
        const parsed = this.parsed(file);
        const ns = parsed?.ns.get(ref[p]);
        if (!parsed || ns === undefined || !(loose || this.allows(ns, prefix))) continue;
        const hit = longestDefined(rest, parsed.defs);
        if (!hit) continue;
        const depth = p + hit.depth;
        if (!best || depth > best.depth) best = { depth, keys: [{ file, name: hit.name }] };
        else if (depth === best.depth) best.keys.push({ file, name: hit.name });
      }
    }
    return best;
  }
}
