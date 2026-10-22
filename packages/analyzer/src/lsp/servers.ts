// Language servers the `lsp` backend can use, each optional and auto-detected on PATH.
//
// A server is used for a file only when (1) it is installed (found on PATH, or named by
// `WEFT_LSP_<LANGUAGE>`), and (2) the file's language has a tree-sitter spec, because locations
// are mapped back to `path#Qualified.name` keys with that spec. `WEFT_LSP=off` disables all.
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, posix } from "node:path";

export type LspServerSpec = {
  /** Tree-sitter language id this server enriches (`python`, `go`, ...). */
  language: string;
  /** LSP `languageId` for didOpen. */
  languageId: string;
  /** File extensions (lowercase, with the dot) the server is asked about. */
  extensions: string[];
  /** Candidate commands, first installed wins. */
  commands: Array<{ name: string; command: string; args: string[] }>;
  /** `initializationOptions` / `workspace/configuration` answers, when a server needs them. */
  initializationOptions?: unknown;
  settings?: Record<string, unknown>;
};

/** The registry from docs/languages.md. Order of `commands` is preference order. */
export const lspServers: LspServerSpec[] = [
  {
    language: "python",
    languageId: "python",
    extensions: [".py", ".pyi"],
    commands: [
      { name: "pyright", command: "pyright-langserver", args: ["--stdio"] },
      { name: "basedpyright", command: "basedpyright-langserver", args: ["--stdio"] },
    ],
    // Analyze open files and their imports only; never the whole workspace (it would be slow
    // and report diagnostics nobody asked for).
    settings: { python: { analysis: { diagnosticMode: "openFilesOnly", autoSearchPaths: true, typeCheckingMode: "basic" } }, basedpyright: { analysis: { diagnosticMode: "openFilesOnly", typeCheckingMode: "basic" } } },
  },
  { language: "go", languageId: "go", extensions: [".go"], commands: [{ name: "gopls", command: "gopls", args: [] }] },
  { language: "rust", languageId: "rust", extensions: [".rs"], commands: [{ name: "rust-analyzer", command: "rust-analyzer", args: [] }] },
  { language: "java", languageId: "java", extensions: [".java"], commands: [{ name: "jdtls", command: "jdtls", args: [] }] },
  { language: "kotlin", languageId: "kotlin", extensions: [".kt", ".kts"], commands: [{ name: "kotlin-lsp", command: "kotlin-lsp", args: ["--stdio"] }] },
  { language: "swift", languageId: "swift", extensions: [".swift"], commands: [{ name: "sourcekit-lsp", command: "sourcekit-lsp", args: [] }] },
  { language: "c", languageId: "c", extensions: [".c", ".h"], commands: [{ name: "clangd", command: "clangd", args: [] }] },
  { language: "cpp", languageId: "cpp", extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"], commands: [{ name: "clangd", command: "clangd", args: [] }] },
  { language: "ruby", languageId: "ruby", extensions: [".rb"], commands: [{ name: "ruby-lsp", command: "ruby-lsp", args: [] }] },
  { language: "csharp", languageId: "csharp", extensions: [".cs"], commands: [{ name: "csharp-ls", command: "csharp-ls", args: [] }] },
];

export type DetectedServer = { spec: LspServerSpec; name: string; command: string; args: string[] };

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of `command` on `PATH`, or undefined. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(command)) return executable(command) ? command : undefined;
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The server to use for `language`, or undefined. `WEFT_LSP_<LANGUAGE>` (e.g.
 * `WEFT_LSP_PYTHON="/opt/bin/basedpyright-langserver --stdio"`) overrides detection; `off` or
 * `WEFT_LSP=off` disables it.
 */
export function detectServer(language: string, env: NodeJS.ProcessEnv = process.env, registry: LspServerSpec[] = lspServers): DetectedServer | undefined {
  if ((env.WEFT_LSP ?? "").toLowerCase() === "off") return undefined;
  const spec = registry.find((s) => s.language === language);
  if (!spec) return undefined;
  const override = env[`WEFT_LSP_${language.toUpperCase()}`];
  if (override !== undefined) {
    if (override.trim().toLowerCase() === "off" || !override.trim()) return undefined;
    const [command, ...args] = override.trim().split(/\s+/);
    const path = which(command!, env);
    return path ? { spec, name: posix.basename(command!), command: path, args } : undefined;
  }
  for (const c of spec.commands) {
    const path = which(c.command, env);
    if (path) return { spec, name: c.name, command: path, args: c.args };
  }
  return undefined;
}

/** Spec for a file path by extension. */
export function lspSpecFor(path: string, registry: LspServerSpec[] = lspServers): LspServerSpec | undefined {
  const ext = posix.extname(path).toLowerCase();
  return ext ? registry.find((s) => s.extensions.includes(ext)) : undefined;
}
