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
   * undefined when it is not a file in the checkout (stdlib, third-party).
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
   * Package-scoped languages (Go), where every file of a directory shares one namespace. When
   * set, `resolveModule` returns the package's directory, and names resolve through a
   * declaration index of that directory: the engine lists it, keeps the files this returns,
   * parses them and maps each declaration to the file that declares it. Keys stay file-level
   * (`shop/pricing/pricing.go#CalcTotal`) so writes and reads match. A name the edited file uses
   * but does not declare resolves through the index of its own directory. Needs
   * `AnalyzeOptions.read` and `.list`; without them only same-file reads are found.
   */
  packageFiles?(dir: string, entries: string[], fromRel: string): string[];
  /** The package a file's text belongs to (Go `package x`); index files of other packages are skipped. */
  packageName?(text: string): string | undefined;
  /**
   * Cheap textual over-approximation of the top-level names a package file declares (a regex
   * pass; methods as `Type.Method` and `Type`). The index parses only the files whose names
   * match a lookup. Without it every file of the package is parsed.
   */
  packageDeclaredNames?(text: string): Iterable<string>;
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
  /** Reads other checkout files (go.mod, the files of a Go package). Optional. */
  read?: ReadCheckoutFile;
  /** Lists checkout directories (the files of a Go package). Optional. */
  list?: ListCheckoutDir;
};
