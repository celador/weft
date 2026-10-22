// Squiggle → editor diagnostic, without the vscode module (unit-tested in Node). The extension
// turns a `Placed` into a vscode.Diagnostic.

import type { Squiggle } from "@weft/feed";

export type Placed = {
  /** 0-based line and columns. */
  line: number;
  start: number;
  end: number;
  /** How the range was found: the record's range, the symbol's declaration, any mention, or the top of the file. */
  how: "range" | "declaration" | "mention" | "file";
};

const DECL = (name: string) =>
  new RegExp(
    String.raw`\b(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl|module|namespace|protocol|record|val|object|sub|method)\s+\*?\s*` +
      escape(name) +
      String.raw`\b`,
  );

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where to underline `symbol` in `text`. A record's range wins; else its declaration; else a mention; else line 1. */
export function placeSymbol(text: string, symbol: string, at?: { line?: number; column?: number }): Placed {
  const lines = text.split(/\r?\n/);
  if (at?.line !== undefined && at.line >= 1 && at.line <= lines.length) {
    const l = at.line - 1;
    const src = lines[l] ?? "";
    let start = Math.max(0, (at.column ?? 1) - 1);
    const idx = symbol && symbol !== "*" ? src.indexOf(symbol, start) : -1;
    if (idx >= 0) return { line: l, start: idx, end: idx + symbol.length, how: "range" };
    start = Math.min(start, src.length);
    const end = src.length > start ? src.length : start + 1;
    return { line: l, start: src.length > start ? start : 0, end: Math.max(end, 1), how: "range" };
  }
  if (symbol && symbol !== "*") {
    const decl = DECL(symbol);
    for (let i = 0; i < lines.length; i++) {
      const m = decl.exec(lines[i]!);
      if (m) {
        const s = m.index + m[0].length - symbol.length;
        return { line: i, start: s, end: s + symbol.length, how: "declaration" };
      }
    }
    const word = new RegExp(String.raw`\b${escape(symbol)}\b`);
    for (let i = 0; i < lines.length; i++) {
      const m = word.exec(lines[i]!);
      if (m) return { line: i, start: m.index, end: m.index + symbol.length, how: "mention" };
    }
  }
  const first = lines[0] ?? "";
  return { line: 0, start: 0, end: Math.max(1, first.length), how: "file" };
}

/** vscode.DiagnosticSeverity values: Error 0, Warning 1, Information 2, Hint 3. */
export function severityOf(s: Squiggle["severity"]): 0 | 1 | 2 {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}

/** The Problems-panel line: what a human and an agent (Copilot's get_errors) read. */
export function diagnosticMessage(q: Squiggle): string {
  const head = `${q.symbol || q.file}: ${q.label}. ${q.message}`;
  const tail = [q.suggestion ? `Suggestion: ${q.suggestion}` : undefined, `${q.rejected ? "Edit blocked by Weft" : "Weft"} · ${q.causeText}.`].filter(Boolean).join(" ");
  return `${head} ${tail}`.replace(/\s+/g, " ").trim();
}

/** `weft-event` code link target for a squiggle's cause. */
export const causeId = (q: Squiggle): string => q.cause.id;
