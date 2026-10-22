// Wire types the feed reads (WCP v0.1 §4.2, §9), re-exported from @weft/protocol, plus the
// vendor extensions Otto shows (`x_task_title`, `x_evidence`, spec §10 `x_` prefix).
// Receivers must ignore unknown fields and show unknown kinds generically, so every
// reducer here treats optional fields leniently, like Otto's decoder (WeftModels.swift).

import type { Diagnostic, EventRecord, RepoSummary } from "@weft/protocol";

export type {
  Diagnostic,
  EventRecord,
  EventPage,
  FeedPage,
  HumanAction,
  ActionResult,
  RepoSummary,
  RepoList,
  StreamFrame,
} from "@weft/protocol";

export type Evidence = {
  preview_url?: string;
  tests?: { passed?: number; failed?: number; total?: number };
  screenshots?: string[];
  review?: { verdict?: string; summary?: string };
  cost_usd?: number;
};

/**
 * An EventRecord as the feed holds it. `kind` and `status` are widened to `string` because a
 * newer coordinator may send kinds this build does not know (they render as "other").
 */
export type FeedEvent = Omit<EventRecord, "kind" | "status" | "diagnostics" | "files" | "reads" | "writes"> & {
  kind: string;
  status: string;
  files: string[];
  reads: string[];
  writes: { key: string; kind: string }[];
  diagnostics: Diagnostic[];
  x_task_title?: string;
  x_evidence?: Evidence;
};

/** `repo#seq`: a record's identity across repos. */
export type EventId = { repo: string; seq: number };
export const idOf = (e: { repo: string; seq: number }): string => `${e.repo}#${e.seq}`;
export function parseId(s: string): EventId | undefined {
  const i = s.lastIndexOf("#");
  if (i <= 0) return undefined;
  const seq = Number(s.slice(i + 1));
  return Number.isInteger(seq) && seq > 0 ? { repo: s.slice(0, i), seq } : undefined;
}

/** Parse milliseconds since epoch once per record (Otto parses `ts` once at decode). */
export function epochMs(ts: string | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Normalize a record from any source (list view, detail, stream frame, recorded log):
 * defaults for absent arrays/status/summary, and the vendor extensions lifted out of
 * `payload` when a gateway drops unknown top-level fields (WeftModels.swift `VendorKeys`).
 */
export function normalize(raw: unknown): FeedEvent {
  const r = raw as Record<string, unknown> & { actor?: { type?: string; id?: string; harness?: string } };
  const payload = (r.payload && typeof r.payload === "object" ? r.payload : undefined) as Record<string, unknown> | undefined;
  const e = {
    ...(r as object),
    status: typeof r.status === "string" ? r.status : "accepted",
    files: Array.isArray(r.files) ? (r.files as string[]) : [],
    reads: Array.isArray(r.reads) ? (r.reads as string[]) : [],
    writes: Array.isArray(r.writes) ? (r.writes as FeedEvent["writes"]) : [],
    diagnostics: Array.isArray(r.diagnostics) ? (r.diagnostics as Diagnostic[]) : [],
    summary: typeof r.summary === "string" ? r.summary : String(r.kind ?? ""),
    actor: { type: r.actor?.type ?? "agent", id: r.actor?.id ?? String(r.agent ?? "?"), ...(r.actor?.harness ? { harness: r.actor.harness } : {}) },
  } as unknown as FeedEvent;
  if (e.x_task_title === undefined && typeof payload?.x_task_title === "string") e.x_task_title = payload.x_task_title;
  if (e.x_evidence === undefined && payload?.x_evidence && typeof payload.x_evidence === "object") e.x_evidence = payload.x_evidence as Evidence;
  return e;
}

/** Kind groups: the feed's badges and filter chips (WeftKindGroup). Unknown kinds are "other". */
export type KindGroup =
  | "intent"
  | "edit"
  | "checkpoint"
  | "claim"
  | "negotiate"
  | "message"
  | "control"
  | "land"
  | "revert"
  | "presence"
  | "other";

export function kindGroup(kind: string): KindGroup {
  switch (kind) {
    case "intent":
    case "edit":
    case "checkpoint":
    case "message":
    case "control":
    case "land":
    case "revert":
      return kind;
    case "claim":
    case "release":
      return "claim";
    case "join":
    case "leave":
      return "presence";
    default:
      return kind.startsWith("negotiate.") ? "negotiate" : "other";
  }
}

export const KIND_GROUP_LABEL: Record<KindGroup, string> = {
  intent: "intent",
  edit: "edit",
  checkpoint: "checkpoint",
  claim: "claim",
  negotiate: "negotiate",
  message: "message",
  control: "human",
  land: "land",
  revert: "revert",
  presence: "join/leave",
  other: "other",
};

/** Whose change this is: the agent for agent work and for system records about an agent's change. */
export function who(e: FeedEvent): string {
  return e.actor.type === "human" ? e.actor.id : (e.agent ?? e.actor.id);
}

export const isRejected = (e: FeedEvent): boolean => e.status === "rejected";

/** "Only conflicts": rejected submissions plus anything carrying a squiggle (spec §9.3). */
export const isConflict = (e: FeedEvent): boolean => isRejected(e) || e.diagnostics.length > 0;

/** Session bookkeeping (join/leave, claim/release, heartbeats) rather than work. */
export function isSessionBookkeeping(e: FeedEvent): boolean {
  if (e.diagnostics.length || isRejected(e)) return false;
  const g = kindGroup(e.kind);
  if (g === "presence" || g === "claim") return true;
  return e.kind === "heartbeat" || e.kind === "ping" || e.kind.startsWith("session.");
}

export const mayHaveDiff = (e: FeedEvent): boolean => e.diff !== undefined || e.has_diff === true;

/** `payload.reply_to` (negotiation threads). */
export function replyTo(e: FeedEvent): number | undefined {
  const v = e.payload?.reply_to;
  return typeof v === "number" ? v : undefined;
}

/** Writes then reads, de-duplicated, in order. */
export function symbolsOf(e: FeedEvent): string[] {
  const out: string[] = [];
  for (const k of [...e.writes.map((w) => w.key), ...e.reads]) if (!out.includes(k)) out.push(k);
  return out;
}

export type { RepoSummary as Repo };
