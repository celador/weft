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
//   - "lsp": a language server, when installed, enriches reads asynchronously with precise
//     cross-file definitions/references and type diagnostics (src/lsp/). Never on the
//     edit-time path; it maps locations back to keys with the tree-sitter spec.

/** What a change does to one declaration. */
export type WriteKind = "signature" | "body" | "new" | "deleted";
export type Write = { key: string; kind: WriteKind };
export type Analysis = { reads: string[]; writes: Write[] };

export type BackendId = "typescript" | "tree-sitter" | "lsp";

/** Does `rel` (checkout-relative, `/`-separated) exist in the checkout? */
export type Exists = (rel: string) => boolean;
/** Contents of checkout file `rel`, or undefined (missing, unreadable, too large, outside the checkout). */
export type ReadCheckoutFile = (rel: string) => string | undefined;
/**
 * Entries directly inside checkout directory `rel` (`""` is the root): file names, and
 * directory names ending in `/`. Undefined when the directory is missing.
 */
export type ListCheckoutDir = (rel: string) => string[] | undefined;
/** What a spec may look at in the checkout besides the edited file. */
export type Checkout = { exists?: Exists; read?: ReadCheckoutFile; list?: ListCheckoutDir };

/**
 * One declaration in one file. `name` is qualified within the file (`Cart.total`). The optional
 * offsets (JS string indices into the parsed text) let the `lsp` backend map a server location
 * back to the declaration that contains it: `start`/`end` span the whole declaration (decorators
 * included), `nameStart`/`nameEnd` its name.
 */
export type Definition = { name: string; signature: string; body: string; start?: number; end?: number; nameStart?: number; nameEnd?: number };

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
export type ImportBinding = {
  local: string;
  module: string;
  name?: string;
  /**
   * `local` is the spec's guess at the name the import binds (Go: the last import path element
   * when there is no alias); for package-scoped languages the engine replaces it with the
   * target package's declared name once it has indexed the package.
   */
  guessed?: boolean;
  /**
   * The import brings every declaration of `module` into scope, unqualified (C/C++ `#include`).
   * `local` and `name` are ignored. The engine reads the included file (`AnalyzeOptions.read`)
   * and follows its own includes.
   */
  all?: boolean;
  /**
   * The spec's guess at a name the file uses without importing it (a JVM class of the file's
   * own package). When it does not resolve and the language has a package index with
   * `importsFiles`, the name is looked up in the file's own package instead.
   */
  implicit?: boolean;
  /**
   * Module spec of a file whose top-level declarations the class named by the first segment
   * of `name` (or by `local`, for a module binding) stands for: Java calling Kotlin through the
   * generated facade class (`PricingKt.calcTotal()` -> `Pricing.kt#calcTotal`). Tried before
   * `module`; when it resolves, that segment is dropped: `name: "PricingKt"` becomes a module
   * binding of the file, `name: "PricingKt.calcTotal"` a member binding of `calcTotal`.
   */
  facade?: string;
};

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
   * undefined when it is not a file in the checkout (stdlib, third-party). `checkout` (what the
   * adapter passed in `AnalyzeOptions`) lets a spec consult project config: PHP's composer.json
   * autoload map, Go's go.mod; package-scoped languages return a directory (see `packageFiles`).
   */
  resolveModule(module: string, fromRel: string, exists?: Exists, checkout?: Checkout): string | undefined;
  /**
   * For languages where `from pkg import sub` may import a submodule: the module spec to try
   * for member `name` of `module`. When it resolves to a file, the binding is a module binding.
   */
  memberModule?(module: string, name: string): string;
  /** Node types that are identifiers (what the `lsp` backend asks definitions for). Default `["identifier"]`. */
  identifierTypes?: string[];
  /**
   * Package-scoped languages (Go; Kotlin with `importsFiles`), where every file of a directory shares one namespace. When
   * set, `resolveModule` returns the package's directory, and names resolve through a
   * declaration index of that directory: the engine lists it, keeps the files this returns,
   * parses them and maps each declaration to the file that declares it. Keys stay file-level
   * (`shop/pricing/pricing.go#CalcTotal`) so writes and reads match. A name the edited file uses
   * but does not declare resolves through the index of its own directory. Needs
   * `AnalyzeOptions.read` and `.list`; without them only same-file reads are found.
   */
  packageFiles?(dir: string, entries: string[], fromRel: string): string[];
  /**
   * With `packageFiles`: imports name files, not package directories (Kotlin), so they resolve
   * as in any other language, and the package index only serves names the edited file uses
   * without declaring or importing them (same-package top-level functions in other files).
   */
  importsFiles?: boolean;
  /** Whether a declaration of another file of the package is visible here (Kotlin: not `private`). Default: all are. */
  packageVisible?(definition: Definition): boolean;
  /** The package a file's text belongs to (Go `package x`); index files of other packages are skipped. */
  packageName?(text: string): string | undefined;
  /**
   * Cheap textual over-approximation of the top-level names a package file declares (a regex
   * pass; methods as `Type.Method` and `Type`). The index parses only the files whose names
   * match a lookup. Without it every file of the package is parsed.
   */
  packageDeclaredNames?(text: string): Iterable<string>;
  /**
   * C/C++: true when a definition in `path` that an included file also declares is keyed to
   * the included file (a `.c` definition shares its header prototype's key: callers read the
   * header). False for headers themselves.
   */
  keyToIncludes?(path: string): boolean;
  /**
   * The id of the language that should analyze this text instead, when one extension is shared
   * (a `.h` file written in C++). Undefined keeps this language.
   */
  refine?(path: string, text: string): string | undefined;
  /**
   * For languages whose declarations are visible across files without a per-file import
   * (Swift: the whole module; C#: `using` names namespaces, not files). The engine resolves
   * references that match nothing local or imported against a declaration index of the
   * directories this returns. Needs `AnalyzeOptions.list` and `read`; without them, cross-file
   * reads are skipped (local reads still work).
   */
  index?: ModuleIndex;
}

/** `Checkout` with every capability present: what the module index (Swift, C#) needs. */
export type CheckoutFs = Required<Checkout>;

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
   * Reads a checkout file (checkout-relative path, undefined if missing): C/C++ `#include`d
   * declarations, Go's go.mod, PHP's composer.json, and with `list` the package index (Go,
   * Kotlin) and the module index (Swift, C#). Without it, none of those are seen.
   */
  read?: ReadCheckoutFile;
  /**
   * Lists a checkout directory (entries of a checkout-relative dir; directories end in `/`).
   * With `read`, enables the package index (Go, Kotlin) and the module index (Swift, C#).
   */
  list?: ListCheckoutDir;
};
