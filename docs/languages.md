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
| Java, Kotlin | | `tree-sitter` | planned | | | | registered, starts once the spec lands | card t_5184c50b |
| Swift, C# | | `tree-sitter` | planned | | | | registered, starts once the spec lands | card t_232556f9 |
| Ruby, PHP | | `tree-sitter` | planned | | | | registered, starts once the spec lands | card t_da702770 |
| C, C++ | | `tree-sitter` | planned | | | | registered, starts once the spec lands | card t_538b9b81 |
| Anything else | | none | whole file: `path#*` | none | no | no | no | the adapters' existing fallback |

A file in a language without a backend still takes part: its edits write `path#*`, so two
agents editing the same file in the same window still see each other, at file granularity.

Language-server enrichment (`lsp` backend, [below](#lsp-enrichment)) adds precise reads and
type-aware warnings asynchronously, after the edit-time check has answered. Python uses it
today; the servers for the other languages (gopls, rust-analyzer, jdtls, kotlin-lsp,
sourcekit-lsp, clangd, ruby-lsp, csharp-ls) are registered and start as soon as that language's
tree-sitter spec exists (keys are mapped back with the spec).

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
