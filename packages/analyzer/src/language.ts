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
   * The import brings every declaration of `module` into scope, unqualified (C/C++ `#include`).
   * `local` and `name` are ignored. The engine reads the included file (`AnalyzeOptions.read`)
   * and follows its own includes.
   */
  all?: boolean;
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
  resolveModule(module: string, fromRel: string, exists?: Exists): string | undefined;
  /**
   * For languages where `from pkg import sub` may import a submodule: the module spec to try
   * for member `name` of `module`. When it resolves to a file, the binding is a module binding.
   */
  memberModule?(module: string, name: string): string;
  /** Node types that are identifiers (what the `lsp` backend asks definitions for). Default `["identifier"]`. */
  identifierTypes?: string[];
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
   * Reads a checkout file (checkout-relative path), for languages whose imports bring a whole
   * file into scope (C/C++ `#include`). Without it, included declarations are not seen.
   */
  read?: (rel: string) => string | undefined;
};
