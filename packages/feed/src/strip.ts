// "Editing now" and the per-repo live strip, ported from Otto (WeftStrip.swift `WeftStripModel`),
// plus the Changes feed rows (ChangesView.swift `WeftEventRow`). Pure functions of records and
// `now`, so every surface (VS Code, terminal, web, JetBrains) shows the same rows.

import { type FeedFilter, FeedLog, filterMatches, newestFirst, PER_REPO_LIMIT } from "./log";
import { baseName, isWholeFile, kindBadge, kindTint, summaryLine, symbolName } from "./summary";
import { type FeedEvent, epochMs, idOf, isRejected, kindGroup, who } from "./types";

/** Edits older than this with no landing are stale, not "editing now" (3 h). */
export const EDITING_WINDOW_MS = 3 * 3600 * 1000;
/** The most rows the strip builds. */
export const FEED_LIMIT = PER_REPO_LIMIT;
/** Rows shown before "Show older", and how many each tap adds. */
export const PAGE_SIZE = 60;

export type Editing = {
  /** Change id: one "Editing now" row per change. */
  change: string;
  repo: string;
  /** Short agent name (`hermes-default` -> `default`). */
  who: string;
  agent: string;
  task?: string;
  title?: string;
  /** Files of accepted edits since the last land, most recent first. */
  files: string[];
  lastEdit: number;
  /** Any of those edits was blocked or carries an error/warning squiggle. */
  conflicted: boolean;
  /** `repo#seq` of the newest edit. */
  latest: string;
  /** How many edit records since the change's last land. */
  count: number;
  /** Those edits, newest first (`repo#seq`). */
  trail: string[];
};

export type Tone = "edit" | "conflict" | "landed" | "install";
export type Badge = { type: "blocked" | "warned"; label: string };

export type StripItem = {
  id: string;
  repo: string;
  seq: number;
  tone: Tone;
  title: string;
  detail: string;
  date: number;
  files: string[];
  task?: string;
  cardTitle?: string;
  who: string;
  badge?: Badge;
};

/** `hermes-default` -> `default`; other harnesses keep their id. */
export const shortAgent = (a: string): string => (a.startsWith("hermes-") ? a.slice("hermes-".length) : a);

/** Weft repo for a project folder, sanitized like the adapters: `~/code/hermes-ios` -> `hermes-ios`. */
export function repoForFolder(folder: string | undefined): string | undefined {
  if (!folder) return undefined;
  let s = baseName(folder.replace(/\/+$/, "")).replace(/[^A-Za-z0-9._-]+/g, "-");
  s = s.replace(/^[._-]+/, "").slice(0, 64).replace(/-+$/, "");
  return s || undefined;
}

/** The adapter writes `intent: "<task id>: <card title>"`. */
export function titleFromIntent(intent: string | undefined, task: string | undefined): string | undefined {
  if (!intent) return undefined;
  if (task && intent.startsWith(`${task}: `)) return intent.slice(task.length + 2);
  return intent;
}

/** Probe runs (weft_conflict_probe.py) are tests, not work. */
export const isProbe = (e: FeedEvent): boolean => (e.change ?? "").includes("/weft-probe-") || (e.task ?? "").startsWith("weft-probe-");

/** Rejected, or an error/warning squiggle (info diagnostics do not count). */
export const isStripConflict = (e: FeedEvent): boolean => isRejected(e) || e.diagnostics.some((d) => d.severity === "error" || d.severity === "warning");

function install(e: FeedEvent): Record<string, unknown> | undefined {
  const x = e.payload?.x_install;
  if (e.kind !== "checkpoint" || e.status !== "accepted" || !x || typeof x !== "object" || Array.isArray(x)) return undefined;
  return x as Record<string, unknown>;
}

export function badgeOf(e: FeedEvent): Badge | undefined {
  const d = e.diagnostics.find((x) => x.severity === "error") ?? e.diagnostics.find((x) => x.severity === "warning");
  const code = d?.code.replace(/_/g, " ");
  if (isRejected(e)) return { type: "blocked", label: code ?? "blocked" };
  if (code) return { type: "warned", label: code };
  return undefined;
}

/** `src/a/B.swift`, `c.md` -> "B.swift · c.md"; past `max` names, "+N". */
export function fileNames(files: string[], max = 3): string {
  const shown = files.slice(0, max).map(baseName);
  if (files.length > max) shown.push(`+${files.length - max}`);
  return shown.join(" · ");
}

export function targetLabel(t: string): string {
  switch (t) {
    case "mac":
      return "Mac";
    case "ios":
      return "iPhone/iPad";
    case "testflight-ios":
      return "TestFlight (iOS)";
    case "testflight-mac":
      return "TestFlight (Mac)";
    default:
      return t;
  }
}

const shortSha = (e: FeedEvent): string => (typeof e.payload?.sha === "string" ? e.payload.sha.slice(0, 7) : "");

