// Per-repo summary line (`GET /v1/repos`, spec §9.2) and the feed header status, ported from
// Otto (ChangesView.swift `WeftHeaderStatus`; the repo list Otto reads in WeftStore).

import { relTime } from "./strip";
import type { FeedLog } from "./log";
import { epochMs, type RepoSummary } from "./types";

export type RepoLine = {
  repo: string;
  /** "weft-demo · 2 agents · 1 change · 1 conflict · 3m" */
  text: string;
  head: number;
  agents: number;
  changes: number;
  conflicts: number;
  lastEventAt?: number;
  /** Open conflicts > 0. */
  attention: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One summary line per repo from `/v1/repos`. Live counts come from the coordinator
 * (active agents = live sessions, open conflicts = open errors across changes, §6.5); when a
 * log is passed, `last_event_at` falls back to the newest record held.
 */
export function repoSummary(r: RepoSummary, opts: { log?: FeedLog; now?: number } = {}): RepoLine {
  const held = opts.log?.events(r.repo).at(-1);
  const last = r.last_event_at ? epochMs(r.last_event_at) : held ? epochMs(held.ts) : undefined;
  const agents = r.active_agents ?? 0;
  const changes = r.active_changes ?? 0;
  const conflicts = r.open_conflicts ?? 0;
  const parts = [r.repo, plural(agents, "agent"), plural(changes, "change")];
  if (conflicts) parts.push(plural(conflicts, "conflict"));
  if (last && opts.now !== undefined) parts.push(relTime(last, opts.now));
  return {
    repo: r.repo,
    text: parts.join(" · "),
    head: r.head_seq,
    agents,
    changes,
    conflicts,
    ...(last ? { lastEventAt: last } : {}),
    attention: conflicts > 0,
  };
}

export type HeaderStatus = { text: string; tone: "live" | "connecting" | "offline" };

/** A repo counts as idle in the header strip after this long without a record. */
export const IDLE_REPO_MS = 24 * 3600_000;

/**
 * The repos the header strip lists: every repo when there is only one, else the ones with
 * live agents, active changes, open conflicts or a record in the last `idleMs`. A token that
 * sees 100 repos would otherwise fill the panel with "0 agents · 0 changes" lines.
 */
export function stripRepos(list: RepoSummary[], opts: { log?: FeedLog; now: number; idleMs?: number }): { shown: RepoLine[]; idle: number } {
  const lines = list.map((r) => repoSummary(r, opts));
  if (lines.length <= 1) return { shown: lines, idle: 0 };
  const since = opts.now - (opts.idleMs ?? IDLE_REPO_MS);
  const shown = lines.filter((l) => l.agents || l.changes || l.conflicts || (l.lastEventAt !== undefined && l.lastEventAt >= since));
  return { shown, idle: lines.length - shown.length };
}

/**
 * The feed header: "Live · N repos" while the last successful read is recent, where N counts
 * repos with activity in the last 7 days; "Connecting" before the first success; "Offline"
 * (with "saved changes" when records are held) otherwise.
 */
export function headerStatus(s: { configured: boolean; live: boolean; loading: boolean; everSucceeded: boolean; active: string[]; hasSaved: boolean }): HeaderStatus {
  if (!s.configured) return { text: "Not connected", tone: "offline" };
  const scope = s.active.length === 1 ? s.active[0] : s.active.length ? `${s.active.length} repos` : undefined;
  if (s.live) return { text: scope ? `Live · ${scope}` : "Live", tone: "live" };
  if (s.loading && !s.everSucceeded) return { text: scope ? `Connecting · ${scope}` : "Connecting", tone: "connecting" };
  return { text: s.hasSaved ? "Offline · saved changes" : "Offline", tone: "offline" };
}
