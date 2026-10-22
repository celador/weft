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
| Swift, C# | | `tree-sitter` | planned | | | | card t_232556f9 |
| Ruby, PHP | | `tree-sitter` | planned | | | | card t_da702770 |
| C, C++ | | `tree-sitter` | planned | | | | card t_538b9b81 |
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

`packages/analyzer/src/{python,java,kotlin}.test.ts` fail if checking an edit to a 2,000-line
file costs 300 ms of CPU or more (`src/budget.ts`; CPU time, so a machine saturated by other
work does not fail them). `src/incremental.test.ts` checks that the incremental reparse gives
the same tree as a full parse, for every language.

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
