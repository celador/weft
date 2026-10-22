// Copy the analyzer's WASM assets (tree-sitter runtime + grammars) next to an adapter bundle:
// `<outDir>/grammars/*.wasm`. src/assets.ts finds them there at runtime.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));

export function copyAnalyzerAssets(outDir) {
  const dest = join(outDir, "grammars");
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(join(pkg, "grammars"))) if (f.endsWith(".wasm")) copyFileSync(join(pkg, "grammars", f), join(dest, f));
  const runtime = createRequire(join(pkg, "package.json")).resolve("web-tree-sitter/tree-sitter.wasm");
  copyFileSync(runtime, join(dest, "tree-sitter.wasm"));
  return dest;
}
