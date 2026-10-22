// Locating the WASM files (tree-sitter runtime + grammars) from source, from a workspace
// dependency, and from adapter bundles (whose build copies them to `dist/grammars`).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function here(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** Directories searched for `<grammar>.wasm`, most specific first. */
export function grammarDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.WEFT_GRAMMARS_DIR) dirs.push(process.env.WEFT_GRAMMARS_DIR);
  const start = here();
  // src/ -> ../grammars ; dist/ and dist/chunks/ -> ./grammars, ../grammars
  for (const d of [start, join(start, ".."), join(start, "..", "..")]) dirs.push(join(d, "grammars"));
  return dirs;
}

export function findGrammar(file: string): string {
  for (const dir of grammarDirs()) {
    const candidate = join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`tree-sitter grammar ${file} not found (searched ${grammarDirs().join(", ")}; set WEFT_GRAMMARS_DIR)`);
}

/** The web-tree-sitter runtime's own `tree-sitter.wasm`. */
export function findRuntimeWasm(): string {
  for (const dir of grammarDirs()) {
    const candidate = join(dir, "tree-sitter.wasm");
    if (existsSync(candidate)) return candidate;
  }
  try {
    return createRequire(import.meta.url).resolve("web-tree-sitter/tree-sitter.wasm");
  } catch {
    throw new Error("web-tree-sitter's tree-sitter.wasm not found (set WEFT_GRAMMARS_DIR)");
  }
}
