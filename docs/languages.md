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
| Go, Rust | | `tree-sitter` | planned | | | | registered, starts once the spec lands | card t_41439699 |
| Java | `.java` | `tree-sitter` (tree-sitter-java 0.23.5) | classes, interfaces, enums, records, annotation types (nested: `Pricing.Kind`), methods (overloads share a key), fields, enum constants, record components | calls (`calcTotal()`, `this.tax()`, `Fmt.round()`), `new`, every type use, annotations, field accesses, method references, unqualified members of enclosing classes; single-type, static, wildcard and same-package imports, as `.java` or `.kt` | yes (constructors count as the class's signature; comments and `@Override`/`@Deprecated`/`@SuppressWarnings` do not; other annotations do) | deleted + new | registered (`jdtls`), used when installed; not tested against a real server | 16 analyzer tests, 5 conformance fixtures (`fixtures/languages/java`) |
| Kotlin | `.kt .kts` | `tree-sitter` (@tree-sitter-grammars/tree-sitter-kotlin 1.1.0) | classes, interfaces, objects, enum entries, type aliases, functions and properties (top-level, members, companion members as `Cart.create`), extensions by name (`discount`), `val`/`var` constructor parameters | calls, constructor calls, every type use, navigation (`Item.ZERO`, `Cart::total`), `this`, extension receivers, unqualified members; class, top-level-function, aliased, wildcard and same-directory imports, Kotlin → Java interop | yes (primary and secondary constructors count as the class's signature; `@JvmStatic`/`@JvmName` count; `@Deprecated`/`@Suppress` and comments do not) | deleted + new | registered (`kotlin-lsp`), used when installed; not tested against a real server | 14 analyzer tests, 5 conformance fixtures (`fixtures/languages/kotlin`, incl. Kotlin calling a changed Java method) |
| Swift, C# | | `tree-sitter` | planned | | | | registered, starts once the spec lands | card t_232556f9 |
| Ruby, PHP | | `tree-sitter` | planned | | | | registered, starts once the spec lands | card t_da702770 |
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

`packages/analyzer/src/{python,java,kotlin}.test.ts` fail if checking an edit to a 2,000-line
file costs 300 ms of CPU or more (`src/budget.ts`; CPU time, so a machine saturated by other
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
| Go | `gopls` | when the Go spec lands (card t_41439699) |
| Rust | `rust-analyzer` | when the Rust spec lands (card t_41439699) |
| Java, Kotlin | `jdtls`, `kotlin-lsp --stdio` | when the specs land (card t_5184c50b) |
| Swift | `sourcekit-lsp` | when the spec lands (card t_232556f9) |
| C# | `csharp-ls` | when the spec lands (card t_232556f9) |
| Ruby | `ruby-lsp` | when the spec lands (card t_da702770) |
| C, C++ | `clangd` | when the specs land (card t_538b9b81) |

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
reuse the Claude Code core (Codex, the Hermes adapter, the watcher) do not enrich yet. The
Hermes adapter's own analyzer bundle still sends whole-file keys for Python until card
t_8ac721b0.
