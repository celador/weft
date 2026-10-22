// Text forms of feed rows, squiggles and "Editing now" rows: one line for a terminal feed or a
// status bar, several lines for a detail view or a tooltip. A squiggle renders with
// @weft/protocol's `renderDiagnostic`, the function behind every adapter's `renderContext()`,
// so it reads the same in a terminal, a panel and a model's context.

import { renderDiagnostic } from "@weft/protocol";
import type { Squiggle } from "./actions";
import type { Editing, FeedRow, StripItem } from "./strip";
import { feedRow, fileNames, relTime } from "./strip";
import { summaryWithActor } from "./summary";
import { type FeedEvent, isRejected } from "./types";

export type TextOptions = {
  /** Several lines (detail) instead of one (feed). */
  multiline?: boolean;
  /** ANSI colours (terminals). */
  ansi?: boolean;
  /** For relative times; omit to leave times out (deterministic output). */
  now?: number;
};

const C = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, dim: 2, bold: 1 } as const;
function paint(on: boolean | undefined, color: keyof typeof C, s: string): string {
  return on ? `\u001b[${C[color]}m${s}\u001b[0m` : s;
}

function isSquiggle(x: unknown): x is Squiggle {
  return !!x && typeof x === "object" && "causeText" in x && "diagnostic" in x;
}
function isEditing(x: unknown): x is Editing {
  return !!x && typeof x === "object" && "trail" in x && "lastEdit" in x;
}
function isRow(x: unknown): x is FeedRow {
  return !!x && typeof x === "object" && "record" in x && "badge" in x;
}
function isStripItem(x: unknown): x is StripItem {
  return !!x && typeof x === "object" && "tone" in x && "detail" in x;
}

/** One squiggle: exactly the line an adapter injects into the model's context. */
export function renderSquiggle(s: Squiggle, o: TextOptions = {}): string {
  const line = renderDiagnostic(s.diagnostic);
  const color = s.severity === "error" ? "red" : s.severity === "warning" ? "yellow" : "blue";
  if (!o.multiline) return paint(o.ansi, color, line);
  const where = s.line ? `${s.file}:${s.line}:${s.column ?? 1}` : s.file || s.symbolKey;
  return [
    paint(o.ansi, color, `${s.severity} ${s.label} · ${s.symbol}`) + `  ${where}`,
    `  ${s.message}`,
    ...(s.suggestion ? [`  suggestion: ${s.suggestion}`] : []),
    `  ${s.causeText}  (on ${s.on}${s.rejected ? ", blocked" : ""})`,
  ].join("\n");
}

/** One "Editing now" row. */
export function renderEditing(e: Editing, o: TextOptions = {}): string {
  const mark = e.conflicted ? paint(o.ansi, "yellow", "⚠") : paint(o.ansi, "green", "●");
  const head = e.title ?? e.task ?? e.change;
  const bits = [e.who, e.count === 1 ? "1 edit" : `${e.count} edits`, fileNames(e.files, o.multiline ? 6 : 2)].filter(Boolean);
  const when = o.now !== undefined ? ` · ${relTime(e.lastEdit, o.now)}` : "";
  const line = `${mark} ${head} — ${bits.join(" · ")}${when}`;
  if (!o.multiline) return line;
  return [line, `  change ${e.change}${e.task ? ` · task ${e.task}` : ""} · latest ${e.latest}`, ...e.files.map((f) => `  ${f}`)].join("\n");
}

/** One feed row (Changes feed). */
export function renderRow(r: FeedRow, o: TextOptions = {}): string {
  const tint = r.tint === "red" ? "red" : r.tint === "green" ? "green" : r.tint === "purple" ? "magenta" : "dim";
  const when = o.now !== undefined ? `${relTime(r.date, o.now)} ` : "";
  const task = r.taskLabel ? ` · ${r.taskLabel}` : "";
  const line = `${when}${r.repo}#${r.seq} ${paint(o.ansi, "bold", r.who)}${task} ${paint(o.ansi, tint, `[${r.badge}]`)} ${r.summary}`;
  if (!o.multiline) return r.diagnostics.length ? `${line} ${paint(o.ansi, "yellow", `(${r.diagnostics.length} squiggle${r.diagnostics.length > 1 ? "s" : ""})`)}` : line;
  const e = r.record;
  const out = [line];
  if (e.intent) out.push(`  intent: ${e.intent}`);
  const syms = r.symbols.map((s) => `${s.write ? "✎" : "👁"} ${s.name}`).join("  ");
  if (syms) out.push(`  ${syms}${r.moreSymbols ? ` +${r.moreSymbols}` : ""}`);
  else if (r.file) out.push(`  ${r.file}${r.moreFiles ? ` +${r.moreFiles}` : ""}`);
  for (const d of e.diagnostics) out.push(`  ${paint(o.ansi, d.severity === "error" ? "red" : "yellow", renderDiagnostic(d))}`);
  return out.join("\n");
}

/** One strip row (Otto's "Every edit · live"). */
export function renderStripItem(i: StripItem, o: TextOptions = {}): string {
  const icon = i.tone === "edit" ? "✎" : i.tone === "landed" ? paint(o.ansi, "green", "⇣") : i.tone === "install" ? paint(o.ansi, "blue", "▣") : paint(o.ansi, "yellow", "⚠");
  const badge = i.badge ? ` ${paint(o.ansi, i.badge.type === "blocked" ? "red" : "yellow", `[${i.badge.label}]`)}` : "";
  const detail = i.tone === "edit" ? [i.cardTitle, i.who].filter(Boolean).join(" · ") : i.detail;
  const when = o.now !== undefined ? ` · ${relTime(i.date, o.now)}` : "";
  return `${icon} ${i.title || "edit"}${badge}${detail ? ` — ${detail}` : ""}${when}`;
}

/**
 * Text for anything the feed shows: a squiggle, an "Editing now" row, a feed row, a strip row
 * or a raw record.
 */
export function renderText(x: Squiggle | Editing | FeedRow | StripItem | FeedEvent, o: TextOptions = {}): string {
  if (isSquiggle(x)) return renderSquiggle(x, o);
  if (isEditing(x)) return renderEditing(x, o);
  if (isRow(x)) return renderRow(x, o);
  if (isStripItem(x)) return renderStripItem(x, o);
  const e = x as FeedEvent;
  if (!o.multiline) return renderRow(feedRow(e), o);
  return [
    renderRow(feedRow(e), o),
    `  ${summaryWithActor(e)}${isRejected(e) ? (e.mode === "check" ? " (stopped before it was made)" : " (rejected)") : ""}`,
  ].join("\n");
}
