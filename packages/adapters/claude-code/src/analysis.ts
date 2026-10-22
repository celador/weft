// Read/write-set extraction for one tool call (spec §4.1), on top of @weft/analyzer.
// The analyzer sees one file at a time; cross-file reads (what an edit imports from other
// modules in the checkout) are added here by resolving relative imports against the
// checkout, so `import { calcTotal } from "./pricing"` reads `src/pricing.ts#calcTotal`.
import { analyze, analyzeSource, treeSitterLanguageFor, type Write } from "@weft/analyzer";
import ts from "typescript";
import { existsSync, readdirSync } from "node:fs";
import { readInsideCheckout } from "./safe-read";
import { join, posix } from "node:path";

export const ANALYZABLE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"];

export type FileChange = { rel: string; before: string | null; after: string | null };
export type Sets = { reads: string[]; writes: Write[] };

/** Whole-file key for files the TypeScript analyzer does not understand. */
export function fileKey(rel: string): string {
  return `${rel.replace(/[\s#]/g, "_")}#*`;
}

/**
 * Names imported from relative modules become reads of `<resolved path>#<name>`
 * (`default` for default imports, `ns.x` member accesses for namespace imports).
 * `rel` is checkout-relative; returned keys carry `prefix`.
 */
export function importReads(text: string, rel: string, root?: string, prefix = ""): string[] {
  const source = ts.createSourceFile("/entry.tsx", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found = new Set<string>();
  const dir = posix.dirname(rel);
  const resolveSpec = (spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const joined = posix.normalize(posix.join(dir, spec));
    const stem = joined.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [joined, ...RESOLVE_SUFFIXES.map((s) => stem + s)].filter((c) => /\.(?:[cm]?ts|tsx)$/.test(c));
    if (!root) return candidates[0];
    return candidates.find((c) => existsSync(join(root, c))) ?? candidates[0];
  };
  const namespaces = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveSpec(statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (!target || !clause) continue;
    if (clause.name) found.add(`${prefix}${target}#default`);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) found.add(`${prefix}${target}#${(el.propertyName ?? el.name).text}`);
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, target);
    }
  }
  if (namespaces.size) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const target = namespaces.get(node.expression.text);
        if (target) found.add(`${prefix}${target}#${node.name.text}`);
      } else if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
        const target = namespaces.get(node.left.text);
        if (target) found.add(`${prefix}${target}#${node.right.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found];
}

/** Reads/writes of a set of file changes. Unchanged files contribute nothing. */
export function analyzeChanges(changes: FileChange[], root?: string, prefix = ""): Sets {
  const reads = new Set<string>();
  const writes = new Map<string, Write>();
  for (const c of changes) {
    if (c.before === c.after) continue;
    const repoPath = prefix + c.rel;
    if (ANALYZABLE.test(c.rel)) {
      try {
        const result = analyze(c.before ?? "", c.after ?? "", repoPath);
        for (const k of result.reads) reads.add(k);
        for (const w of result.writes) writes.set(w.key, w);
        if (c.after) for (const k of importReads(c.after, c.rel, root, prefix)) reads.add(k);
        continue;
      } catch {
        /* unparsable: fall back to a whole-file write */
      }
    }
    const key = fileKey(repoPath);
    writes.set(key, { key, kind: c.before === null ? "new" : c.after === null ? "deleted" : "body" });
  }
  // A symbol this edit writes is not also an assumption it reads.
  for (const k of writes.keys()) reads.delete(k);
  return { reads: [...reads].sort(), writes: [...writes.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/**
 * `analyzeChanges` plus the tree-sitter languages (Python, C, C++, ...): what the hooks call. TypeScript
 * and JavaScript go through exactly the same path as `analyzeChanges`; files of a tree-sitter
 * language get declaration-level keys and import-resolved reads instead of a whole-file key.
 */
export async function analyzeChangesAsync(changes: FileChange[], root?: string, prefix = ""): Promise<Sets> {
  const typescriptOrOther = changes.filter((c) => !treeSitterLanguageFor(c.rel));
  const base = analyzeChanges(typescriptOrOther, root, prefix);
  const reads = new Set(base.reads);
  const writes = new Map(base.writes.map((w) => [w.key, w] as const));
  // Files this same tool call changes are read as they will be after it (a C header + its .c,
  // two files of one Go package).
  const pending = new Map(changes.map((c) => [c.rel, c.after] as const));
  const checkout = root ? checkoutAccess(root, pending) : {};
  for (const c of changes) {
    if (c.before === c.after || !treeSitterLanguageFor(c.rel)) continue;
    try {
      const result = await analyzeSource({ path: c.rel, before: c.before, after: c.after }, { prefix, ...checkout });
      for (const k of result.reads) reads.add(k);
      for (const w of result.writes) writes.set(w.key, w);
    } catch {
      const key = fileKey(prefix + c.rel);
      writes.set(key, { key, kind: c.before === null ? "new" : c.after === null ? "deleted" : "body" });
    }
  }
  for (const k of writes.keys()) reads.delete(k);
  return { reads: [...reads].sort(), writes: [...writes.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/**
 * What a tree-sitter language may look at besides the edited file (C/C++ included headers; Go
 * go.mod and the other files of a package): existence, listings, and reads that follow the
 * adapters' read rule (no symlinks, nothing outside the checkout, at most 1 MiB). `pending`
 * holds the post-edit text of files the same tool call changes (null = deleted).
 */
export function checkoutAccess(root: string, pending: Map<string, string | null> = new Map()) {
  return {
    exists: (rel: string) => (pending.has(rel) ? pending.get(rel) !== null : existsSync(join(root, rel))),
    read: (rel: string): string | undefined => (pending.has(rel) ? (pending.get(rel) ?? undefined) : (readInsideCheckout(root, join(root, rel), 1 << 20) ?? undefined)),
    list: (rel: string): string[] | undefined => {
      try {
        return readdirSync(join(root, rel), { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      } catch {
        return undefined;
      }
    },
  };
}

/** Plain unified diff (enough for humans and for `analyzeDiff`); LCS on lines. */
export function unifiedDiff(rel: string, before: string | null, after: string | null, context = 3): string {
  const a = before === null ? [] : splitLines(before);
  const b = after === null ? [] : splitLines(after);
  if (before === after) return "";
  // Trim common prefix/suffix, then LCS the middle (files edited by one tool call are small deltas).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Array<{ t: " " | "-" | "+"; line: string; ai: number; bi: number }> = [];
  for (let i = 0; i < start; i++) ops.push({ t: " ", line: a[i], ai: i, bi: i });
  const mid = midA.length * midB.length <= 4_000_000 ? lcs(midA, midB) : [...midA.map((l) => ["-", l] as const), ...midB.map((l) => ["+", l] as const)];
  let ai = start;
  let bi = start;
  for (const [t, line] of mid) {
    ops.push({ t, line, ai, bi });
    if (t !== "+") ai++;
    if (t !== "-") bi++;
  }
  for (let i = 0; i < a.length - endA; i++) ops.push({ t: " ", line: a[endA + i], ai: endA + i, bi: endB + i });

  const header = [`diff --git a/${rel} b/${rel}`, before === null ? "--- /dev/null" : `--- a/${rel}`, after === null ? "+++ /dev/null" : `+++ b/${rel}`];
  const out: string[] = [...header];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === " ") {
      i++;
      continue;
    }
    let s = Math.max(0, i - context);
    let e = i;
    // extend the hunk while changes are within 2*context of each other
    for (;;) {
      while (e < ops.length && ops[e].t !== " ") e++;
      let next = e;
      while (next < ops.length && ops[next].t === " " && next - e < 2 * context) next++;
      if (next < ops.length && ops[next].t !== " " && next - e < 2 * context) {
        e = next;
        continue;
      }
      break;
    }
    const end = Math.min(ops.length, e + context);
    const slice = ops.slice(s, end);
    const oldStart = slice[0].ai + 1;
    const newStart = slice[0].bi + 1;
    const oldLen = slice.filter((o) => o.t !== "+").length;
    const newLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${oldLen ? oldStart : oldStart - 1},${oldLen} +${newLen ? newStart : newStart - 1},${newLen} @@`);
    for (const o of slice) out.push(o.t + o.line);
    i = end;
    s = end;
  }
  return out.join("\n") + "\n";
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcs(a: string[], b: string[]): Array<readonly [" " | "-" | "+", string]> {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<readonly [" " | "-" | "+", string]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([" ", a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["-", a[i++]]);
    else out.push(["+", b[j++]]);
  }
  while (i < n) out.push(["-", a[i++]]);
  while (j < m) out.push(["+", b[j++]]);
  return out;
}