export type StripModel = { editing: Editing[]; feed: StripItem[] };

/**
 * The strip for a set of records (one repo or several; edits are grouped per change):
 * "Editing now" per change with edits since its last accepted `land` inside the 3 h window,
 * and the live feed, newest first: one row per edit, plus landings, installs and non-edit
 * conflicts. Session bookkeeping and agent checkpoints are not rows.
 */
export function stripModel(raw: FeedEvent[], now = Date.now()): StripModel {
  const events = raw.filter((e) => !isProbe(e)).sort((a, b) => (a.repo === b.repo ? a.seq - b.seq : a.repo < b.repo ? -1 : 1));
  const key = (e: FeedEvent) => `${e.repo}\u0000${e.change ?? ""}`;
  const lastLand = new Map<string, number>();
  const titles = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "land" && e.status === "accepted" && e.change) lastLand.set(key(e), e.seq);
    // Only "<task>: <title>" intents name the card (a leave's intent is "hermes process exit").
    if (e.change && e.task && e.intent?.startsWith(`${e.task}: `)) titles.set(key(e), e.intent.slice(e.task.length + 2));
    else if (e.change && e.x_task_title) titles.set(key(e), e.x_task_title);
  }
  const editing = new Map<string, Editing>();
  for (const e of events) {
    if (e.kind !== "edit" || !e.change) continue;
    if (e.seq <= (lastLand.get(key(e)) ?? 0) || now - epochMs(e.ts) >= EDITING_WINDOW_MS) continue;
    const row: Editing = editing.get(key(e)) ?? {
      change: e.change,
      repo: e.repo,
      who: shortAgent(who(e)),
      agent: who(e),
      ...(e.task ? { task: e.task } : {}),
      ...(titles.has(key(e)) ? { title: titles.get(key(e))! } : {}),
      files: [],
      lastEdit: epochMs(e.ts),
      conflicted: false,
      latest: idOf(e),
      count: 0,
      trail: [],
    };
    if (e.status === "accepted") for (const f of [...e.files].reverse()) if (!row.files.includes(f)) row.files.unshift(f);
    row.lastEdit = Math.max(row.lastEdit, epochMs(e.ts));
    row.latest = idOf(e);
    row.conflicted ||= isStripConflict(e);
    row.count += 1;
    row.trail.unshift(idOf(e));
    editing.set(key(e), row);
  }
  const feed: StripItem[] = [];
  const byTime = [...events].sort((a, b) => (epochMs(a.ts) !== epochMs(b.ts) ? epochMs(b.ts) - epochMs(a.ts) : newestFirst(a, b)));
  for (const e of byTime) {
    if (feed.length >= FEED_LIMIT) break;
    const base = { id: idOf(e), repo: e.repo, seq: e.seq, date: epochMs(e.ts), files: [] as string[], who: "" };
    if (e.kind === "edit") {
      const cardTitle = (e.change ? titles.get(key(e)) : undefined) ?? titleFromIntent(e.intent, e.task) ?? e.x_task_title;
      const badge = badgeOf(e);
      feed.push({
        ...base,
        tone: "edit",
        title: fileNames(e.files),
        detail: cardTitle ?? e.task ?? "",
        files: e.files,
        ...(e.task ? { task: e.task } : {}),
        ...(cardTitle ? { cardTitle } : {}),
        who: shortAgent(who(e)),
        ...(badge ? { badge } : {}),
      });
    } else if (install(e)) {
      const x = install(e)!;
      const build = typeof x.build === "string" || typeof x.build === "number" ? String(x.build) : "?";
      const target = typeof x.target === "string" ? x.target : "install";
      const devices = Array.isArray(x.devices) ? x.devices.filter((d): d is string => typeof d === "string") : [];
      feed.push({ ...base, tone: "install", title: `Build ${build} → ${targetLabel(target)}`, detail: devices.length ? devices.join(", ") : shortSha(e) });
    } else if (e.kind === "land" && e.status === "accepted") {
      const w = e.task ?? (e.change ? (e.change.split("/").pop() ?? "") : "change");
      const what = e.x_task_title ?? (e.change ? titles.get(key(e)) : undefined) ?? w;
      feed.push({
        ...base,
        tone: "landed",
        title: `Landed ${what}`,
        detail: [shortAgent(who(e)), shortSha(e)].filter(Boolean).join(" · "),
        ...(e.task ? { task: e.task } : {}),
      });
    } else if (isStripConflict(e) && (e.kind === "land" || e.kind === "intent")) {
      const d = e.diagnostics.find((x) => x.severity === "error") ?? e.diagnostics.find((x) => x.severity === "warning");
      const file = d?.file ?? e.files[0] ?? "";
      const code = (d?.code ?? (isRejected(e) ? "rejected" : "conflict")).replace(/_/g, " ");
      feed.push({
        ...base,
        tone: "conflict",
        title: `${code} · ${baseName(file)}`,
        detail: isRejected(e) ? `${shortAgent(who(e))} blocked` : `${shortAgent(who(e))} warned`,
        ...(e.task ? { task: e.task } : {}),
      });
    }
  }
  return { editing: [...editing.values()].sort((a, b) => b.lastEdit - a.lastEdit), feed };
}

