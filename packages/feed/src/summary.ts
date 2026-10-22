// One-line summaries and symbol display, ported from Otto (WeftSummary.swift, WeftSymbol in
// WeftModels.swift). Coordinators attach their own summary (spec §6.4), but for files the
// analyzer does not parse the only "symbol" is the whole-file key `path#*`, which would read
// "added * in notes.md". The log is append-only, so the feed rebuilds those summaries from the
// record's structured fields.

import { type FeedEvent, who } from "./types";

/** `src/auth/session.ts#SessionStore.get` -> `SessionStore.get`. */
export function symbolName(key: string): string {
  const i = key.indexOf("#");
  return i < 0 ? key : key.slice(i + 1);
}
/** `src/auth/session.ts#refreshToken` -> `src/auth/session.ts` ("" for a bare key). */
export function symbolFile(key: string): string {
  const i = key.indexOf("#");
  return i < 0 ? "" : key.slice(0, i);
}
/** `README.md#*`: the whole-file key for files the analyzer does not parse. */
export const isWholeFile = (key: string): boolean => symbolName(key) === "*";
/** `docs/try-it.md` -> `try-it.md`. */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}
/** What a reader sees for a key: the symbol, or the file's name for a whole-file key. */
export const displayKey = (key: string): string => (isWholeFile(key) ? baseName(symbolFile(key)) : symbolName(key));

const unique = (xs: string[]): string[] => [...new Set(xs)];
const capitalized = (s: string): string => s.slice(0, 1).toUpperCase() + s.slice(1);

/** "a.md", "a.md, b.json", "a.md, b.json +3 more" (files by base name, symbols by name). */
export function names(keys: string[]): string {
  const shown = unique(keys.map(displayKey));
  if (!shown.length) return "all claims";
  if (shown.length <= 2) return shown.join(", ");
  return `${shown.slice(0, 2).join(", ")} +${shown.length - 2} more`;
}

export function landCount(writes: { key: string }[]): string {
  const files = unique(writes.filter((w) => isWholeFile(w.key)).map((w) => w.key)).length;
  const symbols = writes.length - writes.filter((w) => isWholeFile(w.key)).length;
  const out: string[] = [];
  if (files > 0) out.push(files === 1 ? "1 file" : `${files} files`);
  if (symbols > 0) out.push(symbols === 1 ? "1 symbol" : `${symbols} symbols`);
  return out.join(", ");
}

/** "edited *, added * in 43 files" -> "Edited run-4.driver.log, created 1-work.prompt.txt +41 more". */
export function editHead(writes: { key: string; kind: string }[]): string {
  const files = writes.filter((w) => isWholeFile(w.key));
  const symbols = writes.filter((w) => !isWholeFile(w.key));
  const parts: string[] = [];
  const edited = files.filter((w) => w.kind !== "new" && w.kind !== "deleted").map((w) => w.key);
  const created = files.filter((w) => w.kind === "new").map((w) => w.key);
  const deleted = files.filter((w) => w.kind === "deleted").map((w) => w.key);
  if (edited.length) parts.push(`edited ${names(edited)}`);
  if (created.length) parts.push(`created ${names(created)}`);
  if (deleted.length) parts.push(`deleted ${names(deleted)}`);
  if (symbols.length) {
    const by = (k: string) => symbols.filter((w) => w.kind === k).map((w) => w.key);
    const sp: string[] = [];
    if (by("signature").length) sp.push(`changed signature of ${names(by("signature"))}`);
    if (by("body").length) sp.push(`edited ${names(by("body"))}`);
    if (by("new").length) sp.push(`added ${names(by("new"))}`);
    if (by("deleted").length) sp.push(`removed ${names(by("deleted"))}`);
    const symFiles = unique(symbols.map((w) => symbolFile(w.key)));
    const where = symFiles.length === 1 ? ` in ${baseName(symFiles[0]!)}` : ` in ${symFiles.length} files`;
    parts.push(sp.join(", ") + where);
  }
  return capitalized(parts.join(", "));
}

/** The coordinator's " — <intent>" tail, if the summary kept one. */
export function reasonOf(summary: string): string | undefined {
  const i = summary.indexOf(" — ");
  if (i < 0) return undefined;
  const t = summary.slice(i + 3).trim();
  return t || undefined;
}

