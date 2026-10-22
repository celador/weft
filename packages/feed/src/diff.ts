// Unified diff parsing for the detail pane, ported from Otto (WeftDiffView.swift `DiffParser`):
// file headers collapse to one path row, hunks keep their header, every line gets old/new
// line numbers.

export type DiffLineKind = "file" | "hunk" | "add" | "del" | "ctx" | "meta";
export type DiffLine = { kind: DiffLineKind; text: string; old?: number; new?: number };

/** `@@ -10,3 +12,4 @@` -> [10, 12]. */
export function hunkStarts(header: string): [number, number] {
  const parts = header.split(" ");
  const start = (p: string | undefined) => (p ? Number(p.slice(1).split(",")[0]) || 0 : 0);
  return [start(parts[1]), start(parts[2])];
}

export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldN = 0;
  let newN = 0;
  let sawGitHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const last = line.split(" ").pop() ?? line;
      out.push({ kind: "file", text: last.replace(/^b\//, "") });
      sawGitHeader = true;
    } else if (line.startsWith("+++ ")) {
      // Diffs without a `diff --git` line (adapters send plain unified diffs) still name the file.
      const f = line.slice(4).replace(/^b\//, "").trim();
      if (!sawGitHeader && f !== "/dev/null") out.push({ kind: "file", text: f });
    } else if (
      line.startsWith("--- ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity") ||
      line.startsWith("rename ")
    ) {
      continue;
    } else if (line.startsWith("@@")) {
      [oldN, newN] = hunkStarts(line);
      out.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      out.push({ kind: "add", text: line.slice(1), new: newN++ });
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: line.slice(1), old: oldN++ });
    } else if (line.startsWith("\\")) {
      out.push({ kind: "meta", text: line });
    } else {
      out.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, old: oldN++, new: newN++ });
    }
  }
  // A trailing newline yields an empty context row; drop it.
  const last = out[out.length - 1];
  if (last && last.kind === "ctx" && last.text === "") out.pop();
  return out;
}
