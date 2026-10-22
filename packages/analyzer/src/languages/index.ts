// Language registry: which backend analyzes which file.
import { posix } from "node:path";
import type { Analysis, AnalyzeOptions, BackendId, SourceChange, TreeSitterLanguage } from "../language.js";
import { analyzeTreeSitter } from "../treesitter.js";
import { c, cpp } from "./c.js";
import { python } from "./python.js";

/** Languages on the tree-sitter backend. Add a spec + grammar + conformance fixture per language. */
export const treeSitterLanguages: TreeSitterLanguage[] = [python, c, cpp];

export type LanguageInfo = { id: string; name: string; backend: BackendId };

const TYPESCRIPT = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;

/** The language and backend for a path, or undefined (the adapter falls back to a whole-file key). */
export function languageFor(path: string): LanguageInfo | undefined {
  if (TYPESCRIPT.test(path)) return { id: "typescript", name: "TypeScript/JavaScript", backend: "typescript" };
  const language = treeSitterLanguageFor(path);
  return language ? { id: language.id, name: language.name, backend: "tree-sitter" } : undefined;
}

/**
 * The tree-sitter language for a path. With `text`, a language that shares an extension may
 * hand the file to another (`.h` is C unless the text is C++).
 */
export function treeSitterLanguageFor(path: string, text?: string | null): TreeSitterLanguage | undefined {
  const ext = posix.extname(path).toLowerCase();
  const language = ext ? treeSitterLanguages.find((l) => l.extensions.includes(ext)) : undefined;
  const refined = language && text ? language.refine?.(path, text) : undefined;
  return (refined && treeSitterLanguages.find((l) => l.id === refined)) || language;
}

/**
 * Analyze one file of an edit with its tree-sitter language (Python, C, C++, ...). Keys are
 * `${prefix}${path}#Name`; reads include imports resolved inside the checkout.
 * Throws for paths no tree-sitter language claims; check `treeSitterLanguageFor` first.
 */
export async function analyzeSource(change: SourceChange, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const language = treeSitterLanguageFor(change.path, change.after ?? change.before);
  if (!language) throw new Error(`no tree-sitter language for ${change.path}`);
  return analyzeTreeSitter(language, change.before ?? "", change.after ?? "", change.path, opts);
}