export function dropActor(summary: string, actor: string): string {
  const prefix = `${actor} `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** undefined when the coordinator's summary is already readable (no whole-file key involved). */
export function rebuildSummary(e: FeedEvent): string | undefined {
  const blocked = e.summary.startsWith("Blocked: ") ? "Blocked: " : "";
  const why = reasonOf(e.summary);
  const p = e.payload ?? {};
  let head: string;
  switch (e.kind) {
    case "edit":
      if (!e.writes.some((w) => isWholeFile(w.key))) return undefined;
      head = editHead(e.writes);
      break;
    case "claim": {
      if (!e.writes.some((w) => isWholeFile(w.key))) return undefined;
      const verb = p.source === "predicted" ? "Is predicted to touch" : p.firm === true ? "Firmly claimed" : "Claimed";
      head = `${verb} ${names(e.writes.map((w) => w.key))}`;
      break;
    }
    case "release": {
      const keys = strings(p.keys);
      if (!keys.some(isWholeFile)) return undefined;
      const what = keys.length === 1 ? "its claim on" : "its claims on";
      const r = str(p.reason) ? ` (${str(p.reason)})` : "";
      return `${blocked}Released ${what} ${names(keys)}${r}`;
    }
    case "land":
      if (!e.writes.some((w) => isWholeFile(w.key))) return undefined;
      head = `Landed ${e.change ?? "change"} (${landCount(e.writes)})`;
      break;
    case "negotiate.propose": {
      const keys = strings(p.keys);
      if (!keys.some(isWholeFile)) return undefined;
      const terms = str(obj(p.terms)?.kind) ?? "terms";
      const to = str(obj(p.to)?.agent) ?? str(obj(p.to)?.change) ?? "?";
      head = `→ ${to}: proposes ${terms} on ${names(keys)}`;
      break;
    }
    default:
      return undefined;
  }
  return blocked + head + (why ? ` — ${why}` : "");
}

/** The row's one-line summary without the actor's name (the row already shows it). */
export function summaryLine(e: FeedEvent): string {
  return rebuildSummary(e) ?? capitalized(dropActor(e.summary, who(e)));
}

/** The full sentence with the actor ("hermes-default created notes.md"), for detail and copy. */
export function summaryWithActor(e: FeedEvent): string {
  let rebuilt = rebuildSummary(e);
  if (rebuilt === undefined) return e.summary;
  let prefix = "";
  if (rebuilt.startsWith("Blocked: ")) {
    prefix = "Blocked: ";
    rebuilt = rebuilt.slice(prefix.length);
  }
  const lower = rebuilt.startsWith("→") ? rebuilt : rebuilt.slice(0, 1).toLowerCase() + rebuilt.slice(1);
  return `${prefix}${who(e)} ${lower}`;
}

/** Diagnostic codes in plain words (WeftFormat.codeLabel). */
export function codeLabel(code: string): string {
  switch (code) {
    case "stale_overwrite":
      return "overwrites newer code";
    case "stale_assumption":
      return "contract changed under you";
    case "stale_read":
      return "reads changed code";
    case "claim_wait":
      return "waiting on a claim";
    case "claim_die":
      return "yielded to senior change";
    case "claim_wounded":
      return "area taken by senior change";
    case "claim_contended":
      return "contended";
    case "claim_predicted_overlap":
      return "predicted overlap";
    case "contract_changed":
      return "contract changed";
    case "trunk_advanced":
      return "trunk moved";
    case "agent_paused":
      return "agent paused";
    default:
      return code.replace(/_/g, " ");
  }
}

/** The kind badge text (WeftKindBadge.label). */
export function kindBadge(e: FeedEvent): string {
  if (e.status === "rejected") return e.mode === "check" ? "blocked" : "rejected";
  if (e.kind.startsWith("negotiate.")) return e.kind.slice("negotiate.".length);
  switch (e.kind) {
    case "control":
      return str(e.payload?.action) ?? "human";
    case "claim":
    case "release":
    case "join":
    case "leave":
      return e.kind;
    case "intent":
    case "edit":
    case "checkpoint":
    case "message":
    case "land":
    case "revert":
      return e.kind;
    default:
      return e.kind;
  }
}

/** Badge tint: red for rejected/revert, green for land, purple for negotiation, else neutral. */
export function kindTint(e: FeedEvent): "red" | "green" | "purple" | undefined {
  if (e.status === "rejected") return "red";
  if (e.kind === "land") return "green";
  if (e.kind === "revert") return "red";
  if (e.kind.startsWith("negotiate.")) return "purple";
  return undefined;
}

/** A stable per-agent palette index (FNV-1a, same as Otto's agentColor and the web UI's agentHue). */
export function agentHash(agent: string): number {
  let h = 2166136261;
  const bytes = new TextEncoder().encode(agent);
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h >>> 0;
}
export const agentColorIndex = (agent: string, n = 8): number => agentHash(agent) % n;
