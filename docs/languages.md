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
| Java, Kotlin | | `tree-sitter` | planned | | | | card t_5184c50b |
| Swift | `.swift` | `tree-sitter` (tree-sitter-swift 0.7.3) | structs, classes, enums, actors, protocols and their members (`Cart.total`), extension members keyed on the extended type (`extension Cart { func tax() }` -> `Cart.tax`), functions, `init` (`Cart.init`), subscripts, properties, enum cases, typealiases, associated types | identifiers, type names, navigation chains (`Pricing.calcTotal`, `self.tax`), implicit `self` (`tax()` inside `Cart` -> `Cart.tax`), `Cart(...)` -> `Cart.init`; other files of the module through the [module index](#module-index-swift-c) (no imports needed), other SwiftPM targets through `import` | yes (argument labels, parameter types, defaults, `throws`/`async`, generics and attributes are signature; internal parameter names, whitespace and trailing commas are not; a property's type is its signature, its value or computed block its body) | deleted + new | 13 analyzer tests, 5 conformance fixtures (`fixtures/languages/swift`) |
| C# | `.cs` | `tree-sitter` (tree-sitter-c-sharp 0.23.5) | classes, structs, interfaces, records, enums, delegates and their members: methods, constructors (`Cart.new`), properties, indexers (`Cart.this`), events, fields, enum members; keys are `path#Type.Member` (namespaces are not part of the key) | identifiers, type names, member-access chains (`PriceCalculator.CalcTotal`, `this.Rate`), qualified names (`Shop.Pricing.PriceCalculator`), `new Cart(...)` -> `Cart.new`, implicit `this`, `using static`, `using` aliases; other files through the [module index](#module-index-swift-c) filtered by namespace (`using`, enclosing namespaces, written out) | yes (a method's header is its signature, its block or `=> expr` its body; a property's type, name and accessor list are signature, accessor bodies and initializer body; record parameters are the record's signature) | deleted + new | 11 analyzer tests, 5 conformance fixtures (`fixtures/languages/csharp`) |
| Ruby, PHP | | `tree-sitter` | planned | | | | card t_da702770 |
| C, C++ | | `tree-sitter` | planned | | | | card t_538b9b81 |
| Anything else | | none | whole file: `path#*` | none | no | no | the adapters' existing fallback |

A file in a language without a backend still takes part: its edits write `path#*`, so two
agents editing the same file in the same window still see each other, at file granularity.

### Grammars

Vendored in `packages/analyzer/grammars/` (all ABI 15, loaded by `web-tree-sitter` 0.25.10):

| File | Grammar | Source | sha256 |
|---|---|---|---|
| `tree-sitter-python.wasm` | tree-sitter-python 0.25.0 | npm `tree-sitter-python` | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-swift.wasm` | tree-sitter-swift 0.7.3 (alex-pinkus) | GitHub release asset `0.7.3` (the npm package ships no wasm) | `0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2` |
| `tree-sitter-c_sharp.wasm` | tree-sitter-c-sharp 0.23.5 | npm `tree-sitter-c-sharp` (same file as GitHub release `v0.23.5`) | `6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40` |

The Swift and C# grammars are large (3.8 MB and 5.4 MB), so the adapter bundles grow by about
9 MB; they are compiled lazily, the first time a file of that language is analyzed.

Language-server enrichment (`lsp` backend: pyright/basedpyright, gopls, rust-analyzer, jdtls,
kotlin-lsp, sourcekit-lsp, clangd, ruby-lsp, csharp-ls) is designed below and not built yet.

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
  index?: ModuleIndex;   // Swift, C#: declarations visible without per-file imports (Module index)
}
```

For each changed file the engine parses before and after, diffs the declarations
(`new` / `deleted` / `signature` / `body`), and resolves references against the file's own
declarations first, then its imports. Imported members that resolve to a file in the checkout
are reads, the same rule the TypeScript adapter applies to named imports. Modules outside the
checkout (stdlib, packages) are ignored.

Runtime: `web-tree-sitter` 0.25.10 (WASM, no native build, no toolchain). Adapters bundle the
analyzer and copy the WASM files to `dist/grammars/` at build time
(`packages/analyzer/scripts/copy-assets.mjs`); `WEFT_GRAMMARS_DIR` overrides the lookup.

### Edit-time budget

The check runs inside `PreToolUse`, so it must stay well under 300 ms per edit. Measured on an
M-series MacBook Pro (Node 24):

| | |
|---|---|
| first Python file in a process (runtime + grammar load + parse + diff) | 11 ms |
| 2,080-line Python file, before + after, warm | p50 22 ms, max 36 ms |
| whole Claude Code hook invocation (node start, analysis, coordinator round trip), conformance run | p50 118 ms, p95 265 ms |

`packages/analyzer/src/python.test.ts` fails if a 2,000-line file takes 300 ms or more;
`swift.test.ts` and `csharp.test.ts` apply the same limit to a 2,000-line file and to a cold
analysis against a 400-file module index.

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

## Adding a language

1. Grammar: copy `tree-sitter-<lang>.wasm` from the grammar's npm package (most ship it; for
   Swift it is a GitHub release asset) into
   `packages/analyzer/grammars/`, and record the version and sha256 in the Grammars table. Check that it loads with
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
