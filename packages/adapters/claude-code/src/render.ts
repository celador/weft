// Model-visible rendering of diagnostics (spec §4.3, §8.3). The coordinator is
// position-agnostic; the adapter fills `range` from its checkout so squiggles read like
// compiler output (`src/cart.ts:12:10`), then renders with the shared `renderDiagnostic`
// so every harness shows identical text. For contract changes the adapter also quotes the
// causing event's diff: the other agent's edit lives in its own fork, so this agent cannot
// read the new signature from its checkout.
import { readInsideCheckout } from "./safe-read";
import { join } from "node:path";
import { agreementOf, renderDiagnostic, renderDue, renderInboxItem, type Diagnostic, type EventRecord, type InboxItem, type NegotiationDue, type Range } from "@weft/protocol";

export type EditedFile = { rel: string; before: string | null; after: string | null };
export type RenderCtx = {
  root: string;
  prefix: string;
  /** The file this tool call edits (call-site location for read-based diagnostics). */
  edited?: EditedFile;
  fetchEvent?: (seq: number) => Promise<EventRecord | undefined>;
  /** Shell command the model runs for `negotiate` / `inbox` (spec §7.4); enables option hints. */
  cli?: string;
  /** This checkout's change id (role-specific negotiation hints). */
  change?: string;
};

/** Errors where another agent holds the area: the loser's options apply (spec §7.2). */
const LOSER_CODES = new Set(["stale_assumption", "claim_wait", "claim_die", "claim_wounded"]);

const READ_CODES = new Set(["stale_assumption", "stale_read"]);
const QUOTE_CODES = new Set(["stale_assumption", "contract_changed", "stale_overwrite"]);
const MAX_QUOTE_LINES = 30;

function splitKey(key: string): { path: string; name: string } {
  const i = key.indexOf("#");
  const path = i >= 0 ? key.slice(0, i) : key;
  const qualified = i >= 0 ? key.slice(i + 1) : "";
  return { path, name: qualified.split(".").pop() ?? qualified };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function rangeAt(lines: string[], line: number, name: string): Range {
  const col = Math.max(0, lines[line].search(new RegExp(`\\b${escape(name)}\\b`)));
  return { start: { line, character: col }, end: { line, character: col + name.length } };
}

/** First use of `name` on a line the edit added (else any non-import use). */
export function locateUse(after: string, before: string | null, name: string): Range | undefined {
  if (!name || name === "*") return undefined;
  const lines = after.split("\n");
  const old = new Set((before ?? "").split("\n"));
  const re = new RegExp(`\\b${escape(name)}\\b`);
  const isImport = (l: string) => /^\s*(import|export\s+\{[^}]*\}\s+from)\b/.test(l);
  let fallback: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i]) || isImport(lines[i])) continue;
    if (!old.has(lines[i])) return rangeAt(lines, i, name);
    fallback ??= i;
  }
  return fallback === undefined ? undefined : rangeAt(lines, fallback, name);
}

/** Declaration of `name` in a file's text. */
export function locateDeclaration(text: string, name: string): Range | undefined {
  if (!name || name === "*") return undefined;
  const lines = text.split("\n");
  const n = escape(name);
  const decl = new RegExp(`\\b(function\\*?|class|interface|type|enum|const|let|var|namespace)\\s+${n}\\b`);
  const member = new RegExp(`^\\s*(?:(?:public|private|protected|static|async|readonly|get|set|override)\\s+)*${n}\\s*[(<:=?]`);
  for (let i = 0; i < lines.length; i++) if (decl.test(lines[i])) return rangeAt(lines, i, name);
  for (let i = 0; i < lines.length; i++) if (member.test(lines[i])) return rangeAt(lines, i, name);
  return undefined;
}

function readCheckout(root: string, rel: string): string | undefined {
  // Same rule as every adapter read: no symlinks, nothing outside the checkout.
  return readInsideCheckout(root, join(root, rel), 1 << 20) ?? undefined;
}

/** Fill `file`/`range` from the checkout. Never throws. */
export function locate(d: Diagnostic, ctx: RenderCtx): Diagnostic {
  if (d.range) return d;
  try {
    const { path, name } = splitKey(d.symbol || d.file);
    const rel = ctx.prefix && path.startsWith(ctx.prefix) ? path.slice(ctx.prefix.length) : path;
    const edited = ctx.edited;
    if (edited?.after && READ_CODES.has(d.code)) {
      const range = locateUse(edited.after, edited.before, name);
      if (range) return { ...d, file: ctx.prefix + edited.rel, range };
    }
    const text = edited && edited.rel === rel && edited.after !== null ? edited.after : readCheckout(ctx.root, rel);
    const range = text === undefined ? undefined : locateDeclaration(text, name);
    return range ? { ...d, file: path, range } : d;
  } catch {
    return d;
  }
}

/** The hunks of `record.diff` for the symbol's file, clipped. */
export function quoteDiff(record: EventRecord, symbol: string): string | undefined {
  if (!record.diff) return undefined;
  const { path } = splitKey(symbol);
  const out: string[] = [];
  let inFile = false;
  for (const line of record.diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inFile = line.endsWith(` b/${path}`);
      continue;
    }
    if (!inFile || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ")) continue;
    out.push(line);
  }
  if (!out.some((l) => l.startsWith("+") || l.startsWith("-"))) return undefined;
  const clipped = out.length > MAX_QUOTE_LINES ? [...out.slice(0, MAX_QUOTE_LINES), `… (${out.length - MAX_QUOTE_LINES} more lines)`] : out;
  return clipped.map((l) => `    ${l}`).join("\n");
}

