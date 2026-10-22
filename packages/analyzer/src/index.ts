import ts from "typescript";

export type WriteKind = "signature" | "body" | "new" | "deleted";
export type Write = { key: string; kind: WriteKind };
export type Analysis = { reads: string[]; writes: Write[] };

/**
 * Reads the current (post-edit) contents of a repository file. `analyzeDiff` reverses the
 * unified diff to derive its pre-edit contents. Return `undefined` for deleted files.
 */
export type ReadFile = (path: string) => string | undefined;

type DeclarationInfo = { key: string; signature: string; body: string };
type DiffFile = { path: string; hunks: Hunk[]; deleted: boolean };
type Hunk = { oldStart: number; newStart: number; lines: string[] };

const declarationKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
]);

function nameOf(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  const named = node as ts.NamedDeclaration;
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

function declarationKey(node: ts.Node, source: ts.SourceFile, path: string): string | undefined {
  const names: string[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    if (declarationKinds.has(current.kind)) {
      const name = nameOf(current);
      if (name) names.unshift(name);
    }
    current = current.parent;
  }
  return names.length ? `${path}#${names.join(".")}` : undefined;
}

function declarations(source: ts.SourceFile, path: string): Map<string, DeclarationInfo> {
  const result = new Map<string, DeclarationInfo>();
  const visit = (node: ts.Node): void => {
    if (declarationKinds.has(node.kind)) {
      const key = declarationKey(node, source, path);
      if (key) {
        const whole = node.getText(source);
        const functionLike = node as ts.FunctionLikeDeclarationBase;
        let body = functionLike.body?.getText(source) ?? "";
        if (!body && (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node))) {
          const open = whole.indexOf("{");
          const close = whole.lastIndexOf("}");
          if (open >= 0 && close >= open) body = whole.slice(open, close + 1);
        }
        result.set(key, { key, signature: body ? whole.replace(body, "") : whole, body });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function buildProgram(text: string): { source: ts.SourceFile; checker: ts.TypeChecker } {
  const fileName = "/entry.ts";
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, noLib: true };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (requested, languageVersion) => requested === fileName
    ? ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS)
    : undefined;
  host.fileExists = (requested) => requested === fileName;
  host.readFile = (requested) => requested === fileName ? text : undefined;
  const program = ts.createProgram([fileName], options, host);
  return { source: program.getSourceFile(fileName)!, checker: program.getTypeChecker() };
}

function keyForSymbol(symbol: ts.Symbol, path: string): string | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return undefined;
  const key = declarationKey(declaration, declaration.getSourceFile(), path);
  if (key) return key;
  const name = symbol.getName();
  return name && name !== "__export" ? `${path}#${name}` : undefined;
}

function reads(source: ts.SourceFile, checker: ts.TypeChecker, path: string): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    let candidate: ts.Node | undefined;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) candidate = node.expression;
    else if (ts.isTypeReferenceNode(node)) candidate = node.typeName;
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) candidate = node.name;
    if (candidate) {
      let symbol = checker.getSymbolAtLocation(candidate);
      if (symbol?.flags && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
      if (symbol) {
        const key = keyForSymbol(symbol, path);
        if (key) found.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/** Analyze one TypeScript file. This adapter-side function must not be bundled into the sequencer Worker. */
export function analyze(before: string, after: string, path: string): Analysis {
  const beforeSource = ts.createSourceFile("/entry.ts", before, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const afterBuild = buildProgram(after);
  const oldDeclarations = declarations(beforeSource, path);
  const newDeclarations = declarations(afterBuild.source, path);
  const writes: Write[] = [];
  for (const [key, afterDeclaration] of newDeclarations) {
    const beforeDeclaration = oldDeclarations.get(key);
    if (!beforeDeclaration) writes.push({ key, kind: "new" });
    else if (beforeDeclaration.signature !== afterDeclaration.signature) writes.push({ key, kind: "signature" });
    else if (beforeDeclaration.body !== afterDeclaration.body) writes.push({ key, kind: "body" });
  }
  for (const key of oldDeclarations.keys()) if (!newDeclarations.has(key)) writes.push({ key, kind: "deleted" });
  return { reads: reads(afterBuild.source, afterBuild.checker, path), writes: writes.sort((a, b) => a.key.localeCompare(b.key)) };
}

function diffPath(value: string): string | undefined {
  if (value === "/dev/null") return undefined;
  return value.replace(/^[ab]\//, "");
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let hunk: Hunk | undefined;
  for (const line of diff.split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      current = { path: git[2], hunks: [], deleted: false };
      files.push(current);
      hunk = undefined;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) {
      current.deleted = line.slice(4) === "/dev/null";
      const path = diffPath(line.slice(4));
      if (path) current.path = path;
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      hunk = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk && /^[ +\-]/.test(line)) hunk.lines.push(line);
  }
  return files;
}

function reverseHunks(after: string, hunks: Hunk[]): string {
  const trailingNewline = after.endsWith("\n");
  const lines = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  for (const hunk of [...hunks].reverse()) {
    const afterLines = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    const beforeLines = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const index = hunk.newStart - 1;
    if (lines.slice(index, index + afterLines.length).join("\n") !== afterLines.join("\n")) {
      throw new Error(`diff does not match current contents at post-edit line ${hunk.newStart}`);
    }
    lines.splice(index, afterLines.length, ...beforeLines);
  }
  return lines.join("\n") + (trailingNewline && lines.length ? "\n" : "");
}

/**
 * Analyze a standard unified git diff against adapter checkout contents. Only .ts, .tsx,
 * .mts, and .cts files are considered. The adapter calls this after its edit and sends the
 * resulting sets in the WCP event; the sequencer Worker consumes those supplied sets only.
 */
export function analyzeDiff(diff: string, readFile: ReadFile): Analysis {
  const results = parseDiff(diff)
    .filter((file) => /\.(?:[cm]?ts|tsx)$/.test(file.path))
    .map((file) => {
      const after = file.deleted ? "" : readFile(file.path);
      if (after === undefined) throw new Error(`readFile did not return current contents for ${file.path}`);
      return analyze(reverseHunks(after, file.hunks), after, file.path);
    });
  return {
    reads: [...new Set(results.flatMap((result) => result.reads))].sort(),
    writes: results.flatMap((result) => result.writes).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

// ---- Language-agnostic API (tree-sitter backend; see src/language.ts and docs/languages.md) ----
export type { AnalyzeOptions, BackendId, Definition, Exists, ImportBinding, Reference, SourceChange, SyntaxNode, TreeSitterLanguage } from "./language.js";
export { analyzeSource, languageFor, treeSitterLanguageFor, treeSitterLanguages, type LanguageInfo } from "./languages/index.js";
export { analyzeTreeSitter, normalize } from "./treesitter.js";

// ---- `lsp` backend: asynchronous language-server enrichment (src/lsp/, docs/languages.md) ----
export { LspEnricher, attribute, changedSpan, declarationAt, offsetAt, positionAt, splitKey, type Breakage, type EnrichResult, type LspDiagnostic, type LspOptions, type Position, type Range } from "./lsp/enrich.js";
export { detectServer, lspServers, lspSpecFor, which, type DetectedServer, type LspServerSpec } from "./lsp/servers.js";
export { JsonRpc, RpcError, spawnServer } from "./lsp/jsonrpc.js";
export { outlineTreeSitter, type Identifier, type Outline } from "./treesitter.js";