/** "Editing now": one row per running change (edits since its last land, inside 3 h). */
export function editingNow(events: FeedEvent[] | FeedLog, now = Date.now()): Editing[] {
  return stripModel(events instanceof FeedLog ? events.combined : events, now).editing;
}

/** A change's edit rows, newest first (the "Editing now" expansion). */
export function trailOf(model: StripModel, row: Editing): StripItem[] {
  const ids = new Set(row.trail);
  return model.feed.filter((i) => ids.has(i.id));
}

// ---------------------------------------------------------------- the Changes feed

export type SymbolChip = { key: string; name: string; write: boolean };

/** One row of the Changes feed (ChangesView `WeftEventRow`). */
export type FeedRow = {
  id: string;
  repo: string;
  seq: number;
  who: string;
  actorType: string;
  harness?: string;
  task?: string;
  /** The task's title when known, else the task id. */
  taskLabel?: string;
  summary: string;
  kind: string;
  group: ReturnType<typeof kindGroup>;
  badge: string;
  tint?: "red" | "green" | "purple";
  /** Up to two symbol chips (whole-file keys excluded), plus how many more. */
  symbols: SymbolChip[];
  moreSymbols: number;
  /** When there are no symbol chips: the first file and how many more. */
  file?: string;
  moreFiles: number;
  diagnostics: FeedEvent["diagnostics"];
  rejected: boolean;
  date: number;
  record: FeedEvent;
};

export function feedRow(e: FeedEvent, log?: FeedLog): FeedRow {
  const writes = e.writes.map((w) => w.key);
  const keys = [...writes, ...e.reads.filter((r) => !writes.includes(r))].filter((k) => !isWholeFile(k));
  const title = e.task ? (log?.taskTitle(e.task) ?? e.x_task_title) : undefined;
  const tint = kindTint(e);
  return {
    id: idOf(e),
    repo: e.repo,
    seq: e.seq,
    who: who(e),
    actorType: e.actor.type,
    ...(e.actor.harness ? { harness: e.actor.harness } : {}),
    ...(e.task ? { task: e.task, taskLabel: title ?? e.task } : {}),
    summary: summaryLine(e),
    kind: e.kind,
    group: kindGroup(e.kind),
    badge: kindBadge(e),
    ...(tint ? { tint } : {}),
    symbols: keys.slice(0, 2).map((k) => ({ key: k, name: symbolName(k), write: writes.includes(k) })),
    moreSymbols: Math.max(0, keys.length - 2),
    ...(keys.length === 0 && e.files[0] ? { file: e.files[0] } : {}),
    moreFiles: keys.length === 0 ? Math.max(0, e.files.length - 1) : 0,
    diagnostics: e.diagnostics,
    rejected: isRejected(e),
    date: epochMs(e.ts),
    record: e,
  };
}

/** The Changes feed: every matching record across repos, newest first. */
export function feedRows(source: FeedLog | FeedEvent[], filter: FeedFilter = {}): FeedRow[] {
  const log = source instanceof FeedLog ? source : new FeedLog(source);
  return log.combined.filter((e) => filterMatches(filter, e)).map((e) => feedRow(e, log));
}

// ---------------------------------------------------------------- small shared rules

/** Relative times that tick: "now", "12s", "4m", "2h", "3d" (WeftFeedTime). */
export function relTime(date: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - date) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
/** How often a relative label can change: every second for the first minute, then every 15 s. */
export const tickMs = (date: number, now = Date.now()): number => (now - date < 60_000 ? 1000 : 15_000);

/** +/- line counts from a unified diff (or `payload.x_lines`). */
export function lineStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
export function lineStatsFromPayload(p: Record<string, unknown> | undefined): { added: number; removed: number } | undefined {
  const x = p?.x_lines as { added?: unknown; removed?: unknown } | undefined;
  return typeof x?.added === "number" && typeof x.removed === "number" ? { added: x.added, removed: x.removed } : undefined;
}

export type Paging = { type: "reveal"; shown: number } | { type: "fetchOlder" } | { type: "end" };
/** "Show older": reveal more held rows, then ask for older records while the cache has room. */
export function nextPage(shown: number, total: number, held: number, reachedStart: boolean, page = PAGE_SIZE, cap = PER_REPO_LIMIT): Paging {
  if (shown < total) return { type: "reveal", shown: Math.min(total, shown + page) };
  if (reachedStart || held >= cap) return { type: "end" };
  return { type: "fetchOlder" };
}
