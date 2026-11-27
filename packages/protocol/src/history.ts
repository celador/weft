// Revert history (spec §9.7 history read, §6.6 `previously_reverted`). Pure functions over log
// records, shared by the reference coordinator and the SQL coordinator so both index, filter and
// render history identically. Nothing here stores anything: every field of a history entry and of
// the note is read from records already in the log.
//
// A `revert` record names the op it undoes (`reverts_seq` / `reverts_op_id`), not keys. Its keys
// are derived once, when the revert is appended: revert -> the `land` record of that op -> its
// change -> the keys of that change's accepted edits up to the landing (plus the land's and the
// revert's own writes). Coordinators keep the result in a small key -> seq index, so a history read
// or a pre-edit check never scans the log.

import { WcpProtocolError } from "./errors";
import { threadRoot } from "./negotiation";
import { fileOf, isSymbolKey } from "./summary";
import type { Actor, Diagnostic, EventRecord, HistoryEntry, HistoryKind, HistoryQuery, NegotiationTerms, Seq, SymbolKey } from "./types";

export const DAY_MS = 86_400_000;
/** Default window of a history read (spec §9.7). */
export const HISTORY_DEFAULT_DAYS = 90;
/** How recent a revert must be to put a `previously_reverted` note on an edit (spec §6.6). */
export const NOTE_WINDOW_DAYS = 30;
export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 100;
export const HISTORY_MAX_KEYS = 50;
const MAX_KEY_LENGTH = 1024;
const REASON_MAX = 200;

type Lookup = (seq: Seq) => EventRecord | undefined;

/** What a coordinator provides so `historyIndex` can derive a record's keys. */
export type HistorySource = {
  record: Lookup;
  /** The accepted `land` record a revert undoes: by seq (`reverts_seq`), else by op id. */
  land: (seq: Seq | undefined, opId: string | undefined) => EventRecord | undefined;
  /** Keys written by `change`'s accepted `edit` records with seq <= `upTo`. */
  editKeys: (change: string, upTo: Seq) => SymbolKey[];
};

/** One row of a coordinator's history index: record `seq` concerns `key`. */
export type HistoryRow = { key: SymbolKey; seq: Seq; kind: HistoryKind; at: number };

const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)];
const symbolKeys = (xs: Iterable<string>) => uniq([...xs].filter((k) => typeof k === "string" && isSymbolKey(k) && k.length <= MAX_KEY_LENGTH)).sort();

/**
 * The history rows of a just-appended record, or [] when it is not history: an accepted
 * `revert`, a rejected `edit`/`claim` (check or commit), or the accept/reject/escalate that
 * ended a negotiation. Deterministic: both coordinators index the same rows.
 */
export function historyRows(rec: EventRecord, src: HistorySource): HistoryRow[] {
  const at = Date.parse(rec.ts);
  const rows = (kind: HistoryKind, keys: string[]) => symbolKeys(keys).map((key) => ({ key, seq: rec.seq, kind, at }));
  if (rec.kind === "revert" && rec.status === "accepted") {
    const p = rec.payload ?? {};
    const land = src.land(typeof p.reverts_seq === "number" ? p.reverts_seq : undefined, typeof p.reverts_op_id === "string" ? p.reverts_op_id : undefined);
    const keys = rec.writes.map((w) => w.key);
    if (land) {
      keys.push(...land.writes.map((w) => w.key));
      const change = land.change ?? rec.change;
      if (change) keys.push(...src.editKeys(change, land.seq));
    } else if (rec.change) keys.push(...src.editKeys(rec.change, rec.seq));
    return rows("revert", keys);
  }
  if (rec.status === "rejected" && (rec.kind === "edit" || rec.kind === "claim")) {
    const errs = rec.diagnostics.filter((d) => d.severity === "error" && d.symbol);
    return rows("rejected", [...rec.writes.map((w) => w.key), ...errs.map((d) => d.symbol)]);
  }
  if (rec.status === "accepted" && (rec.kind === "negotiate.accept" || rec.kind === "negotiate.reject")) {
    const replied = src.record(Number(rec.payload?.reply_to));
    if (!replied) return [];
    const root = threadRoot(replied, src.record);
    return rows("negotiation", (root.payload?.keys as string[] | undefined) ?? []);
  }
  if (rec.status === "accepted" && rec.kind === "negotiate.escalate") return rows("negotiation", (rec.payload?.keys as string[] | undefined) ?? []);
  return [];
}

// ------------------------------------------------------------------ key scopes

/** Why `k` is not a history key pattern (symbol key, `path#*`, or a bare path). */
export function historyKeyError(k: unknown): string | undefined {
  if (typeof k !== "string" || !k.trim()) return "a key must be a non-empty string";
  if (k.length > MAX_KEY_LENGTH) return `a key must be at most ${MAX_KEY_LENGTH} characters`;
  if (/[\s,]/.test(k)) return "a key must not contain whitespace or commas";
  const hash = k.indexOf("#");
  if (hash === 0) return "a key needs a path before #";
  if (hash > 0 && !isSymbolKey(k)) return "a key is path#symbol, path#*, or a bare path";
  return undefined;
}

