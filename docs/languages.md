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
| Go | `.go` | `tree-sitter` (tree-sitter-go 0.25.0) | functions, methods keyed by receiver type (`Cart.Total`), types and interfaces, package-level consts/vars | calls, selector chains (`pricing.CalcTotal`, receiver calls `c.Tax()` → `Cart.Tax`), type uses (`Item`, `pricing.Item`, composite literals); imports resolve through `go.mod` to a package directory, and names used but not declared in the file resolve through its own package (see [Go packages](#go-packages)) | yes (the receiver is part of a method's signature; a struct's fields and an interface's methods are the type's signature; a const/var's type is its signature, its value the body; gofmt alignment and trailing commas are not changes) | deleted + new | 12 analyzer tests, 5 conformance fixtures (`fixtures/languages/go`, incl. a same-package cross-file deny) |
| Rust | `.rs` | `tree-sitter` (tree-sitter-rust 0.24.0) | functions, impl/trait methods keyed by type (`Cart.total`, `impl Display for Cart` → `Cart.fmt`, `Shape.area`), structs, enums, unions, traits, type aliases, consts, statics, items of inline modules (`tests.t`) | calls, paths (`pricing::calc_total`, `Self::new`, `Kind::A`), `self.tax()` → `Cart.tax`, type uses, calls and paths inside macro arguments (`format!(.., calc_total(x))`); `use` trees (`{self, x, y as z}`), `mod x;`, and `crate::`/`self::`/`super::` paths resolve to `src/a/b.rs` or `src/a/b/mod.rs` under the nearest `Cargo.toml` | yes (outer attributes such as `#[derive]` are signature; a struct's fields and an enum's variants are its signature; a const/static's type is its signature, its value the body) | deleted + new | 11 analyzer tests, 5 conformance fixtures (`fixtures/languages/rust`) |
| Java, Kotlin | | `tree-sitter` | planned | | | | card t_5184c50b |
| Swift, C# | | `tree-sitter` | planned | | | | card t_232556f9 |
| Ruby, PHP | | `tree-sitter` | planned | | | | card t_da702770 |
| C, C++ | | `tree-sitter` | planned | | | | card t_538b9b81 |
| Anything else | | none | whole file: `path#*` | none | no | no | the adapters' existing fallback |

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

Grammars (vendored in `packages/analyzer/grammars/`, copied from each package's npm tarball):

| Grammar | npm version | ABI | sha256 |
|---|---|---|---|
| `tree-sitter-go.wasm` | tree-sitter-go 0.25.0 | 15 | `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` |
| `tree-sitter-rust.wasm` | tree-sitter-rust 0.24.0 | 14 | `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57` |

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

This needs more than `exists`: `AnalyzeOptions` gains optional `read` (a checkout file, by the
adapters' safe-read rule: no symlinks, nothing outside the checkout, at most 1 MiB) and `list`
(a checkout directory's entries, directories ending in `/`). The Claude Code and Codex adapters
pass both (`checkoutAccess` in `src/analysis.ts`); without them Go finds same-file reads only.
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

`packages/analyzer/src/python.test.ts` fails if a 2,000-line file takes 300 ms or more.

## Adding a language

1. Grammar: copy `tree-sitter-<lang>.wasm` from the grammar's npm package (they ship it) into
   `packages/analyzer/grammars/`, and record the version in this file. Check that it loads with
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
