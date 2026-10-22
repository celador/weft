// `weft_check {path, patch}`: apply a unified diff to the file's current text to get the
// proposed after-text. Strict: every context and removed line must match (after an optional
// fuzz on the hunk's start line), otherwise the patch is refused rather than guessed.

export type PatchResult = { ok: true; text: string } | { ok: false; error: string };

type Hunk = { oldStart: number; lines: string[] };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(patch: string): Hunk[] | string {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (cur) cur = undefined;
      continue;
    }
    const m = HUNK.exec(line);
    if (m) {
      cur = { oldStart: Number(m[1]), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) {
      if (!line.trim()) continue;
      return `unexpected line outside a hunk: ${JSON.stringify(line.slice(0, 80))}`;
    }
    if (line === "\\ No newline at end of file") {
      cur.lines.push(line);
      continue;
    }
    const c = line[0];
    if (c === " " || c === "+" || c === "-") cur.lines.push(line);
    else if (line === "") cur.lines.push(" "); // some tools drop the space on empty context lines
    else return `bad hunk line: ${JSON.stringify(line.slice(0, 80))}`;
  }
  if (!hunks.length) return "no @@ hunks found (pass a unified diff, or new_content)";
  return hunks;
}

function matchesAt(text: string[], at: number, old: string[]): boolean {
  if (at < 0 || at + old.length > text.length) return false;
  for (let i = 0; i < old.length; i++) if (text[at + i] !== old[i]) return false;
  return true;
}

/** Apply a unified diff to `before` (null = the file does not exist yet). */
export function applyPatch(before: string | null, patch: string): PatchResult {
  const parsed = parseHunks(patch);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  const src = before ?? "";
  const endsWithNl = src === "" || src.endsWith("\n");
  const text = src === "" ? [] : (endsWithNl ? src.slice(0, -1) : src).split("\n");
  let out: string[] = [];
  let pos = 0;
  let noNlAtEnd = !endsWithNl;
  for (const [n, h] of parsed.entries()) {
    const old: string[] = [];
    const neu: string[] = [];
    let prev = "";
    let newMarked = false;
    let oldMarked = false;
    for (const l of h.lines) {
      if (l === "\\ No newline at end of file") {
        if (prev === "+" || prev === " ") newMarked = true;
        if (prev === "-" || prev === " ") oldMarked = true;
        continue;
      }
      prev = l[0]!;
      if (l[0] === " " || l[0] === "-") old.push(l.slice(1));
      if (l[0] === " " || l[0] === "+") neu.push(l.slice(1));
    }
    // A marker describes the file's last line on that side: new side unmarked but old side
    // marked = the patch adds the final newline.
    if (newMarked) noNlAtEnd = true;
    else if (oldMarked) noNlAtEnd = false;
    // Pure insertion into an empty file: -0,0
    let at = h.oldStart === 0 ? 0 : h.oldStart - 1;
    if (!matchesAt(text, at, old)) {
      let found = -1;
      for (let d = 1; d <= 200 && found < 0; d++) {
        if (at - d >= pos && matchesAt(text, at - d, old)) found = at - d;
        else if (matchesAt(text, at + d, old)) found = at + d;
      }
      if (found < 0) return { ok: false, error: `hunk ${n + 1} (@@ -${h.oldStart}) does not match the current file; re-read it and send new_content or a fresh patch` };
      at = found;
    }
    if (at < pos) return { ok: false, error: `hunk ${n + 1} overlaps the previous hunk` };
    out = out.concat(text.slice(pos, at), neu);
    pos = at + old.length;
  }
  out = out.concat(text.slice(pos));
  if (!out.length) return { ok: true, text: "" };
  return { ok: true, text: out.join("\n") + (noNlAtEnd ? "" : "\n") };
}
