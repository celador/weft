# Languages

Weft's conflict checks are language-agnostic at the protocol level: an edit event carries
`reads` and `writes` keyed `path#Qualified.name` (WCP §4.1), and the coordinator never parses
code. The adapter derives those sets from the edit with `@weft/analyzer`, which has one backend
per language family.

## Support matrix

| Language | Extensions | Backend | Declarations (writes) | Uses (reads) | Signature vs body | Renames | Tested |
|---|---|---|---|---|---|---|---|
| TypeScript / JavaScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `typescript` (TS compiler API) | functions, classes, methods, properties, interfaces, type aliases, enums, variables | calls, `new`, type references, named/namespace/default imports of relative modules | yes | deleted + new | unit tests, core conformance fixtures (L0–L3), real agent runs |
| Python | `.py .pyi` | `tree-sitter` (tree-sitter-python 0.25.0) | functions, classes, methods (`Cart.total`), module- and class-level assignments | calls, decorators, base classes, type annotations, attribute chains (`pricing.calc_total`, `self.tax`), every imported member that resolves into the checkout | yes (decorators count as signature; whitespace and trailing commas do not; an assignment's annotation is its signature and its value its body) | deleted + new | 13 analyzer tests, 5 conformance fixtures (`fixtures/languages/python`), real two-agent Claude Code run ([record](research/python-real-run-2026-10-22.md)) |
| Java | `.java` | `tree-sitter` (tree-sitter-java 0.23.5) | classes, interfaces, enums, records, annotation types (nested: `Pricing.Kind`), methods (overloads share a key), fields, enum constants, record components | calls (`calcTotal()`, `this.tax()`, `Fmt.round()`), `new`, every type use, annotations, field accesses, method references, unqualified members of enclosing classes; single-type, static, wildcard and same-package imports, as `.java` or `.kt` | yes (constructors count as the class's signature; comments and `@Override`/`@Deprecated`/`@SuppressWarnings` do not; other annotations do) | deleted + new | 16 analyzer tests, 5 conformance fixtures (`fixtures/languages/java`) |
| Kotlin | `.kt .kts` | `tree-sitter` (@tree-sitter-grammars/tree-sitter-kotlin 1.1.0) | classes, interfaces, objects, enum entries, type aliases, functions and properties (top-level, members, companion members as `Cart.create`), extensions by name (`discount`), `val`/`var` constructor parameters | calls, constructor calls, every type use, navigation (`Item.ZERO`, `Cart::total`), `this`, extension receivers, unqualified members; class, top-level-function, aliased, wildcard and same-directory imports, Kotlin → Java interop | yes (primary and secondary constructors count as the class's signature; `@JvmStatic`/`@JvmName` count; `@Deprecated`/`@Suppress` and comments do not) | deleted + new | 14 analyzer tests, 5 conformance fixtures (`fixtures/languages/kotlin`, incl. Kotlin calling a changed Java method) |
| Go | `.go` | `tree-sitter` (tree-sitter-go 0.25.0) | functions, methods keyed by receiver type (`Cart.Total`), types and interfaces, package-level consts/vars | calls, selector chains (`pricing.CalcTotal`, receiver calls `c.Tax()` → `Cart.Tax`), type uses (`Item`, `pricing.Item`, composite literals); imports resolve through `go.mod` to a package directory, and names used but not declared in the file resolve through its own package (see [Go packages](#go-packages)) | yes (the receiver is part of a method's signature; a struct's fields and an interface's methods are the type's signature; a const/var's type is its signature, its value the body; gofmt alignment and trailing commas are not changes) | deleted + new | 12 analyzer tests, 5 conformance fixtures (`fixtures/languages/go`, incl. a same-package cross-file deny) |
| Rust | `.rs` | `tree-sitter` (tree-sitter-rust 0.24.0) | functions, impl/trait methods keyed by type (`Cart.total`, `impl Display for Cart` → `Cart.fmt`, `Shape.area`), structs, enums, unions, traits, type aliases, consts, statics, items of inline modules (`tests.t`) | calls, paths (`pricing::calc_total`, `Self::new`, `Kind::A`), `self.tax()` → `Cart.tax`, type uses, calls and paths inside macro arguments (`format!(.., calc_total(x))`); `use` trees (`{self, x, y as z}`), `mod x;`, and `crate::`/`self::`/`super::` paths resolve to `src/a/b.rs` or `src/a/b/mod.rs` under the nearest `Cargo.toml` | yes (outer attributes such as `#[derive]` are signature; a struct's fields and an enum's variants are its signature; a const/static's type is its signature, its value the body) | deleted + new | 11 analyzer tests, 5 conformance fixtures (`fixtures/languages/rust`) |
| Swift, C# | | `tree-sitter` | planned | | | | card t_232556f9 |
| Ruby, PHP | | `tree-sitter` | planned | | | | card t_da702770 |
| C | `.c .h` | `tree-sitter` (tree-sitter-c 0.24.1) | functions (definitions and prototypes), structs / unions / enums and their fields (`Item.price`), enumerators, typedefs, global variables, macros (`#define`) | every identifier and type name outside a declarator (calls, arguments, types, macro and enumerator uses), identifiers in macro bodies, `item->price` when `item`'s declared type is named; included headers' declarations, through `#include "x.h"` (relative, then `include/`, `src/`) and `<x.h>` (`include/`, `src/`), transitively | yes (a prototype change in the header is a signature write; a macro's parameter list is its signature, its value its body; an initializer is a body) | deleted + new | analyzer tests (`c.test.ts`), 5 conformance fixtures (`fixtures/languages/c`) |
| C++ | `.cpp .cc .cxx .c++ .hpp .hh .hxx .h++ .ipp .tpp .inl`, and `.h` files whose text is C++ | `tree-sitter` (tree-sitter-cpp 0.23.4) | everything C has, plus classes and their members (`shop.Cart.total`; out-of-line `Cart::total` keyed the same), namespaces as qualifiers, `using` aliases, templates, scoped enums (`Mode.Net`) | as C, plus qualified names (`shop::calc`, `Mode::Net`), `this->x` and implicit members (`tax()` in `Cart::total` reads `Cart.tax`), `cart.total()` when `cart` is a parameter or local of a named type (`auto` is not inferred), template arguments | yes (the `template <...>` list and member access `public:`/`private:` are signature; constructor initializer lists are body) | deleted + new | analyzer tests (`c.test.ts`), 4 conformance fixtures (`fixtures/languages/cpp`) |
| Anything else | | none | whole file: `path#*` | none | no | no | the adapters' existing fallback |

### Java and Kotlin notes

- **Grammars** (vendored in `packages/analyzer/grammars/`, copied from each npm package):

  | file | npm package | sha256 |
  |---|---|---|
  | `tree-sitter-java.wasm` | tree-sitter-java 0.23.5 | `4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4` |
  | `tree-sitter-kotlin.wasm` | @tree-sitter-grammars/tree-sitter-kotlin 1.1.0 | `7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7` |

  Both are ABI 14 and load with web-tree-sitter 0.25.10.

- **Module resolution.** An import names a class, not a file. `import com.shop.model.Item`
  resolves to `com/shop/model/Item.java` or `.kt` under `src/main/java`, `src/main/kotlin`,
  `src`, the checkout root, or an ancestor of the importing file (multi-module builds:
  `app/src/main/java`); Kotlin tries `.kt` first, Java `.java` first, so either language can
  import the other. The first capitalized segment is the class (`com.shop.Outer.Inner` is member
  `Outer.Inner` of `Outer.java`). Classes used without an import resolve next to the file (same
  package) or in a wildcard-imported package. `java.*`, `javax.*`, `kotlin.*`, `kotlinx.*`,
  `android.*` and `androidx.*` never touch the file system.
- **Kotlin files are not named after their classes.** A Kotlin import that misses
  `<Class>.kt` falls back to the package's `<LastSegment>.kt` (`Cart` in
  `com/shop/pricing/Pricing.kt`); a top-level function import (`com.shop.pricing.calcTotal`)
  looks in `<LastSegment>.kt` and `<Name>.kt`, `.kt` only. Anything else (top-level functions
  of the same package in another file, `FooKt` facades called from Java, static wildcard imports)
  is not resolved; the LSP enrichment below covers it.
- **Extensions are keyed by name.** `fun Cart.discount()` is `Pricing.kt#discount`, because
  Kotlin imports extensions by name and callers write `cart.discount()`; the receiver is part of
  the signature.
- **Constructors.** Callers reach a constructor through the class name (`new Pricing(...)`,
  `Cart(...)`), so constructor parameters are part of the class's signature, in both languages.
- **Grammar speed.** The Kotlin grammar is about ten times slower than the Java and Python ones
  on lambda-heavy code. The engine parses `after` incrementally from the parse of `before`
  (`markEdit` in `treesitter.ts`, every language), so an edit costs one full parse plus a
  near-free reparse. CPU time per edit check, `before` + `after`, M-series MacBook Pro:

  | file | lines | CPU |
  |---|---|---|
  | okhttp `OkHttpClient.kt` | 1,398 | 31 ms |
  | okhttp `HttpUrl.kt` | 1,817 | 59 ms |
  | kotlin stdlib `_Strings.kt` (generated, worst case seen) | 2,592 | 234 ms |
  | guava `ImmutableList.java` | 957 | 17 ms |
  | test file `kotlin.test.ts` (2,100 lines) / `java.test.ts` (2,100 lines) | | 110 ms / 28 ms |

A file in a language without a backend still takes part: its edits write `path#*`, so two
agents editing the same file in the same window still see each other, at file granularity.

Language-server enrichment (`lsp` backend: pyright/basedpyright, gopls, rust-analyzer, jdtls,
kotlin-lsp, sourcekit-lsp, clangd, ruby-lsp, csharp-ls) is designed below and not built yet. For
C/C++, clangd would add what the tree-sitter pass cannot see: `auto`, overloads, macro expansion.

## How the tree-sitter backend works

`packages/analyzer/src/treesitter.ts` is one generic engine; each language is a small spec
(`TreeSitterLanguage` in `src/language.ts`) plus a vendored WASM grammar in
`packages/analyzer/grammars/`:

```ts
interface TreeSitterLanguage {
  id: string; name: string; extensions: string[]; grammar: string;   // "tree-sitter-python.wasm"
  definitions(root): Definition[];   // { name: "Cart.total", signature, body }
  references(root): Reference[];     // ["pricing", "calc_total"], ["Cart", "tax"] (exact)
  imports(root): ImportBinding[];    // { local: "ct", module: ".pricing", name: "calc_total" }
  resolveModule(module, fromRel, exists?): string | undefined;   // ".pricing" -> "app/pricing.py"
  memberModule?(module, name): string;   // `from pkg import sub` may import a module
  keyToIncludes?(path): boolean;          // C/C++: a .c definition takes its header's key
  refine?(path, text): string | undefined; // `.h` written in C++ -> "cpp"
}
// ImportBinding.all: the import brings every declaration of the module into scope (#include);
// the engine reads it with AnalyzeOptions.read.
```

For each changed file the engine parses before and after, diffs the declarations
(`new` / `deleted` / `signature` / `body`), and resolves references against the file's own
declarations first, then its imports. Imported members that resolve to a file in the checkout
are reads, the same rule the TypeScript adapter applies to named imports. Modules outside the
checkout (stdlib, packages) are ignored.

Runtime: `web-tree-sitter` 0.25.10 (WASM, no native build, no toolchain). Adapters bundle the
analyzer and copy the WASM files to `dist/grammars/` at build time
(`packages/analyzer/scripts/copy-assets.mjs`); `WEFT_GRAMMARS_DIR` overrides the lookup.

Vendored grammars (`packages/analyzer/grammars/`, copied from each grammar's npm package):

| Grammar | npm version | ABI | sha256 |
|---|---|---|---|
| `tree-sitter-python.wasm` | tree-sitter-python 0.25.0 | 15 | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-c.wasm` | tree-sitter-c 0.24.1 | 15 | `c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9` |
| `tree-sitter-cpp.wasm` | tree-sitter-cpp 0.23.4 | 14 | `174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf` |
| `tree-sitter-go.wasm` | tree-sitter-go 0.25.0 | 15 | `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` |
| `tree-sitter-rust.wasm` | tree-sitter-rust 0.24.0 | 14 | `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57` |

### C and C++: headers carry the contract

`#include` brings a whole file into scope, so the C/C++ spec returns its includes as `all`
imports, and the engine reads the included files (`AnalyzeOptions.read`; the adapters read the
checkout, and a file changed by the same tool call is read as it will be after it), parses
them with the same grammar and follows their includes (at most 64 files). Then:

- A definition in a `.c`/`.cpp` that an included header also declares is keyed to the header:
  `int calc_total(...) { ... }` in `src/pricing.c` writes `include/pricing.h#calc_total`.
  Callers include the header, so they read that key. A body-only change in the `.c` is a `body`
  write on the header's key; changing the prototype in the `.h` (or the definition's
  parameters) is a `signature` write. A `static` helper the header does not declare keeps the
  `.c` key. An out-of-line `Cart::total` written under `using namespace shop;` matches the
  header's `shop.Cart.total`.
- Uses resolve against the file's own declarations first, then the included ones, keyed to the
  header that declares them (the first include that does).
- A rename done in the header and the `.c` in one change also reports the `.c`'s old name as
  deleted under the `.c`'s key (`src/pricing.c#format_price`): the engine sees the header only
  as it is after the change. No caller reads that key, so it is noise, not a conflict.
- Without `read` (or for a header that is not in the checkout, like `<stdio.h>`), definitions
  keep their own file's key and only local uses are reads.

`.h` is C unless its text has C++-only constructs (`class`, `namespace`, `template <`, `::`,
access labels), in which case the C++ grammar analyzes it (`TreeSitterLanguage.refine`). Keys
do not depend on which grammar parsed the file.

Not seen by a one-file parse: members reached through expressions or `auto` (`get().total()`),
overload resolution (overloads of one name are one key), macros that expand to declarations,
and conditional compilation (both `#if` branches count).

### Go packages

A Go package is a directory whose files share one namespace, and an import path names a
directory, not a file. Keys stay file-level: `pricing.CalcTotal` reads
`pricing/pricing.go#CalcTotal`, the key of the file that declares it, so reads match the
writes the declaring file produces, the whole-file fallback (`path#*`) and the diff quoting in
diagnostics. (Keying on the package, `pricing#CalcTotal`, would have needed no file reads, but
would break all three.)

To find the declaring file the engine keeps a lazy declaration index per package directory
(`TreeSitterLanguage.packageFiles`, `packageName`, `packageDeclaredNames`): it lists the
directory, reads its `.go` files, takes a cheap regex pass over each file's top-level names,
and parses only the files whose names match a lookup. The edited file is never read from disk
(the hook runs before the edit lands); its own declarations resolve first. Files of another
package in the same directory (`package pricing_test`) are skipped, and so are `_test.go`
files of imported packages. An import without an alias binds the package name the directory
declares (`example.com/shop/pricing-v2` with `package pricev2` binds `pricev2`).

This needs more than `exists`: Go uses `AnalyzeOptions.read` (shared with C/C++) and adds
`list` (a checkout directory's entries, directories ending in `/`). The Claude Code and Codex
adapters pass both through `checkoutAccess` in `src/analysis.ts`: reads follow the adapters'
safe-read rule (no symlinks, nothing outside the checkout, at most 1 MiB), and a file the same
tool call changes is read as it will be after it. Without them Go finds same-file reads only.
Not handled yet: dot imports, `replace` directives and `go.work` workspaces (those imports are
treated as outside the checkout).

### Rust modules

Rust items in other modules are always reached by a path or a `use`, so keys are file-level
without an index: `use crate::pricing::{self, calc_total, Item as LineItem}` binds the module
and two members of `src/pricing.rs`; `mod tax;` in `src/cart.rs` binds `src/cart/tax.rs`;
nested paths descend through module files (`util::money::round` →
`src/util/money.rs#round`). The crate root is the `src/` next to the nearest `Cargo.toml`. A
path spelled from `crate::`/`self::`/`super::` in code binds itself; its item is the first
CamelCase segment (a type, whose member follows: `crate::pricing::Item::zero` reads `Item` and
`Item.zero`) or else the last one. Not handled: glob imports, `#[path]`, re-exports through
`pub use` (the key is the file the `use` names), and method calls on values other than `self`
(no type inference; the LSP enrichment covers those).

### Edit-time budget

The check runs inside `PreToolUse`, so it must stay well under 300 ms per edit. Measured on an
M-series MacBook Pro (Node 24):

| | |
|---|---|
| first Python file in a process (runtime + grammar load + parse + diff) | 11 ms |
| 2,080-line Python file, before + after, warm | p50 22 ms, max 36 ms |
| whole Claude Code hook invocation (node start, analysis, coordinator round trip), conformance run | p50 118 ms, p95 265 ms |
| Go and Rust, measured 2026-10-22 on the same machine **under heavy load** (load average 150–180 from parallel agent test runs; expect less on an idle machine): | |
| first file in a process (runtime + Go grammar load) / first Rust file after that | 52–111 ms / 6–16 ms |
| 2,115-line Go file, before + after, warm | p50 32–40 ms, max 72–115 ms |
| same edit with its package index: 20 sibling files, 42,000 lines | p50 41–50 ms, max 82–241 ms |
| 2,040-line Rust file, before + after, warm | p50 33–37 ms, max 58–76 ms |

`packages/analyzer/src/{python,java,kotlin,go,rust}.test.ts` fail if checking an edit to a 2,000-line
file (Go: in a 20-file, 42,000-line package) costs 300 ms of CPU or more (`src/budget.ts`; CPU time, so a machine saturated by other
work does not fail them). `src/incremental.test.ts` checks that the incremental reparse gives
the same tree as a full parse, for every language.

C and C++ (same machine, measured while ~10 other agent workers and two iOS simulators kept the
load average near 190, so these are upper bounds; 30 runs each, header read included):

| | C | C++ |
|---|---|---|
| first file in a process (runtime + grammar load + parse + diff) | 60 ms | 116 ms (3.4 MB grammar) |
| 2,016-line file, before + after, warm | min 36 / p50 82 / max 398 ms | min 19 / p50 34 / max 102 ms |

`packages/analyzer/src/c.test.ts` fails if the fastest of three warm runs on a 2,000-line C or
C++ file takes 300 ms or more (fastest of three, so a busy machine's scheduler does not fail it).


## Adding a language

1. Grammar: copy `tree-sitter-<lang>.wasm` from the grammar's npm package (they ship it) into
   `packages/analyzer/grammars/`, and record the version and sha256 in this file. Check that it loads with
   the pinned `web-tree-sitter` (ABI 13–15).
2. Spec: `packages/analyzer/src/languages/<lang>.ts` implementing `TreeSitterLanguage`; register
   it in `src/languages/index.ts`. Decide and document: what a declaration is, what is signature
   vs body, how members are qualified, and how module paths resolve.
3. Tests: `packages/analyzer/src/<lang>.test.ts`, covering new, signature vs body, reformatting
   is not a signature change, rename = deleted + new, local and imported reads, and the 300 ms
   budget.
4. Conformance: `packages/conformance/fixtures/languages/<lang>/` with a `workspace.json` and at
   least `<L>.deny-stale-signature`, `<L>.allow-after-adapting` and `<L>.allow-unrelated`
   fixtures (copy the Python set). `test/languages.test.ts` picks the set up automatically,
   checks that the peers' declared reads/writes equal the analyzer's output, and runs the Claude
   Code adapter through every fixture. Run it by hand with
   `node packages/conformance/bin/wcp-hook-conformance.mjs run --fixtures <lang> ...`.
5. Update the matrix above.

## LSP enrichment (design, not built)

tree-sitter sees one file plus import statements; it cannot see through re-exports, dynamic
dispatch, or type inference. Where a language server is installed, an asynchronous enrichment
step can add precise reads after the edit-time check has answered:

- The adapter keeps one language server per language per checkout, started lazily.
- After `PostToolUse` commits an edit, it asks the server for references to each written
  symbol and for definitions of the identifiers the edit touched, maps the locations back to
  `path#Qualified.name` keys with the tree-sitter spec, and submits the extra reads as a
  follow-up `reads` amendment. Nothing on the edit-time path waits for the server.
- Type-aware breakage (an argument type change that keeps the arity) comes from the server's
  diagnostics on the agent's checkout after merging the peer's change, reported as a warning.

Tracked as card t_082661b7. The Hermes adapter's own analyzer bundle still sends whole-file
keys for Python until card t_8ac721b0; the Claude Code, Codex, Cursor, Gemini CLI, OpenCode and
watcher adapters use the tree-sitter backend now.
