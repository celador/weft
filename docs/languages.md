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
| Go, Rust | | `tree-sitter` | planned | | | | card t_41439699 |
| Java | `.java` | `tree-sitter` (tree-sitter-java 0.23.5) | classes, interfaces, enums, records, annotation types (nested: `Pricing.Kind`), methods (overloads share a key), fields, enum constants, record components | calls (`calcTotal()`, `this.tax()`, `Fmt.round()`), `new`, every type use, annotations, field accesses, method references, unqualified members of enclosing classes; single-type, static, wildcard and same-package imports, as `.java` or `.kt` | yes (constructors count as the class's signature; comments and `@Override`/`@Deprecated`/`@SuppressWarnings` do not; other annotations do) | deleted + new | 16 analyzer tests, 5 conformance fixtures (`fixtures/languages/java`) |
| Kotlin | `.kt .kts` | `tree-sitter` (@tree-sitter-grammars/tree-sitter-kotlin 1.1.0) | classes, interfaces, objects, enum entries, type aliases, functions and properties (top-level, members, companion members as `Cart.create`), extensions by name (`discount`), `val`/`var` constructor parameters | calls, constructor calls, every type use, navigation (`Item.ZERO`, `Cart::total`), `this`, extension receivers, unqualified members; class, top-level-function, aliased, wildcard and same-directory imports, Kotlin → Java interop | yes (primary and secondary constructors count as the class's signature; `@JvmStatic`/`@JvmName` count; `@Deprecated`/`@Suppress` and comments do not) | deleted + new | 14 analyzer tests, 5 conformance fixtures (`fixtures/languages/kotlin`, incl. Kotlin calling a changed Java method) |
| Swift | `.swift` | `tree-sitter` (tree-sitter-swift 0.7.3) | structs, classes, enums, actors, protocols and their members (`Cart.total`), extension members keyed on the extended type (`extension Cart { func tax() }` -> `Cart.tax`), functions, `init` (`Cart.init`), subscripts, properties, enum cases, typealiases, associated types | identifiers, type names, navigation chains (`Pricing.calcTotal`, `self.tax`), implicit `self` (`tax()` inside `Cart` -> `Cart.tax`), `Cart(...)` -> `Cart.init`; other files of the module through the [module index](#module-index-swift-c) (no imports needed), other SwiftPM targets through `import` | yes (argument labels, parameter types, defaults, `throws`/`async`, generics and attributes are signature; internal parameter names, whitespace and trailing commas are not; a property's type is its signature, its value or computed block its body) | deleted + new | 13 analyzer tests, 5 conformance fixtures (`fixtures/languages/swift`) |
| C# | `.cs` | `tree-sitter` (tree-sitter-c-sharp 0.23.5) | classes, structs, interfaces, records, enums, delegates and their members: methods, constructors (`Cart.new`), properties, indexers (`Cart.this`), events, fields, enum members; keys are `path#Type.Member` (namespaces are not part of the key) | identifiers, type names, member-access chains (`PriceCalculator.CalcTotal`, `this.Rate`), qualified names (`Shop.Pricing.PriceCalculator`), `new Cart(...)` -> `Cart.new`, implicit `this`, `using static`, `using` aliases; other files through the [module index](#module-index-swift-c) filtered by namespace (`using`, enclosing namespaces, written out) | yes (a method's header is its signature, its block or `=> expr` its body; a property's type, name and accessor list are signature, accessor bodies and initializer body; record parameters are the record's signature) | deleted + new | 11 analyzer tests, 5 conformance fixtures (`fixtures/languages/csharp`) |
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

### Grammars

The vendored grammars and their sha256 are listed under [How the tree-sitter backend works](#how-the-tree-sitter-backend-works) (Java and Kotlin in [their notes](#java-and-kotlin-notes)).
The Swift and C# grammars are large (3.8 MB and 5.4 MB), so the adapter bundles grow by about
9 MB; they are compiled lazily, the first time a file of that language is analyzed.

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

### Edit-time budget

The check runs inside `PreToolUse`, so it must stay well under 300 ms per edit. Measured on an
M-series MacBook Pro (Node 24):

| | |
|---|---|
| first Python file in a process (runtime + grammar load + parse + diff) | 11 ms |
| 2,080-line Python file, before + after, warm | p50 22 ms, max 36 ms |
| whole Claude Code hook invocation (node start, analysis, coordinator round trip), conformance run | p50 118 ms, p95 265 ms |

`packages/analyzer/src/{python,java,kotlin,swift,csharp}.test.ts` fail if checking an edit to a 2,000-line
file costs 300 ms of CPU or more (Swift and C# also check a cold analysis against a 400-file
module index) (`src/budget.ts`; CPU time, so a machine saturated by other
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
(`checkoutFs` in `src/analysis.ts`); without them, Swift and C# still get same-file reads.

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
watcher adapters use the tree-sitter backend now (Python, Swift, C#).
