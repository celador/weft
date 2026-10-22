# @weft/analyzer

`@weft/analyzer` derives the read/write sets sent with a WCP edit event: TypeScript/JavaScript
through the TypeScript compiler API, other languages (Python, C, C++, Java, Kotlin, Ruby, PHP today) through a tree-sitter
backend. Support matrix and how to add a language: [docs/languages.md](../../docs/languages.md).

## Runtime boundary

Run this package in the adapter that observes the filesystem edit, not in the sequencer Durable Object / Worker. It intentionally uses the TypeScript compiler API, which needs the adapter checkout and is unsuitable for the sequencer's small, deterministic Worker bundle. The adapter sends the returned `reads` and `writes` as event fields; the sequencer validates and persists them without parsing TypeScript.

## API

```ts
import { analyze, analyzeDiff } from "@weft/analyzer";

const oneFile = analyze(beforeText, afterText, "src/auth/session.ts");

const fromGitDiff = analyzeDiff(diff, (path) => checkout.readFile(path));
```

`analyze(before, after, path)` returns:

```ts
{
  reads: string[],
  writes: Array<{ key: string; kind: "signature" | "body" | "new" | "deleted" }>
}
```

Keys use the WCP format `path#qualified.name`. `analyzeDiff` accepts a standard unified git diff and a synchronous function that returns the current, post-edit contents of the requested path (or `undefined` for a deleted path). It reverses diff hunks to reconstruct the previous contents. Only TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`) are analyzed.

The analyzer intentionally treats renames as `deleted` plus `new`; it does not infer identity. It uses a single-file program today, so cross-file import resolution remains an adapter integration extension.

## Other languages (tree-sitter backend)

```ts
import { analyzeSource, languageFor, treeSitterLanguageFor } from "@weft/analyzer";

languageFor("app/cart.py"); // { id: "python", name: "Python", backend: "tree-sitter" }

const result = await analyzeSource(
  { path: "app/cart.py", before, after },          // null before/after = created/deleted
  { prefix: "svc/", exists: (rel) => existsSync(join(root, rel)) },
);
```

`analyzeSource` is async only because the WASM runtime and grammar load on first use (~10 ms,
once per process). Keys and write kinds are the same as for TypeScript; reads include imported
members that resolve to files in the checkout. The language contract is `TreeSitterLanguage`
in `src/language.ts`; the grammars live in `grammars/` and adapter bundles copy them to
`dist/grammars/` (`scripts/copy-assets.mjs`).

