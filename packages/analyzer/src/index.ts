import ts from "typescript";

export type WriteKind = "signature" | "body" | "new" | "deleted";
export type Write = { key: string; kind: WriteKind };
export type Analysis = { reads: string[]; writes: Write[] };

/**
 * Reads the current (post-edit) contents of a repository file. `analyzeDiff` reverses the
 * unified diff to derive its pre-edit contents. Return `undefined` for deleted files.
 */
export type ReadFile = (path: string) => string | undefined;

/**
 * `typeRefs`: names the declaration's contract (its signature part, not its body) refers to in
 * type positions: `opts: PriceOptions`, `extends Base`, `typeof limit`. Qualified names
 * (`ns.T`) contribute their leftmost identifier.
 */
type DeclarationInfo = { key: string; signature: string; body: string; typeRefs: string[]; local: boolean };

/** Declared inside a function body (`calcTotal.net`): no other file can use it. */
function isLocal(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    const parent = current.parent as ts.FunctionLikeDeclarationBase | undefined;
    if (parent && parent.body === current) return true;
  }
  return false;
}
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
        result.set(key, { key, signature: body ? whole.replace(body, "") : whole, body, typeRefs: contractTypeRefs(node), local: isLocal(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function leftmost(name: ts.EntityName | ts.Expression): string | undefined {
  let current: ts.Node = name;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isQualifiedName(current)) current = current.left;
    else if (ts.isPropertyAccessExpression(current)) current = current.expression;
    else return undefined;
  }
}

/**
 * Type-position names in the contract of `node`: everything except a function-like body and
 * the members of a class or enum (those are their own declarations).
 */
function contractTypeRefs(node: ts.Node): string[] {
  const found = new Set<string>();
  const functionLike = node as ts.FunctionLikeDeclarationBase;
  const skip = new Set<ts.Node>();
  if (functionLike.body) skip.add(functionLike.body);
  if (ts.isClassDeclaration(node)) for (const member of node.members) skip.add(member);
  if (ts.isEnumDeclaration(node)) for (const member of node.members) skip.add(member);
  const visit = (child: ts.Node): void => {
    if (skip.has(child)) return;
    let name: string | undefined;
    if (ts.isTypeReferenceNode(child)) name = leftmost(child.typeName);
    else if (ts.isExpressionWithTypeArguments(child)) name = leftmost(child.expression);
    else if (ts.isTypeQueryNode(child)) name = leftmost(child.exprName);
    if (name) found.add(name);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return [...found].sort();
}

/**
 * A declaration's contract includes the types its signature names. When one of those changes
 * contract (signature change or deletion), so does the declaration: `calcTotal(opts:
 * PriceOptions)` changes contract when a PriceOptions field is renamed, though its own text
 * does not, and every caller of calcTotal must adapt. Propagated to a fixed point within the
 * file; `kinds` maps keys to their write kind and is upgraded in place.
 */
function propagateContracts(declarationsAfter: Map<string, DeclarationInfo>, path: string, kinds: Map<string, WriteKind>): void {
  const contract = (key: string) => kinds.get(key) === "signature" || kinds.get(key) === "deleted";
  for (let changed = true; changed; ) {
    changed = false;
    for (const [key, declaration] of declarationsAfter) {
      if (declaration.local || contract(key) || kinds.get(key) === "new") continue;
      if (declaration.typeRefs.some((name) => `${path}#${name}` !== key && contract(`${path}#${name}`))) {
        kinds.set(key, "signature");
        changed = true;
      }
    }
  }
}

const TS_FILE = /\.(?:[cm]?ts|tsx)$/;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"];

function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Cross-file contract reads (spec §4.1). `keys` are reads of declarations in other TypeScript
 * files of the checkout (`src/pricing.ts#calcTotal`, carrying `prefix`). For each, the
 * declaration's contract types (`PriceOptions` in `calcTotal(opts: PriceOptions)`) become reads
 * too, resolved to the file that declares them: the same file, or the file it imports them
 * from by a relative import. A caller of calcTotal then sees a contract change to PriceOptions
 * as a stale assumption, wherever PriceOptions lives. One hop: types named by those types are
 * covered by the writer side (`analyze` propagates contract changes within a file).
 * `readFile` takes checkout-relative paths and returns undefined for missing files.
 */
export function contractReads(keys: string[], readFile: (rel: string) => string | undefined, prefix = ""): string[] {
  const found = new Set<string>();
  const parsed = new Map<string, ts.SourceFile | undefined>();
  const load = (rel: string) => {
    if (!parsed.has(rel)) {
      const text = TS_FILE.test(rel) ? readFile(rel) : undefined;
      parsed.set(rel, text === undefined ? undefined : ts.createSourceFile("/entry.tsx", text, ts.ScriptTarget.ES2022, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
    }
    return parsed.get(rel);
  };
  const resolve = (spec: string, fromRel: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
    const joined = normalizePosix(`${dir}/${spec}`);
    const stem = joined.replace(/\.(?:[cm]?js|jsx)$/, "");
    return [joined, ...RESOLVE_SUFFIXES.map((s) => stem + s)].find((c) => TS_FILE.test(c) && readFile(c) !== undefined);
  };
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const hash = key.indexOf("#");
    if (hash < 0) continue;
    const rel = key.slice(prefix.length, hash);
    const name = key.slice(hash + 1);
    const source = load(rel);
    if (!source || name === "*" || name === "default") continue;
    const local = declarations(source, "");
    const imported = new Map<string, { spec: string; name: string }>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const el of bindings.elements) imported.set(el.name.text, { spec: statement.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
    }
    for (const ref of local.get(`#${name}`)?.typeRefs ?? []) {
      if (local.has(`#${ref}`)) found.add(`${prefix}${rel}#${ref}`);
      else {
        const via = imported.get(ref);
        const target = via && resolve(via.spec, rel);
        if (via && target) found.add(`${prefix}${target}#${via.name}`);
      }
    }
  }
  for (const key of keys) found.delete(key);
  return [...found].sort();
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
  const kinds = new Map<string, WriteKind>();
  for (const [key, afterDeclaration] of newDeclarations) {
    const beforeDeclaration = oldDeclarations.get(key);
    if (!beforeDeclaration) kinds.set(key, "new");
    else if (beforeDeclaration.signature !== afterDeclaration.signature) kinds.set(key, "signature");
    else if (beforeDeclaration.body !== afterDeclaration.body) kinds.set(key, "body");
  }
  for (const key of oldDeclarations.keys()) if (!newDeclarations.has(key)) kinds.set(key, "deleted");
  propagateContracts(newDeclarations, path, kinds);
  const writes: Write[] = [...kinds].map(([key, kind]) => ({ key, kind }));
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
