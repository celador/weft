// Which part of an edited file an edit's reads come from (docs/languages.md, "Reads are scoped
// to the edit").
//
// An edit reads what the code it adds or changes references, not what the whole file
// references. Every backend applies the same rule with this module:
//
//   - a declaration is *touched* when a line the edit adds (in the new text) or removes (in the
//     old text) has non-blank text in the declaration's own region: its span minus the spans of
//     the declarations nested in it. Changing one method of a class touches that method, not
//     the class; changing the class's header or a field initializer touches the class.
//   - a reference is in scope when the innermost declaration containing it is touched (any of
//     its lines: the whole declaration is re-asserted, not just the changed line), or, outside
//     every declaration (module-level statements), when it is on a line the edit adds.
//   - an import binding is read when the edit adds it or an in-scope reference uses it.
//
// So an edit to `__all__` does not read `_decode_entities`, which a function elsewhere in the
// same file calls, and the coordinator's open-error clearing (spec §6.5 rule 1: an accepted edit
// that reads the key) takes only an edit that re-did the call site.

/** A declaration's extent in one text: JS string offsets `[start, end)`; `name` is its qualified name. */
export type Span = { name: string; start: number; end: number };

/** Is the reference at this offset (in the new text) part of what the edit reads? */
export type EditScope = (offset: number) => boolean;

/** Every reference is in scope: a new file, or a backend that cannot place its declarations. */
export const WHOLE_FILE: EditScope = () => true;

/** Lines of `text` (without their `\n`) and the offset each starts at. */
function lines(text: string): { lines: string[]; starts: number[] } {
  if (text === "") return { lines: [], starts: [] };
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  if (lines[lines.length - 1] === "") {
    lines.pop();
    starts.pop();
  }
  return { lines, starts };
}

/** Above this many cells the middle of a line diff is not aligned: all of it counts as changed. */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Indices of the lines of `a` removed and of `b` added by a line diff (common prefix and suffix
 * trimmed, LCS on the rest). A middle too large to align is all removed and all added, which
 * only widens the scope.
 */
export function changedLines(a: string[], b: string[]): { removed: number[]; added: number[] } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const removed: number[] = [];
  const added: number[] = [];
  if (n * m > MAX_LCS_CELLS || n === 0 || m === 0) {
    for (let i = start; i < endA; i++) removed.push(i);
    for (let j = start; j < endB; j++) added.push(j);
    return { removed, added };
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[start + i] === b[start + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(start + i++);
    else added.push(start + j++);
  }
  while (i < n) removed.push(start + i++);
  while (j < m) added.push(start + j++);
  return { removed, added };
}

/**
 * For each offset of `text`, the index in `spans` of the innermost span containing it (-1:
 * none). Spans nest (a method inside its class); an outer span is painted first and its nested
 * spans over it.
 */
function owners(length: number, spans: Span[]): Int32Array {
  const owner = new Int32Array(length).fill(-1);
  const order = spans.map((_, i) => i).sort((x, y) => spans[x].start - spans[y].start || spans[y].end - spans[x].end);
  for (const i of order) {
    const { start, end } = spans[i];
    owner.fill(i, Math.max(0, start), Math.min(length, end));
  }
  return owner;
}

/** Names of the declarations owning a non-blank character of the given lines. */
function touched(text: { lines: string[]; starts: number[] }, owner: Int32Array, spans: Span[], indices: number[], module?: Set<number>): Set<string> {
  const names = new Set<string>();
  for (const index of indices) {
    const line = text.lines[index];
    const base = text.starts[index];
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c === 32 || c === 9 || c === 13) continue;
      const o = owner[base + k];
      if (o >= 0) names.add(spans[o].name);
      else module?.add(index);
    }
  }
  return names;
}

/**
 * The scope of an edit from `before` to `after`, given the declarations of each text. A new
 * file is in scope as a whole.
 */
export function editScope(before: string, after: string, beforeSpans: Span[], afterSpans: Span[]): EditScope {
  if (before === "") return WHOLE_FILE;
  const a = lines(before);
  const b = lines(after);
  const { removed, added } = changedLines(a.lines, b.lines);
  const ownerAfter = owners(after.length, afterSpans);
  const moduleLines = new Set<number>();
  const names = touched(b, ownerAfter, afterSpans, added, moduleLines);
  // A removed line touches the declaration it was in, if that declaration still exists.
  for (const name of touched(a, owners(before.length, beforeSpans), beforeSpans, removed)) names.add(name);
  return (offset) => {
    if (offset < 0 || offset >= after.length) return false;
    const o = ownerAfter[offset];
    if (o >= 0) return names.has(afterSpans[o].name);
    // Outside every declaration: only references on a line the edit adds.
    let lo = 0;
    let hi = b.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (b.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return moduleLines.has(lo);
  };
}
