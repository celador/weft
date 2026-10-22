// Before/after text per file from a record's unified diff, for side-by-side diff editors
// (the VS Code `weft-event:` documents, a JetBrains diff viewer).
//
// A record carries a diff, not whole files, so only the hunks are known. Lines outside the
// hunks are filled with empty lines so that line numbers on both sides match the real file:
// line 42 in the diff editor is line 42 in the checkout. Both sides get the same filler, so a
// diff editor shows only the hunks as changed.

import { parseDiff } from "./diff";

export type DiffSides = {
  file: string;
  before: string;
  after: string;
  /** True when the file did not exist before (all lines added). */
  added: boolean;
  /** True when the file was deleted (all lines removed). */
  deleted: boolean;
};

export function diffSides(diff: string): DiffSides[] {
  const out: DiffSides[] = [];
  let cur: { file: string; before: string[]; after: string[]; adds: number; dels: number; ctx: number } | undefined;
  const flush = () => {
    if (!cur) return;
    out.push({
      file: cur.file,
      before: cur.before.join("\n") + (cur.before.length ? "\n" : ""),
      after: cur.after.join("\n") + (cur.after.length ? "\n" : ""),
      added: cur.dels === 0 && cur.ctx === 0 && cur.adds > 0,
      deleted: cur.adds === 0 && cur.ctx === 0 && cur.dels > 0,
    });
  };
  const put = (side: string[], line: number | undefined, text: string) => {
    if (line === undefined || line < 1) return;
    while (side.length < line - 1) side.push("");
    side[line - 1] = text;
  };
  for (const l of parseDiff(diff)) {
    if (l.kind === "file") {
      flush();
      cur = { file: l.text, before: [], after: [], adds: 0, dels: 0, ctx: 0 };
      continue;
    }
    if (!cur) cur = { file: "", before: [], after: [], adds: 0, dels: 0, ctx: 0 };
    if (l.kind === "add") {
      cur.adds++;
      put(cur.after, l.new, l.text);
    } else if (l.kind === "del") {
      cur.dels++;
      put(cur.before, l.old, l.text);
    } else if (l.kind === "ctx") {
      cur.ctx++;
      put(cur.before, l.old, l.text);
      put(cur.after, l.new, l.text);
    }
  }
  flush();
  return out.filter((s) => s.file || s.before || s.after);
}
