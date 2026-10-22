// Analyzer bridge for the Hermes (Python) adapter.
//
// The Hermes plugin runs inside the Hermes Python process, but read/write extraction lives in
// @weft/analyzer (TypeScript compiler API). This file is bundled by scripts/build.mjs into one
// self-contained `analyze.mjs` that the plugin spawns once per process and talks to over
// newline-delimited JSON on stdin/stdout ("--serve"), or once per call (no flag: one JSON
// request on stdin, one JSON response on stdout).
//
// Request:  {"id"?: any, "files": [{"path": "src/a.ts", "before": "...", "after": "..."}]}
// Response: {"id"?: any, "ok": true, "reads": [...], "writes": [{key, kind}], "analyzed": [...paths]}
//        or {"id"?: any, "ok": false, "error": "..."}
import { analyze, contractReads, type Analysis, type Write } from "@weft/analyzer";
import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { posix, join } from "node:path";

export type FileInput = { path: string; before: string; after: string };
/**
 * `root` (optional): absolute checkout directory the paths are relative to, after stripping
 * `prefix` — lets relative imports resolve to real files (cross-file reads).
 */
export type Request = { id?: unknown; files: FileInput[]; root?: string; prefix?: string };

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"];

/**
 * Cross-file reads the single-file analyzer cannot see: every name imported from a relative
 * module becomes a read of `<resolved path>#<exported name>` (`default` for default imports;
 * `ns.x` member accesses for namespace imports). Resolution follows TS/Bundler conventions
 * (`./a.js` -> `./a.ts`, extensionless, `/index.ts`). Without `root` (no checkout to look at)
 * the first candidate with a TS extension is assumed.
 */
export function importReads(text: string, path: string, root?: string, prefix = ""): string[] {
  const source = ts.createSourceFile("/entry.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found = new Set<string>();
  const dir = posix.dirname(path);
  const resolve = (spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const joined = posix.normalize(posix.join(dir, spec));
    const stem = joined.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [joined, ...RESOLVE_SUFFIXES.map((s) => stem + s)].filter((c) => /\.(?:[cm]?ts|tsx)$/.test(c));
    if (!root) return candidates[0];
    for (const candidate of candidates) {
      const rel = prefix && candidate.startsWith(prefix) ? candidate.slice(prefix.length) : candidate;
      if (existsSync(join(root, rel))) return candidate;
    }
    return undefined;
  };
  const namespaces = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolve(statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (!target || !clause) continue;
    if (clause.name) found.add(`${target}#default`);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) found.add(`${target}#${(element.propertyName ?? element.name).text}`);
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, target);
    }
  }
  if (namespaces.size) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const target = namespaces.get(node.expression.text);
        if (target) found.add(`${target}#${node.name.text}`);
      } else if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
        const target = namespaces.get(node.left.text);
        if (target) found.add(`${target}#${node.right.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found];
}
export type Response =
  | { id?: unknown; ok: true; reads: string[]; writes: Write[]; analyzed: string[] }
  | { id?: unknown; ok: false; error: string };

/** Extensions the TypeScript analyzer understands (JS parses as TS for read/write purposes). */
export const ANALYZABLE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

export function handle(request: Request): Response {
  try {
    if (!request || !Array.isArray(request.files)) throw new Error("request.files must be an array");
    const reads = new Set<string>();
    const writes = new Map<string, Write>();
    const analyzed: string[] = [];
    for (const file of request.files) {
      if (typeof file?.path !== "string" || !ANALYZABLE.test(file.path)) continue;
      const result: Analysis = analyze(String(file.before ?? ""), String(file.after ?? ""), file.path);
      analyzed.push(file.path);
      for (const key of result.reads) reads.add(key);
      const imported = importReads(String(file.after ?? ""), file.path, request.root, request.prefix);
      for (const key of imported) reads.add(key);
      // The contract types of what this file uses (`PriceOptions` of `calcTotal(opts: PriceOptions)`).
      const root = request.root;
      if (root)
        for (const key of contractReads(imported, (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return undefined; } }, request.prefix ?? "")) reads.add(key);
      for (const write of result.writes) writes.set(write.key, write);
    }
    // A symbol this edit writes is not also an assumption it reads.
    for (const key of writes.keys()) reads.delete(key);
    return { id: request.id, ok: true, reads: [...reads].sort(), writes: [...writes.values()], analyzed };
  } catch (error) {
    return { id: request?.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

async function main(): Promise<void> {
  if (process.argv.includes("--serve")) {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let response: Response;
        try {
          response = handle(JSON.parse(line) as Request);
        } catch (error) {
          response = { ok: false, error: `bad request: ${error instanceof Error ? error.message : String(error)}` };
        }
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    });
    process.stdin.on("end", () => process.exit(0));
    return;
  }
  const input = await readAll(process.stdin);
  let response: Response;
  try {
    response = handle(JSON.parse(input) as Request);
  } catch (error) {
    response = { ok: false, error: `bad request: ${error instanceof Error ? error.message : String(error)}` };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

// Run only as a program (the bundle), not when imported by tests.
const entry = process.argv[1] ?? "";
if (/analyze(-cli)?\.(mjs|ts|js)$/.test(entry)) void main();
