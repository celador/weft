// The language-agnostic contract between Weft and a language backend.
//
// Weft needs three things from an edit, whatever the language:
//   1. writes: the declarations the edit adds, deletes, or changes, and whether the change is to
//      the signature (callers must adapt) or only the body;
//   2. reads:  the declarations the edited file depends on (calls, type uses, imports), in this
//      file and in other files of the checkout;
//   3. stable symbol keys for both, in the WCP format `path#Qualified.name`.
//
// A rename is reported as `deleted` (old name) plus `new` (new name), as the TypeScript backend
// always has: callers of the old name read a deleted key, which is a strong conflict (§4.1).
//
// Backends:
//   - "typescript": the TypeScript compiler API (`analyze` in index.ts), unchanged.
//   - "tree-sitter": a WASM tree-sitter grammar plus a small per-language spec
//     (`TreeSitterLanguage` below). Fast (single-digit ms per file), no native code, no toolchain.
//   - "lsp" (planned): a language server, when installed, enriches reads asynchronously with
//     precise cross-file references. Never on the edit-time path.

/** What a change does to one declaration. */
export type WriteKind = "signature" | "body" | "new" | "deleted";
export type Write = { key: string; kind: WriteKind };
export type Analysis = { reads: string[]; writes: Write[] };

export type BackendId = "typescript" | "tree-sitter" | "lsp";

/** Does `rel` (checkout-relative, `/`-separated) exist in the checkout? */
export type Exists = (rel: string) => boolean;

/** One declaration in one file. `name` is qualified within the file (`Cart.total`). */
export type Definition = { name: string; signature: string; body: string };

/**
 * A use of a name, as a dotted path of identifiers: `calc_total(...)` is `["calc_total"]`,
 * `self.tax()` inside `class Cart` is `["Cart", "tax"]`, `pricing.calc_total(...)` is
 * `["pricing", "calc_total"]`. The engine resolves it against local definitions and imports.
 */
export type Reference = string[] & {
  /** Resolve only the full path, never a shorter prefix (`self.items` must not read `Cart`). */
  exact?: boolean;
  /** Resolve at least this many leading segments (scoped lookups: `Cart.Inner` must not read `Cart`). */
  min?: number;
  /** The first segment is a type (an enclosing type, `self`/`this`), never a namespace qualifier. */
  anchored?: boolean;
  /**
   * Tried when this reference resolves nowhere. Swift/C# implicit `self`: a bare `tax()` inside
   * `Cart` is `["Cart", "tax"]` (exact) or else the free function `["tax"]`.
   */
  or?: Reference;
};

/**
 * A name an import statement binds in this file. `local` may be dotted (`import a.b` binds
 * `a.b`). `name` is set when the import binds a member of `module` (`from m import n`), and
 * absent when it binds the module itself (`import m as local`).
 */
export type ImportBinding = { local: string; module: string; name?: string };

export interface TreeSitterLanguage {
  /** Stable id, e.g. "python". */
  id: string;
  /** Display name, e.g. "Python". */
  name: string;
  /** File extensions including the dot, lowercase. */
  extensions: string[];
  /** File name of the WASM grammar in packages/analyzer/grammars. */
  grammar: string;
  definitions(root: SyntaxNode): Definition[];
  references(root: SyntaxNode): Reference[];
  imports(root: SyntaxNode): ImportBinding[];
  /**
   * Checkout-relative file that `module` (as written in an import in `fromRel`) refers to, or
   * undefined when it is not a file in the checkout (stdlib, third-party).
   */
  resolveModule(module: string, fromRel: string, exists?: Exists): string | undefined;
  /**
   * For languages where `from pkg import sub` may import a submodule: the module spec to try
   * for member `name` of `module`. When it resolves to a file, the binding is a module binding.
   */
  memberModule?(module: string, name: string): string;
  /**
   * For languages whose declarations are visible across files without a per-file import
   * (Swift: the whole module; C#: `using` names namespaces, not files). The engine resolves
   * references that match nothing local or imported against a declaration index of the
   * directories this returns. Needs `AnalyzeOptions.list` and `read`; without them, cross-file
   * reads are skipped (local reads still work).
   */
  index?: ModuleIndex;
}

/** Directory listing and file contents of the checkout, for index-based languages. */
export type CheckoutFs = {
  exists: Exists;
  /** Entries of checkout-relative `dir` ("" = root): file names, and directory names ending in `/`. */
  list: (dir: string) => string[] | undefined;
  read: (rel: string) => string | undefined;
};

export interface ModuleIndex {
  /**
   * Checkout-relative directories (searched recursively) whose files' declarations are visible
   * from `fromRel`: Swift, the file's SwiftPM target / Xcode group plus the targets it imports;
   * C#, the solution or project directory. `imports` are this file's import bindings.
   */
  scopes(fromRel: string, imports: ImportBinding[], fs: CheckoutFs): string[];
  /**
   * Cheap textual over-approximation of the top-level names `text` declares (a regex pass, no
   * parse). The engine parses only files whose names match an unresolved reference.
   */
  declaredNames(text: string): Iterable<string>;
  /**
   * Namespace (dotted, "" = global) of each top-level declaration in file `rel`. Swift: the
   * module name, so `Pricing.calcTotal` resolves like `calcTotal`. C#: the declaring namespace.
   */
  namespaces(root: SyntaxNode, rel: string): Map<string, string>;
  /** Namespaces whose declarations a reference in this file may name unqualified. */
  visibleNamespaces(root: SyntaxNode, rel: string, imports: ImportBinding[]): string[];
  /**
   * When an unqualified reference matches no visible namespace, accept matches from any
   * namespace in scope (C#: project-wide `global using` and implicit usings live in other files).
   */
  looseNamespaces?: boolean;
}

/**
 * The subset of web-tree-sitter's `Node` the language specs use. Kept structural so specs do
 * not import the runtime.
 */
export interface SyntaxNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  parent: SyntaxNode | null;
  namedChildren: (SyntaxNode | null)[];
  children: (SyntaxNode | null)[];
  childForFieldName(field: string): SyntaxNode | null;
  childrenForFieldName(field: string): (SyntaxNode | null)[];
}

/** One file of an edit. `path` is checkout-relative; null `before`/`after` = created/deleted. */
export type SourceChange = { path: string; before: string | null; after: string | null };

export type AnalyzeOptions = {
  /** Prepended to every key (the checkout's path inside the repository, e.g. `app/`). */
  prefix?: string;
  /** Lets import resolution check the checkout. Without it, only relative imports resolve. */
  exists?: Exists;
  /**
   * Directory listing of the checkout (entries of a checkout-relative dir; directories end in
   * `/`). Optional; with `read`, enables cross-file reads for index-based languages (Swift, C#).
   */
  list?: (dir: string) => string[] | undefined;
  /** Contents of a checkout-relative file (undefined if missing). See `list`. */
  read?: (rel: string) => string | undefined;
};