/** How to exercise the loser's options from the shell (spec §7.2 options, §7.4, §7.6). */
export function optionsHint(cli: string, other: string): string {
  return (
    `  ↳ Your options: retreat (rework without that code) | wait (until ${other} lands or releases it) | ` +
    `negotiate: \`${cli} negotiate propose overload "<what ${other} should keep working for you>" --wait 240\` (terms: overload | transfer | share | sequence | merge_tasks | other; it is delivered to ${other} and you get the reply) | ` +
    `escalate: \`${cli} negotiate escalate "<why>"\` (the coordinator merges your two tasks).`
  );
}

function answerHint(cli: string, seq: number): string {
  return `  ↳ Answer from the shell: \`${cli} negotiate accept ${seq}\` | \`${cli} negotiate reject ${seq} "<why>"\` | \`${cli} negotiate counter ${seq} <overload|transfer|share|sequence|merge_tasks|other> "<terms>"\`.`;
}

/** Spell out an accepted agreement for this side (asker vs giver). */
async function agreementHint(r: EventRecord, ctx: RenderCtx): Promise<string | undefined> {
  if (r.kind !== "negotiate.accept" || !ctx.fetchEvent) return undefined;
  const cache = new Map<number, EventRecord | undefined>();
  const want = new Set<number>([Number(r.payload?.reply_to)]);
  // Walk the thread (reply_to chain) so agreementOf() can find its root.
  for (let i = 0; i < 20 && want.size; i++) {
    const [n] = want;
    want.delete(n!);
    if (cache.has(n!)) continue;
    const rec = await ctx.fetchEvent(n!).catch(() => undefined);
    cache.set(n!, rec);
    if (rec && rec.kind !== "negotiate.propose" && rec.payload?.reply_to !== undefined) want.add(Number(rec.payload.reply_to));
  }
  const a = agreementOf(r, (n) => cache.get(n));
  if (!a) return undefined;
  const terms = `${a.terms.kind}: "${a.terms.text}" on ${a.keys.join(", ")}`;
  if (ctx.change && a.giver === ctx.change)
    return `  ↳ You are bound by agreement #${r.seq} (${terms}). Make that edit now${a.terms.kind === "overload" ? " — keep the old call shape compiling next to the new one" : ""}; Weft will not let you finish before it is in the log.`;
  if (ctx.change && a.asker === ctx.change)
    return `  ↳ ${a.giver === r.change ? r.agent ?? "the other agent" : "The other side"} agreed (#${r.seq}, ${terms}). Continue with your original plan; if one more edit is blocked by their follow-up change, read the quoted diff (it should be the agreed change) and retry the same edit.`;
  return `  ↳ Agreement #${r.seq}: ${terms}.`;
}

/** Render negotiation dues from a stop-gate result (spec §8.4). */
export function renderDues(dues: NegotiationDue[], ctx: RenderCtx): string {
  return dues.map((d) => renderDue(d) + (ctx.cli && d.due === "reply" ? `\n${answerHint(ctx.cli, d.seq)}` : "")).join("\n");
}

/** Render verdict/inbox diagnostics as the text injected into Claude. */
export async function renderForModel(diagnostics: Diagnostic[], inbox: InboxItem[], ctx: RenderCtx): Promise<string> {
  const lines: string[] = [];
  const seen = new Set<string>();
  const quoted = new Set<string>();
  const push = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      lines.push(s);
    }
  };
  const one = async (d: Diagnostic) => {
    const located = locate(d, ctx);
    push(renderDiagnostic(located));
    const qk = `${d.caused_by_seq}:${d.symbol}`;
    if (QUOTE_CODES.has(d.code) && ctx.fetchEvent && !quoted.has(qk)) {
      quoted.add(qk);
      const record = await ctx.fetchEvent(d.caused_by_seq).catch(() => undefined);
      const quote = record ? quoteDiff(record, d.symbol) : undefined;
      if (quote) push(`  ↳ event #${d.caused_by_seq} by ${d.caused_by_agent} changed ${splitKey(d.symbol).path} (their change is not in your checkout yet):\n${quote}`);
    }
  };
  for (const d of diagnostics) await one(d);
  for (const item of inbox) {
    if (item.diagnostic) await one(item.diagnostic);
    else {
      push(renderInboxItem(item));
      const r = item.record;
      if (item.kind === "negotiation" && r && ctx.cli && (r.kind === "negotiate.propose" || r.kind === "negotiate.counter")) push(answerHint(ctx.cli, r.seq));
      if (item.kind === "negotiation" && r?.kind === "negotiate.accept") {
        const hint = await agreementHint(r, ctx);
        if (hint) push(hint);
      }
    }
  }
  // One options hint per conflicting agent (the loser decides what to do next).
  if (ctx.cli) {
    const losers = [...diagnostics, ...inbox.flatMap((i) => (i.diagnostic ? [i.diagnostic] : []))].filter((d) => d.severity === "error" && LOSER_CODES.has(d.code));
    for (const other of new Set(losers.map((d) => d.caused_by_agent))) push(optionsHint(ctx.cli, other));
  }
  return lines.join("\n");
}
