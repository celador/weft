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
| Swift, C# | | `tree-sitter` | planned | | | | card t_232556f9 |
| Ruby, PHP | | `tree-sitter` | planned | | | | card t_da702770 |
| C | `.c .h` | `tree-sitter` (tree-sitter-c 0.24.1) | functions (definitions and prototypes), structs / unions / enums and their fields (`Item.price`), enumerators, typedefs, global variables, macros (`#define`) | every identifier and type name outside a declarator (calls, arguments, types, macro and enumerator uses), identifiers in macro bodies, `item->price` when `item`'s declared type is named; included headers' declarations, through `#include "x.h"` (relative, then `include/`, `src/`) and `<x.h>` (`include/`, `src/`), transitively | yes (a prototype change in the header is a signature write; a macro's parameter list is its signature, its value its body; an initializer is a body) | deleted + new | analyzer tests (`c.test.ts`), 5 conformance fixtures (`fixtures/languages/c`) |
| C++ | `.cpp .cc .cxx .c++ .hpp .hh .hxx .h++ .ipp .tpp .inl`, and `.h` files whose text is C++ | `tree-sitter` (tree-sitter-cpp 0.23.4) | everything C has, plus classes and their members (`shop.Cart.total`; out-of-line `Cart::total` keyed the same), namespaces as qualifiers, `using` aliases, templates, scoped enums (`Mode.Net`) | as C, plus qualified names (`shop::calc`, `Mode::Net`), `this->x` and implicit members (`tax()` in `Cart::total` reads `Cart.tax`), `cart.total()` when `cart` is a parameter or local of a named type (`auto` is not inferred), template arguments | yes (the `template <...>` list and member access `public:`/`private:` are signature; constructor initializer lists are body) | deleted + new | analyzer tests (`c.test.ts`), 4 conformance fixtures (`fixtures/languages/cpp`) |
| Anything else | | none | whole file: `path#*` | none | no | no | the adapters' existing fallback |

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

`packages/analyzer/src/python.test.ts` fails if a 2,000-line file takes 300 ms or more.

C and C++ (same machine, measured while ~10 other agent workers and two iOS simulators kept the
load average near 190, so these are upper bounds; 30 runs each, header read included):

| | C | C++ |
|---|---|---|
| first file in a process (runtime + grammar load + parse + diff) | 60 ms | 116 ms (3.4 MB grammar) |
| 2,016-line file, before + after, warm | min 36 / p50 82 / max 398 ms | min 19 / p50 34 / max 102 ms |

`packages/analyzer/src/c.test.ts` fails if the fastest of three warm runs on a 2,000-line C or
C++ file takes 300 ms or more (fastest of three, so a busy machine's scheduler does not fail it).

### Grammars

| File | Package | sha256 |
|---|---|---|
| `tree-sitter-python.wasm` | tree-sitter-python 0.25.0 | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-c.wasm` | tree-sitter-c 0.24.1 (ABI 15) | `c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9` |
| `tree-sitter-cpp.wasm` | tree-sitter-cpp 0.23.4 (ABI 14) | `174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf` |

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
