// Language registry: which backend analyzes which file.
import { posix } from "node:path";
import type { Analysis, AnalyzeOptions, BackendId, SourceChange, TreeSitterLanguage } from "../language.js";
import { analyzeTreeSitter } from "../treesitter.js";
import { csharp } from "./csharp.js";
import { python } from "./python.js";
import { swift } from "./swift.js";

/** Languages on the tree-sitter backend. Add a spec + grammar + conformance fixture per language. */
export const treeSitterLanguages: TreeSitterLanguage[] = [python, swift, csharp];

export type LanguageInfo = { id: string; name: string; backend: BackendId };

const TYPESCRIPT = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;

/** The language and backend for a path, or undefined (the adapter falls back to a whole-file key). */
export function languageFor(path: string): LanguageInfo | undefined {
  if (TYPESCRIPT.test(path)) return { id: "typescript", name: "TypeScript/JavaScript", backend: "typescript" };
  const language = treeSitterLanguageFor(path);
  return language ? { id: language.id, name: language.name, backend: "tree-sitter" } : undefined;
}

export function treeSitterLanguageFor(path: string): TreeSitterLanguage | undefined {
  const ext = posix.extname(path).toLowerCase();
  return ext ? treeSitterLanguages.find((l) => l.extensions.includes(ext)) : undefined;
}

/**
 * Analyze one file of an edit with its tree-sitter language (Python, ...). Keys are
 * `${prefix}${path}#Name`; reads include imports resolved inside the checkout.
 * Throws for paths no tree-sitter language claims; check `treeSitterLanguageFor` first.
 */
export async function analyzeSource(change: SourceChange, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const language = treeSitterLanguageFor(change.path);
  if (!language) throw new Error(`no tree-sitter language for ${change.path}`);
  return analyzeTreeSitter(language, change.before ?? "", change.after ?? "", change.path, opts);
}