/**
 * The keys a pattern (or an edited key) covers: `exact` keys plus every key starting with one of
 * `prefixes`. `path#sym` covers itself, its members (`path#sym.x`) and whole-file records
 * (`path#*`); `path#*` and a bare `path` cover every key of the file.
 */
export function keyScope(pattern: string): { exact: string[]; prefixes: string[] } {
  const hash = pattern.indexOf("#");
  if (hash < 0) return { exact: [], prefixes: [`${pattern}#`] };
  const path = pattern.slice(0, hash);
  if (pattern.slice(hash + 1) === "*") return { exact: [], prefixes: [`${path}#`] };
  return { exact: uniq([pattern, `${path}#*`]), prefixes: [`${pattern}.`] };
}

export function inScope(key: string, scope: { exact: string[]; prefixes: string[] }): boolean {
  return scope.exact.includes(key) || scope.prefixes.some((p) => key.startsWith(p));
}

/** Half-open range [lo, hi) of every string starting with `prefix` (binary order), for an indexed SQL range scan. */
export function prefixRange(prefix: string): [string, string] {
  const last = prefix.codePointAt(prefix.length - 1)!;
  return [prefix, prefix.slice(0, -1) + String.fromCodePoint(last + 1)];
}

/** A validated history query: patterns, the window start (ms) and the page size. */
export function historyQuery(q: HistoryQuery, now: number): { keys: string[]; since: number; limit: number } {
  const bad = (path: string, message: string) => new WcpProtocolError("invalid_message", `invalid history query: ${message}`, { issues: [{ path, message }] });
  if (!q || !Array.isArray(q.keys) || !q.keys.length) throw bad("/keys", "keys is required (path#symbol, path#*, or a bare path)");
  const keys = uniq(q.keys.map((k) => (typeof k === "string" ? k.trim() : k)));
  if (keys.length > HISTORY_MAX_KEYS) throw bad("/keys", `at most ${HISTORY_MAX_KEYS} keys`);
  for (const [i, k] of keys.entries()) {
    const err = historyKeyError(k);
    if (err) throw bad(`/keys/${i}`, `${JSON.stringify(k)}: ${err}`);
  }
  let since = now - HISTORY_DEFAULT_DAYS * DAY_MS;
  if (q.since !== undefined) {
    const t = typeof q.since === "string" ? Date.parse(q.since) : NaN;
    if (!Number.isFinite(t)) throw bad("/since", "since must be an ISO 8601 timestamp");
    since = t;
  }
  let limit = HISTORY_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1) throw bad("/limit", "limit must be a positive integer");
    limit = Math.min(q.limit, HISTORY_MAX_LIMIT);
  }
  return { keys: keys as string[], since, limit };
}

// ------------------------------------------------------------------ entries

