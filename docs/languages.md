# Languages

Weft's conflict checks are language-agnostic at the protocol level: an edit event carries
`reads` and `writes` keyed `path#Qualified.name` (WCP §4.1), and the coordinator never parses
code. The adapter derives those sets from the edit with `@weft/analyzer`, which has one backend
per language family.

## Support matrix

| Language | Extensions | Backend | Declarations (writes) | Uses (reads) | Signature vs body | Renames | LSP enrichment (async) | Tested |
|---|---|---|---|---|---|---|---|---|
| TypeScript / JavaScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `typescript` (TS compiler API) | functions, classes, methods, properties, interfaces, type aliases, enums, variables | calls, `new`, type references, named/namespace/default imports of relative modules | yes | deleted + new | not needed (the compiler API already resolves types) | unit tests, core conformance fixtures (L0–L3), real agent runs |
| Python | `.py .pyi` | `tree-sitter` (tree-sitter-python 0.25.0) | functions, classes, methods (`Cart.total`), module- and class-level assignments | calls, decorators, base classes, type annotations, attribute chains (`pricing.calc_total`, `self.tax`), every imported member that resolves into the checkout | yes (decorators count as signature; whitespace and trailing commas do not; an assignment's annotation is its signature and its value its body) | deleted + new | **yes**: `pyright-langserver` or `basedpyright-langserver` on PATH — precise reads (re-exports, instance attributes), callers of a signature change, type breakage | 13 analyzer tests, 5 conformance fixtures (`fixtures/languages/python`), real two-agent Claude Code run ([record](research/python-real-run-2026-10-22.md)); LSP: analyzer `src/lsp/lsp.test.ts` (fake server + real pyright), adapter `test/lsp.test.ts`, end to end `scripts/lsp-e2e.mjs` ([record](research/lsp-enrichment-2026-10-22.md)) |
| Go | `.go` | `tree-sitter` (tree-sitter-go 0.25.0) | functions, methods keyed by receiver type (`Cart.Total`), types and interfaces, package-level consts/vars | calls, selector chains (`pricing.CalcTotal`, receiver calls `c.Tax()` → `Cart.Tax`), type uses (`Item`, `pricing.Item`, composite literals); imports resolve through `go.mod` to a package directory, and names used but not declared in the file resolve through its own package (see [Go packages](#go-packages)) | yes (the receiver is part of a method's signature; a struct's fields and an interface's methods are the type's signature; a const/var's type is its signature, its value the body; gofmt alignment and trailing commas are not changes) | deleted + new | registered (`gopls`), used when installed; not tested against a real server | 12 analyzer tests, 5 conformance fixtures (`fixtures/languages/go`, incl. a same-package cross-file deny) |
| Rust | `.rs` | `tree-sitter` (tree-sitter-rust 0.24.0) | functions, impl/trait methods keyed by type (`Cart.total`, `impl Display for Cart` → `Cart.fmt`, `Shape.area`), structs, enums, unions, traits, type aliases, consts, statics, items of inline modules (`tests.t`) | calls, paths (`pricing::calc_total`, `Self::new`, `Kind::A`), `self.tax()` → `Cart.tax`, type uses, calls and paths inside macro arguments (`format!(.., calc_total(x))`); `use` trees (`{self, x, y as z}`), `mod x;`, and `crate::`/`self::`/`super::` paths resolve to `src/a/b.rs` or `src/a/b/mod.rs` under the nearest `Cargo.toml` | yes (outer attributes such as `#[derive]` are signature; a struct's fields and an enum's variants are its signature; a const/static's type is its signature, its value the body) | deleted + new | registered (`rust-analyzer`), used when installed; not tested against a real server | 11 analyzer tests, 5 conformance fixtures (`fixtures/languages/rust`) |
| Java | `.java` | `tree-sitter` (tree-sitter-java 0.23.5) | classes, interfaces, enums, records, annotation types (nested: `Pricing.Kind`), methods (overloads share a key), fields, enum constants, record components | calls (`calcTotal()`, `this.tax()`, `Fmt.round()`), `new`, every type use, annotations, field accesses, method references, unqualified members of enclosing classes; single-type, static, wildcard and same-package imports, as `.java` or `.kt`; Kotlin top-level declarations through their facade class (`PricingKt.calcTotal()`, `@file:JvmName`) | yes (constructors count as the class's signature; comments and `@Override`/`@Deprecated`/`@SuppressWarnings` do not; other annotations do) | deleted + new | registered (`jdtls`), used when installed; not tested against a real server | 16 analyzer tests, 5 conformance fixtures (`fixtures/languages/java`) |
| Kotlin | `.kt .kts` | `tree-sitter` (@tree-sitter-grammars/tree-sitter-kotlin 1.1.0) | classes, interfaces, objects, enum entries, type aliases, functions and properties (top-level, members, companion members as `Cart.create`), extensions by name (`discount`), `val`/`var` constructor parameters | calls, constructor calls, every type use, navigation (`Item.ZERO`, `Cart::total`), `this`, extension receivers, unqualified members; class, top-level-function, aliased, wildcard and same-directory imports, same-package top-level declarations of other files without an import (package index), Kotlin → Java interop | yes (primary and secondary constructors count as the class's signature; `@JvmStatic`/`@JvmName` count; `@Deprecated`/`@Suppress` and comments do not) | deleted + new | registered (`kotlin-lsp`), used when installed; not tested against a real server | 25 analyzer tests (incl. Java → Kotlin facades), 7 conformance fixtures (`fixtures/languages/kotlin`, incl. Kotlin calling a changed Java method, a same-package call with no import, and Java calling `PricingKt.calcTotal`) |
| Swift | `.swift` | `tree-sitter` (tree-sitter-swift 0.7.3) | structs, classes, enums, actors, protocols and their members (`Cart.total`), extension members keyed on the extended type (`extension Cart { func tax() }` -> `Cart.tax`), functions, `init` (`Cart.init`), subscripts, properties, enum cases, typealiases, associated types | identifiers, type names, navigation chains (`Pricing.calcTotal`, `self.tax`), implicit `self` (`tax()` inside `Cart` -> `Cart.tax`), `Cart(...)` -> `Cart.init`; other files of the module through the [module index](#module-index-swift-c) (no imports needed), other SwiftPM targets through `import` | yes (argument labels, parameter types, defaults, `throws`/`async`, generics and attributes are signature; internal parameter names, whitespace and trailing commas are not; a property's type is its signature, its value or computed block its body) | deleted + new | registered (`sourcekit-lsp`), used when installed; not tested against a real server | 13 analyzer tests, 5 conformance fixtures (`fixtures/languages/swift`) |
| C# | `.cs` | `tree-sitter` (tree-sitter-c-sharp 0.23.5) | classes, structs, interfaces, records, enums, delegates and their members: methods, constructors (`Cart.new`), properties, indexers (`Cart.this`), events, fields, enum members; keys are `path#Type.Member` (namespaces are not part of the key) | identifiers, type names, member-access chains (`PriceCalculator.CalcTotal`, `this.Rate`), qualified names (`Shop.Pricing.PriceCalculator`), `new Cart(...)` -> `Cart.new`, implicit `this`, `using static`, `using` aliases; other files through the [module index](#module-index-swift-c) filtered by namespace (`using`, enclosing namespaces, written out) | yes (a method's header is its signature, its block or `=> expr` its body; a property's type, name and accessor list are signature, accessor bodies and initializer body; record parameters are the record's signature) | deleted + new | registered (`csharp-ls`), used when installed; not tested against a real server | 11 analyzer tests, 5 conformance fixtures (`fixtures/languages/csharp`) |
| Ruby | `.rb .rake .gemspec .ru` | `tree-sitter` (tree-sitter-ruby 0.23.1) | classes and modules qualified by nesting (`Shop.Cart`; a reopened class is one key), methods and singleton methods (`def self.build`, `class << self`) as `Class.method`, constants, `attr_reader`/`attr_writer`/`attr_accessor` attributes | receiver-less and `self.` calls, bare method names that are not locals, constants and constant paths (`Shop::Money.fmt`; `Foo.new` reads `Foo.initialize`), resolved by Zeitwerk/Rails convention among `require_relative`/`require`d files, `lib/`, `app/models`, `app/controllers`, `app/services` and the other autoload dirs, innermost lexical nesting first | yes (`private`/`module_function` prefixes and the superclass count as signature; a constant's value is its body) | deleted + new | registered (`ruby-lsp`), used when installed; not tested against a real server | 13 analyzer tests, 5 conformance fixtures (`fixtures/languages/ruby`) |
| PHP | `.php .phtml .php8 .phpt` | `tree-sitter` (tree-sitter-php 0.24.2, `php` dialect) | functions, classes, interfaces, traits, enums, methods (`Cart.total`), properties incl. constructor-promoted (`Cart.items`), class and top-level constants, enum cases; keys leave the namespace out (the PSR-4 path names it) | function calls, `Foo::bar()` / `Foo::BAR` / `self::`/`static::`, `$this->m()` / `$this->p`, `new Foo` (reads `Foo.__construct`), types, `extends`/`implements`, trait `use`, attributes, bare constants; resolved through `use` (aliases, groups, `use function`/`use const`), fully qualified names and the file's namespace by the nearest `composer.json`'s PSR-4 map (`autoload` and `autoload-dev`, when the adapter can read the checkout), then PSR-4 convention (`App\Models\User` under `src/`, `app/`, `lib/`, root, `tests/`, with leading namespace segments dropped) | yes (attributes, modifiers, parameters, return type, `extends`/`implements`; a property's or constant's value is its body) | deleted + new | no server registered | 13 analyzer tests, 5 conformance fixtures (`fixtures/languages/php`) |
| C | `.c .h` | `tree-sitter` (tree-sitter-c 0.24.1) | functions (definitions and prototypes), structs / unions / enums and their fields (`Item.price`), enumerators, typedefs, global variables, macros (`#define`) | every identifier and type name outside a declarator (calls, arguments, types, macro and enumerator uses), identifiers in macro bodies, `item->price` when `item`'s declared type is named; included headers' declarations, through `#include "x.h"` (relative, then `include/`, `src/`) and `<x.h>` (`include/`, `src/`), transitively | yes (a prototype change in the header is a signature write; a macro's parameter list is its signature, its value its body; an initializer is a body) | deleted + new | registered (`clangd`), used when installed; not tested end to end | analyzer tests (`c.test.ts`), 5 conformance fixtures (`fixtures/languages/c`) |
| C++ | `.cpp .cc .cxx .c++ .hpp .hh .hxx .h++ .ipp .tpp .inl`, and `.h` files whose text is C++ | `tree-sitter` (tree-sitter-cpp 0.23.4) | everything C has, plus classes and their members (`shop.Cart.total`; out-of-line `Cart::total` keyed the same), namespaces as qualifiers, `using` aliases, templates, scoped enums (`Mode.Net`) | as C, plus qualified names (`shop::calc`, `Mode::Net`), `this->x` and implicit members (`tax()` in `Cart::total` reads `Cart.tax`), `cart.total()` when `cart` is a parameter or local of a named type (`auto` is not inferred), template arguments | yes (the `template <...>` list and member access `public:`/`private:` are signature; constructor initializer lists are body) | deleted + new | registered (`clangd`), used when installed; adds `auto`, overloads, macro expansion; not tested end to end | analyzer tests (`c.test.ts`), 4 conformance fixtures (`fixtures/languages/cpp`) |
| Anything else | | none | whole file: `path#*` | none | no | no | no | the adapters' existing fallback |

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
  looks in `<LastSegment>.kt` and `<Name>.kt`, `.kt` only.
- **Same package, no import (Kotlin).** Any file of a package may call another file's
  top-level functions and properties, or use its classes, without importing them, and the
  declaring file can have any name. Kotlin reuses the Go package index (see
  [Go packages](#go-packages)): `kotlin.ts` sets `packageFiles` (the directory's `.kt` files),
  `packageName` (the `package` header), `packageDeclaredNames` (a regex pass over `fun`/`val`/
  `var`/`class`/`object`/`interface`/`typealias` names) and `importsFiles`, which keeps imports
  resolving to files as before; the index only answers names the edited file neither declares
  nor imports. `calcTotal(items)` in `pricing/Discounts.kt` reads `pricing/Pricing.kt#calcTotal`,
  the key `Pricing.kt` writes. A class used without an import (`Money(0)`) that has no
  `Money.kt` next to the file is looked up the same way. Files of another `package` in the
  directory and `private` top-level declarations (file-private in Kotlin) are skipped; an
  explicit import outside the checkout hides a same-package name, as in Kotlin. The index is the
  file's own directory: the same package in another source set (`src/test/kotlin/...`) is not
  searched.
- **Java → Kotlin facades.** Java sees Kotlin top-level declarations as static members of a
  facade class: `PricingKt` for `Pricing.kt`, or the name the file gives itself with
  `@file:JvmName("PriceFormat")`. A Java class binding (an import, a static import, or a
  same-package name with no import) carries a `facade:` candidate (`ImportBinding.facade`) that
  the engine tries before the class: it resolves when no `PricingKt.java`/`.kt` exists and
  either `Pricing.kt` exists without a different `@file:JvmName`, or a `.kt` file of the package
  declares that `JvmName` (found by listing and reading the package directories, once per
  analysis). The class segment is then dropped, so `PricingKt.calcTotal()` and
  `import static com.shop.pricing.PricingKt.calcTotal;` both read `Pricing.kt#calcTotal`. Same-
  package lookups try the sibling source root too (`src/main/java/p` → `src/main/kotlin/p`).
  `@JvmMultifileClass` facades and static wildcard imports are not followed; the LSP enrichment
  below covers them.
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

### Grammars

The vendored grammars and their sha256 are listed under [How the tree-sitter backend works](#how-the-tree-sitter-backend-works) (Java and Kotlin in [their notes](#java-and-kotlin-notes)).
The Swift and C# grammars are large (3.8 MB and 5.4 MB), so the adapter bundles grow by about
9 MB; they are compiled lazily, the first time a file of that language is analyzed.

Language-server enrichment (`lsp` backend, [below](#lsp-enrichment)) adds precise reads and
type-aware warnings asynchronously, after the edit-time check has answered. Python is tested end to end;
the servers for the other languages (gopls, rust-analyzer, jdtls, kotlin-lsp, sourcekit-lsp, clangd,
ruby-lsp, csharp-ls) are registered and start when installed and that language's tree-sitter spec exists
(keys are mapped back with the spec). For C/C++, clangd adds what the tree-sitter pass cannot see:
`auto`, overloads, macro expansion.

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
  index?: ModuleIndex;   // Swift, C#: declarations visible without per-file imports (Module index)
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

Vendored grammars (`packages/analyzer/grammars/`, copied from each grammar's npm package unless noted):

| Grammar | npm version | ABI | sha256 |
|---|---|---|---|
| `tree-sitter-python.wasm` | tree-sitter-python 0.25.0 | 15 | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-c.wasm` | tree-sitter-c 0.24.1 | 15 | `c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9` |
| `tree-sitter-cpp.wasm` | tree-sitter-cpp 0.23.4 | 14 | `174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf` |
| `tree-sitter-swift.wasm` | tree-sitter-swift 0.7.3 (alex-pinkus; GitHub release asset `0.7.3`, the npm package ships no wasm) | 15 | `0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2` |
| `tree-sitter-c_sharp.wasm` | tree-sitter-c-sharp 0.23.5 (same file as GitHub release `v0.23.5`) | 15 | `6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40` |
| `tree-sitter-ruby.wasm` | tree-sitter-ruby 0.23.1 | 14 | `09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4` |
| `tree-sitter-php.wasm` | tree-sitter-php 0.24.2 (`php`, with inline HTML; `php_only` not vendored) | 15 | `d4df6a6ff08c87c3ec4f9cbb785fe09998a0cb570e03f57d7b19b3acfb146aa7` |
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

Kotlin uses the same index for same-package names (see [Java and Kotlin notes](#java-and-kotlin-notes));
with `importsFiles` its imports keep resolving to files, and only names the edited file neither
declares nor imports go through the index.

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

`packages/analyzer/src/{python,java,kotlin,swift,csharp,go,rust}.test.ts` fail if checking an edit to a 2,000-line
file costs 300 ms of CPU or more (Go also checks an edit in a 20-file, 42,000-line package;
Swift and C# a cold analysis against a 400-file module index) (`src/budget.ts`; CPU time, so a machine saturated by other
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

Swift and C#, measured on the same machine while other agents' builds and test runs were using
it (load average 140-250, so these are upper bounds; component timings between spikes
were parse 15-25 ms, declarations 3-10 ms, references 16-25 ms for a 2,000-line file):

| | Swift | C# |
|---|---|---|
| first file in a process (runtime + grammar compile + parse + diff) | 13-274 ms | 14-66 ms |
| 2,050-line file, before + after, warm | p50 481 ms under load; ~80 ms from component timings | p50 166 ms under load |
| 400-file module, cold index (list + read + regex pass + parse of the 2-3 matching files) | p50 16 ms | p50 2 ms |
| same, index cached in-process | p50 2 ms | p50 1 ms |

The Swift grammar parses about 3x slower than Python's; a 2,000-line Swift file is the size at
which the edit-time check approaches its budget on a loaded machine.

## Module index (Swift, C#)

Swift has no per-file imports: every file of a module sees every declaration of the module.
C#'s `using` names a namespace, not a file. So a reference that matches nothing in the edited
file is resolved against a declaration index of the module (`packages/analyzer/src/moduleindex.ts`,
enabled by an optional `index` on the language spec):

1. Scope. The spec names the directories to search, recursively:
   - Swift: the SwiftPM target (`<pkg>/Sources/<Target>/`, `<pkg>/Tests/<Target>/`), plus
     `Sources/<M>` for each `import M`; in an Xcode project, the group folder next to the
     `.xcodeproj` that holds the file (plus sibling folders named by `import`); otherwise the
     file's directory.
   - C#: the directory of the nearest `.sln`/`.slnx`, else of the nearest `.csproj`, else the
     file's directory.
2. Cheap first pass. Each file in scope is read and one regex pass lists the names it may
   declare at the top level (`struct|class|enum|protocol|actor|extension|func|let|var ...` at
   column 0 for Swift; `class|struct|interface|enum|record|delegate` for C#). No parse.
3. Parse on demand. Only files whose names match an unresolved reference are parsed; the parse
   and the name list are cached per process by file contents, so a long-lived adapter (watcher,
   MCP server) parses each file once until it changes. The edited file itself is excluded (its
   own declarations already resolve locally).
4. Namespaces. Each top-level declaration has a namespace: the Swift module name (so
   `Shop.calcTotal` resolves like `calcTotal` after `import Shop`), the C# declaring namespace.
   A reference may name a declaration unqualified when its namespace is visible (Swift: the
   module and its imports; C#: `using`s, the file's namespaces and their parents), or qualified
   (`Shop.Pricing.PriceCalculator`, `Pricing.PriceCalculator` inside `namespace Shop`). C#
   project-wide `global using`s and implicit usings live in other files, so an unqualified C#
   name that matches no visible namespace falls back to any namespace in scope.
5. Longest match wins, local or not: `Cart.rate` declared in `Cart+Rate.swift` beats `Cart`
   declared in the edited file; partial classes and extensions spread over several files read
   every file that declares the matched name.
6. Bounds. At most 4,000 files and 12 directory levels per scope; hidden directories,
   `node_modules`, `.build`, `DerivedData`, `Pods`, `Carthage`, `bin` and `obj` are skipped;
   adapters do not read files over 1 MB.

The index needs `AnalyzeOptions.list(dir)` and `AnalyzeOptions.read(rel)` (both optional and
backward compatible). The Claude Code and Codex adapters pass them from the checkout
(`checkoutAccess` in `src/analysis.ts`, the same helper Go and Kotlin's package index and C/C++
includes use); without them, Swift and C# still get same-file reads.

Package index (Go, Kotlin) and module index (Swift, C#) are two mechanisms, deliberately kept
separate. Both are lazy, list and read through the same checkout access, and parse only files
whose regex-pass names match a lookup, but they answer different questions: the package index
is one directory, non-recursive, whose declared `package` name is what an import binds (Go
imports name directories; `_test` packages are skipped; Kotlin filters by `packageVisible`); the
module index is a recursive set of scope directories filtered by namespace, with longest-match
across local and indexed declarations and `Reference.or` alternatives. Folding Go into
`ModuleIndex` would need package naming, import rebinding and visibility hooks it does not have,
so the engine keeps both: in `treesitter.ts`, for each reference (and each `ref.or`
alternative) it tries the edited file and the module index (longest match wins), then included
headers, then imports (incl. Python submodule descent and Go package imports), then the
file's own package index. An import that resolves outside the checkout hides same-package names.

Lexical lookup inside types uses `Reference.or` (try `Cart.tax`, else top-level `tax`),
`Reference.min` (a scoped candidate must match past the type: `Cart.Inner` must not read `Cart`)
and `Reference.anchored` (the first segment is a type, never a namespace qualifier).

Known limits: Swift members reached through a typed variable (`cart.total()` where `cart` is a
local) are not resolved, as in Python; a struct's memberwise initializer is not a declaration,
so a call `Item(price:qty:)` reads `Item` (whose body changes when a stored property is added,
which is not a conflict). C# extension methods, `using static` of nested types, and members
reached through typed variables are not resolved. Operators and finalizers are not
declarations.

Java and Kotlin do not use the module index: a JVM class lives in a file named after it, so
same-package and wildcard-imported classes resolve by file name (`implicitBindings` in
`src/languages/jvm.ts` turns `Item` into an import of `./Item` or `<wildcard pkg>.Item`, and
`resolveModule` checks that the file exists). That is path resolution, not a declaration index,
so the two mechanisms stay separate: a JVM spec has no `index`, and Swift/C# need one because
their file names say nothing about what a file declares.

### Ruby and PHP: resolving names without per-name imports

Neither language imports names the way Python does, so the specs synthesize the bindings:

- Ruby: one binding per constant path the file uses and does not define, per lexical
  qualification (`Money` inside `module Shop` is tried as `Shop::Money`, then `::Money`). A file
  matches when its path names the constant the way Zeitwerk does (`shop/money.rb` under `lib/`,
  `app/models`, `app/controllers`, `app/services`, ... or a `require_relative`d file); only the
  constant as written may also live in a parent's file (`Shop::Money` in `shop.rb`). Methods
  defined at the top level of a `require`d file are not tracked.
- PHP: `use` statements bind as written; class names without a `use` bind to the file's
  namespace or, fully qualified, to themselves. Files come from the nearest `composer.json`'s
  PSR-4 map (`autoload` and `autoload-dev`, longest prefix first; the engine passes
  `AnalyzeOptions.read` to `resolveModule`, and the adapters supply it), then from PSR-4
  convention, so a checkout without a readable composer.json still resolves the common
  layouts. Classloaders other than PSR-4 (`classmap`, PSR-0) are not followed. Functions and constants
  imported with `use function`/`use const` resolve to `<namespace path>.php`,
  `<namespace path>/functions.php` or `helpers.php`. Global functions (`strlen`) and classes
  outside the checkout resolve nowhere and are ignored.

## Adding a language

1. Grammar: copy `tree-sitter-<lang>.wasm` from the grammar's npm package (most ship it; for
   Swift it is a GitHub release asset) into
   `packages/analyzer/grammars/`, and record the version and sha256 in the vendored-grammars table. Check that it loads with
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

## LSP enrichment

tree-sitter sees one file plus its import statements: it cannot see through a package
re-export (`from shop import calc_total`, where `shop/__init__.py` re-exports
`shop/pricing.py#calc_total`), through an instance attribute (`self.pricer.quote(...)`), or
type inference. Where a language server is installed, the `lsp` backend
(`packages/analyzer/src/lsp/`) answers those questions **after** the edit-time check:

- **Precise reads.** After `PostToolUse` commits an edit, the adapter asks the server for
  `textDocument/definition` of every identifier in the changed lines and maps each location
  back to a key with the tree-sitter spec (a location inside a declaration's name is that
  declaration, else the innermost declaration containing it). Keys the edit did not already
  send go to the coordinator as a **reads amendment**: an `intent` event carrying `reads`
  (WCP §6.2 R2a). The coordinator checks it like R2 but only warns: a signature change since
  the edit's base comes back as `contract_changed`, a body change as `stale_read`. Accepted,
  the reads join the change, so later contract changes to them are pushed like any read.
- **Callers of a signature change.** For each `signature`/`deleted` write,
  `textDocument/references` lists the declarations that use it; the writer is told
  (`[weft info] lsp_dependents …`) which call sites outside its edit to update.
- **Type-aware breakage.** When a `contract_changed` reaches an agent (pushed, or on its
  amendment's verdict), the adapter applies the peer's diff to the peer's files **in the
  server's memory only**, finds the files of this checkout that reference the changed key, and
  diffs their error diagnostics with and without the peer's version. New errors become
  `[weft warning] type_breakage <file>:<line>:<col>: pyright: Argument missing for parameter
  "tax" — once agent-a's change #4 to shop/pricing.py#calc_total lands …`.
- **Never on the edit-time path.** `PreToolUse` never waits for a server; the hooks only append
  a job to `.weft/lsp/queue/` (1–12 ms measured, `lsp_ms` in `.weft/log/hooks.jsonl`). The
  daemon's findings are injected at the agent's next hook (`PostToolUse`, `UserPromptSubmit`).

Process model: hooks are short-lived processes, so the servers live in one detached daemon per
checkout (`weft-adapter-claude lsp-daemon`, or the translator's own CLI), started by the first
hook that has work for it. One server per language per checkout, started lazily on the first
file of that language; the daemon shuts the servers down when the last session that sent it
work ends (`SessionEnd`), or after 30 idle minutes. A lock (`.weft/lsp/daemon.lock`) keeps it
to one daemon per checkout.

Servers (`packages/analyzer/src/lsp/servers.ts`), each optional and auto-detected on PATH; the
first installed command wins:

| Language | Server(s) | Used today |
|---|---|---|
| Python | `pyright-langserver --stdio`, `basedpyright-langserver --stdio` | yes |
| Go | `gopls` | registered, used when installed (not tested end to end) |
| Rust | `rust-analyzer` | registered, used when installed (not tested end to end) |
| Java, Kotlin | `jdtls`, `kotlin-lsp --stdio` | when installed (not tested end to end) |
| Swift | `sourcekit-lsp` | when installed (not tested end to end) |
| C# | `csharp-ls` | when installed (not tested end to end) |
| Ruby | `ruby-lsp` | when installed (not tested end to end) |
| C, C++ | `clangd` | when installed (not tested end to end) |

`WEFT_LSP_<LANGUAGE>` names a command explicitly (`WEFT_LSP_PYTHON="basedpyright-langserver
--stdio"`, or `off`); `WEFT_LSP=off` disables enrichment entirely. pyright is configured with
`diagnosticMode: openFilesOnly` and `typeCheckingMode: basic`, so it only checks the files the
backend opens.

Measured (M-series MacBook Pro under heavy load, pyright 1.1.388; record:
[research/lsp-enrichment-2026-10-22.md](research/lsp-enrichment-2026-10-22.md)): first
enrichment including server start 0.7–2 s, a breakage check 0.7–1.7 s; nothing of it is on a
hook's path.

Limits: a peer's diff is applied to this checkout's version of the file (±50 lines of drift);
if it does not apply, the breakage check is skipped (logged). An amendment covers keys whose
declarations live in the checkout (stdlib and site-packages are ignored). Adapters that do not
reuse the Claude Code core (Codex, the Hermes adapter, the watcher) do not enrich yet.

Tracked as card t_082661b7. The Claude Code, Codex, Cursor, Gemini CLI, OpenCode, watcher and
Hermes adapters use the tree-sitter backend now (Hermes since card t_8ac721b0: its `analyze.mjs`
bundle routes tree-sitter languages through `analyzeSource` and reports its extensions with
`--languages`).