/** First line of a free-text reason, whitespace-collapsed and clipped. */
export function reasonLine(s: unknown, max = REASON_MAX): string {
  const line = typeof s === "string" ? (s.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim() : "";
  const chars = [...line];
  return chars.length <= max ? line : chars.slice(0, max - 1).join("").trimEnd() + "…";
}

/** The first stack frame in a text (JS `at f (file:1:2)`, Python `File "x", line 3`), if any. */
export function firstFrame(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  for (const raw of s.split("\n")) {
    const l = raw.trim();
    if (/^at\s+\S.*:\d+/.test(l) || /^File\s+"[^"]+",\s+line\s+\d+/.test(l)) return reasonLine(l, 160);
  }
  return undefined;
}

/** Who reverted: the revert's `requested_by`, else the system writer that appended it. */
export function revertedBy(rec: EventRecord): string {
  const rb = rec.payload?.requested_by as Actor | undefined;
  return rb && typeof rb.id === "string" && rb.id ? rb.id : rec.actor.id;
}

/** A history entry for record `rec` (kind from the index), concerning `keys`. */
export function historyEntry(rec: EventRecord, kind: HistoryKind, keys: SymbolKey[], record: Lookup): HistoryEntry {
  const p = rec.payload ?? {};
  const base: HistoryEntry = {
    seq: rec.seq,
    ts: rec.ts,
    kind,
    keys: [...keys].sort(),
    actor: rec.actor,
    ...(rec.agent ? { agent: rec.agent } : {}),
    ...(rec.change ? { change: rec.change } : {}),
    ...(rec.task ? { task: rec.task } : {}),
  };
  if (kind === "revert") {
    const rb = p.requested_by as Actor | undefined;
    const evidence = firstFrame(p.reason);
    return {
      ...base,
      reason: reasonLine(p.reason) || "no reason given",
      ...(rb && typeof rb.id === "string" ? { requested_by: rb } : {}),
      ...(typeof p.reverts_seq === "number" ? { reverts_seq: p.reverts_seq } : {}),
      ...(typeof p.reverts_op_id === "string" ? { reverts_op_id: p.reverts_op_id } : {}),
      ...(typeof p.op_id === "string" ? { op_id: p.op_id } : {}),
      ...(evidence ? { evidence } : {}),
    };
  }
  if (kind === "rejected") {
    const errs = rec.diagnostics.filter((d) => d.severity === "error");
    return { ...base, event_kind: rec.kind, ...(rec.mode ? { mode: rec.mode } : {}), causes: errs.length ? errs : rec.diagnostics };
  }
  if (rec.kind === "negotiate.escalate") {
    const w = (p.with ?? {}) as { agent?: string; change?: string };
    return { ...base, outcome: "escalated", ...(typeof p.reason === "string" ? { reason: reasonLine(p.reason) } : {}), ...(w.agent || w.change ? { with: (w.agent ?? w.change)! } : {}) };
  }
  const replied = record(Number(p.reply_to));
  const terms = replied?.payload?.terms as NegotiationTerms | undefined;
  return {
    ...base,
    outcome: rec.kind === "negotiate.accept" ? "accepted" : "rejected",
    ...(terms ? { terms } : {}),
    ...(typeof p.reply_to === "number" ? { reply_to: p.reply_to } : {}),
    ...(rec.kind === "negotiate.reject" && typeof p.reason === "string" && p.reason.trim() ? { reason: reasonLine(p.reason) } : {}),
    ...(replied && (replied.agent ?? replied.actor.id) ? { with: replied.agent ?? replied.actor.id } : {}),
  };
}

/**
 * Group index rows into page entries: rows of one record become one entry (its matched keys),
 * newest first, at most `limit` (+ whether more exist).
 */
export function historyPageOf(rows: HistoryRow[], limit: number, record: Lookup): { entries: HistoryEntry[]; has_more: boolean } {
  const bySeq = new Map<Seq, { kind: HistoryKind; keys: Set<string> }>();
  for (const r of rows) {
    const e = bySeq.get(r.seq) ?? { kind: r.kind, keys: new Set<string>() };
    e.keys.add(r.key);
    bySeq.set(r.seq, e);
  }
  const seqs = [...bySeq.keys()].sort((a, b) => b - a);
  const entries: HistoryEntry[] = [];
  for (const s of seqs.slice(0, limit)) {
    const rec = record(s);
    const e = bySeq.get(s)!;
    if (rec) entries.push(historyEntry(rec, e.kind, [...e.keys], record));
  }
  return { entries, has_more: seqs.length > limit };
}

// ------------------------------------------------------------------ the push note (§6.6)

/** `previously_reverted` (info, never blocks): the edited `key` had revert `rec` in the note window. */
export function revertNote(key: SymbolKey, rec: EventRecord, now: number): Diagnostic {
  const days = Math.max(0, Math.floor((now - Date.parse(rec.ts)) / DAY_MS));
  const by = revertedBy(rec);
  return {
    severity: "info",
    code: "previously_reverted",
    file: fileOf(key),
    symbol: key,
    message: `previously reverted ${days}d ago: ${reasonLine(rec.payload?.reason) || "no reason given"} (by ${by}, #${rec.seq})`,
    caused_by_seq: rec.seq,
    caused_by_agent: by,
  };
}

// ------------------------------------------------------------------ rendering (MCP, CLIs)

function age(ts: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(ts));
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d ago`;
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 60_000)}m ago`;
}

const q = (s: string) => `"${s}"`;

/** One line per entry, citing its #seq like the other diagnostics. */
export function renderHistoryEntry(e: HistoryEntry, now: number): string {
  const head = `#${e.seq} ${age(e.ts, now)}`;
  const keys = ` [${e.keys.join(", ")}]`;
  const who = e.agent ?? e.actor.id;
  switch (e.kind) {
    case "revert": {
      const of = e.reverts_seq !== undefined ? ` of land #${e.reverts_seq}` : e.reverts_op_id ? ` of ${e.reverts_op_id}` : "";
      const change = e.change ? ` (change ${e.change}${e.agent ? ` by ${e.agent}` : ""})` : "";
      const by = e.requested_by?.id ?? e.actor.id;
      return `${head} REVERT${of}${change} by ${by}: ${e.reason ?? "no reason given"}${e.evidence ? ` — evidence: ${e.evidence}` : ""}${keys}`;
    }
    case "rejected": {
      const causes = (e.causes ?? []).map((d) => `${d.code} (#${d.caused_by_seq} by ${d.caused_by_agent}): ${reasonLine(d.message, 160)}`);
      return `${head} REFUSED ${e.event_kind ?? "edit"}${e.mode === "check" ? " (check)" : ""} by ${who}${e.change ? ` (change ${e.change})` : ""}: ${causes.join("; ") || "rejected"}${keys}`;
    }
    case "negotiation": {
      const terms = e.terms ? ` ${e.terms.kind} ${q(reasonLine(e.terms.text, 160))}` : "";
      const reply = e.reply_to !== undefined ? ` (answering #${e.reply_to})` : "";
      const why = e.reason ? `: ${e.reason}` : "";
      const verb = e.outcome === "accepted" ? "ACCEPTED" : e.outcome === "escalated" ? "ESCALATED" : "REJECTED";
      return `${head} negotiation ${verb} by ${who}${e.with ? ` with ${e.with}` : ""}${terms ? `:${terms}` : ""}${reply}${why}${keys}`;
    }
  }
}
