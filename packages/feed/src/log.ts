// The client's copy of Weft's change log, ported from Otto (WeftLog.swift): every repo's records
// keyed by seq, the per-repo high-water mark used to resume (spec §9.4: reconnect with `after=`
// the highest seq processed, de-duplicate by seq), and the derived views the feed needs
// (combined order, filters, negotiation threads, candidates, paused agents, reverts).
//
// Plain data + pure methods: no timers, no sockets, so resume and de-dup are unit-testable.

import {
  type FeedEvent,
  type KindGroup,
  epochMs,
  idOf,
  isConflict,
  isSessionBookkeeping,
  kindGroup,
  normalize,
  replyTo,
} from "./types";

/** Records held per repo (Otto's offline cache size). */
export const PER_REPO_LIMIT = 500;

/** Newest first by (ts, repo, seq), the reverse of `/v1/feed`'s total order. */
export function newestFirst(a: FeedEvent, b: FeedEvent): number {
  const ta = epochMs(a.ts);
  const tb = epochMs(b.ts);
  if (ta !== tb) return tb - ta;
  if (a.repo !== b.repo) return a.repo < b.repo ? 1 : -1;
  return b.seq - a.seq;
}

export type CatchUp = { mode: "tail" } | { mode: "after"; after: number };

/**
 * How to catch a repo up: page `after=` the high-water mark, or, for a repo never seen (or so
 * far behind that the cache would drop most of it), take the newest page (`tail=1`).
 */
export function catchUpPlan(highWater: number, head: number, limit = PER_REPO_LIMIT): CatchUp {
  if (highWater === 0 || head - highWater > limit) return { mode: "tail" };
  return { mode: "after", after: highWater };
}

export type Candidate = {
  change: string;
  agent: string;
  harness?: string;
  /** The candidate's newest agent record. */
  latest: number;
  landedSeq?: number;
  approved: boolean;
  reverted: boolean;
  evidence?: FeedEvent["x_evidence"];
};

/**
 * Feed filters (spec §9.3). By default session bookkeeping (join/leave, claim/release,
 * heartbeats) is hidden; picking one of those kinds explicitly shows it. Bookkeeping that
 * carries a diagnostic or was blocked is never hidden.
 */
export type FeedFilter = {
  repos?: string[];
  tasks?: string[];
  agents?: string[];
  kinds?: KindGroup[];
  onlyConflicts?: boolean;
  showSessionEvents?: boolean;
};

export function filterIsEmpty(f: FeedFilter): boolean {
  return !f.repos?.length && !f.tasks?.length && !f.agents?.length && !f.kinds?.length && !f.onlyConflicts && !f.showSessionEvents;
}

export function filterMatches(f: FeedFilter, e: FeedEvent): boolean {
  const g = kindGroup(e.kind);
  if (!f.showSessionEvents && isSessionBookkeeping(e) && !f.kinds?.includes(g)) return false;
  if (f.repos?.length && !f.repos.includes(e.repo)) return false;
  if (f.tasks?.length && !f.tasks.includes(e.task ?? "")) return false;
  if (f.agents?.length && !f.agents.includes(e.agent ?? e.actor.id)) return false;
  if (f.kinds?.length && !f.kinds.includes(g)) return false;
  if (f.onlyConflicts && !isConflict(e)) return false;
  return true;
}

export class FeedLog {
  readonly limit: number;
  private byRepo = new Map<string, Map<number, FeedEvent>>();
  private hw = new Map<string, number>();
  private combinedCache: FeedEvent[] | undefined;

  constructor(events: unknown[] = [], opts: { limit?: number } = {}) {
    this.limit = opts.limit ?? PER_REPO_LIMIT;
    this.ingest(events);
  }

  /**
   * Adds records, ignoring ones already held (same repo + seq): replay and live overlap by
   * design (spec §9.4). A richer copy (detail view with `diff`) replaces a list-view copy
   * without counting as new. Returns only records that were new.
   */
  ingest(raw: unknown[]): FeedEvent[] {
    const added: FeedEvent[] = [];
    const touched = new Set<string>();
    for (const r of raw) {
      const e = normalize(r);
      let rows = this.byRepo.get(e.repo);
      if (!rows) this.byRepo.set(e.repo, (rows = new Map()));
      const old = rows.get(e.seq);
      if (old) {
        if (old.diff === undefined && e.diff !== undefined) {
          rows.set(e.seq, e);
          touched.add(e.repo);
        }
        continue;
      }
      rows.set(e.seq, e);
      this.hw.set(e.repo, Math.max(this.hw.get(e.repo) ?? 0, e.seq));
      added.push(e);
      touched.add(e.repo);
    }
    for (const repo of touched) this.trim(repo);
    if (touched.size) this.combinedCache = undefined;
    return added;
  }

  private trim(repo: string): void {
    const rows = this.byRepo.get(repo);
    if (!rows || rows.size <= this.limit) return;
    const drop = [...rows.keys()].sort((a, b) => a - b).slice(0, rows.size - this.limit);
    for (const s of drop) rows.delete(s);
  }

  /** Where to resume a repo's stream / paging (`after=`). Never decreases, even after trimming. */
  resumePoint(repo: string): number {
    return this.hw.get(repo) ?? 0;
  }

  /** Restores a repo's high-water mark (e.g. from a saved cursor). */
  noteHighWater(repo: string, seq: number): void {
    this.hw.set(repo, Math.max(this.hw.get(repo) ?? 0, seq));
  }

  /** Per-repo high-water marks: the `/v1/feed` cursor vector (encode with `encodeCursor`). */
  highWater(): Record<string, number> {
    return Object.fromEntries([...this.hw.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  /** Oldest seq held for a repo (for `before=` scroll-back). */
  oldestSeq(repo: string): number | undefined {
    const rows = this.byRepo.get(repo);
    return rows?.size ? Math.min(...rows.keys()) : undefined;
  }

  /** Drops a repo's rows (before re-reading its newest page after a long absence). */
  reset(repo: string): void {
    this.byRepo.delete(repo);
    this.hw.delete(repo);
    this.combinedCache = undefined;
  }

  event(repo: string, seq: number): FeedEvent | undefined {
    return this.byRepo.get(repo)?.get(seq);
  }

  /** One repo's records, ascending by seq. */
  events(repo: string): FeedEvent[] {
    return [...(this.byRepo.get(repo)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
  }

  get repos(): string[] {
    return [...this.byRepo.keys()].sort();
  }

  /** Combined change log across repos, newest first (ordered like `/v1/feed`, reversed). */
  get combined(): FeedEvent[] {
    if (!this.combinedCache) this.combinedCache = [...this.byRepo.values()].flatMap((m) => [...m.values()]).sort(newestFirst);
    return this.combinedCache;
  }

  get size(): number {
    let n = 0;
    for (const m of this.byRepo.values()) n += m.size;
    return n;
  }

  filtered(f: FeedFilter = {}): FeedEvent[] {
    return this.combined.filter((e) => filterMatches(f, e));
  }

  /** Agents and tasks seen (filter chips). */
  get agents(): string[] {
    return [...new Set(this.combined.flatMap((e) => (e.agent ? [e.agent] : [])))].sort();
  }
  get tasks(): string[] {
    return [...new Set(this.combined.flatMap((e) => (e.task ? [e.task] : [])))].sort();
  }

  /**
   * A task's title: the newest `x_task_title` naming it, else an adapter intent
   * `"<task>: <title>"` (the rule Otto's strip uses for card titles).
   */
  taskTitle(task: string): string | undefined {
    for (const e of this.combined) if (e.task === task && e.x_task_title) return e.x_task_title;
    for (const e of this.combined) if (e.task === task && e.intent?.startsWith(`${task}: `)) return e.intent.slice(task.length + 2).split("\n")[0];
    return undefined;
  }

  /** Newest record time per repo (ms), most recently active first. */
  get reposByActivity(): string[] {
    const last = new Map<string, number>();
    for (const e of this.combined) if ((last.get(e.repo) ?? -Infinity) < epochMs(e.ts)) last.set(e.repo, epochMs(e.ts));
    return [...last.entries()].sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1)).map(([r]) => r);
  }

  /** Repos with a record in the last `days` days, most recent first. */
  activeRepos(days = 7, now = Date.now()): string[] {
    const since = now - days * 86_400_000;
    return this.reposByActivity.filter((r) => this.combined.some((e) => e.repo === r && epochMs(e.ts) >= since));
  }

  /**
   * The negotiation an event belongs to: the root `negotiate.propose` and every
   * counter/accept/reject whose `reply_to` chain reaches it, oldest first.
   */
  thread(e: FeedEvent): FeedEvent[] {
    if (kindGroup(e.kind) !== "negotiate") return [];
    const rows = this.byRepo.get(e.repo) ?? new Map<number, FeedEvent>();
    let root = e;
    for (let guard = 0; guard < 100; guard++) {
      const parent = replyTo(root);
      const p = parent === undefined ? undefined : rows.get(parent);
      if (!p) break;
      root = p;
    }
    const members = new Set([root.seq]);
    const out = [root];
    for (const r of this.events(e.repo)) {
      if (r.seq <= root.seq || kindGroup(r.kind) !== "negotiate") continue;
      const to = replyTo(r);
      if (to !== undefined && members.has(to)) {
        members.add(r.seq);
        out.push(r);
      }
    }
    return out;
  }

  /** Competing changes for one task (design §3: a task has N candidates). */
  candidates(task: string, repo: string): Candidate[] {
    const rows = this.events(repo);
    const byChange = new Map<string, Candidate>();
    for (const r of rows) {
      if (r.task !== task || !r.change) continue;
      const c: Candidate = byChange.get(r.change) ?? {
        change: r.change,
        agent: r.agent ?? r.actor.id,
        ...(r.actor.harness ? { harness: r.actor.harness } : {}),
        latest: r.seq,
        approved: false,
        reverted: false,
      };
      if (r.actor.type === "agent") {
        c.latest = r.seq;
        if (c.harness === undefined && r.actor.harness) c.harness = r.actor.harness;
      }
      if (r.kind === "land") c.landedSeq = r.seq;
      if (r.x_evidence) c.evidence = r.x_evidence;
      byChange.set(r.change, c);
    }
    // Approvals and reverts point at the change / land without always naming the task.
    for (const r of rows) {
      const p = r.payload ?? {};
      const target = (p.target ?? {}) as { change?: unknown };
      if (r.kind === "control" && p.action === "approve" && typeof target.change === "string") {
        const c = byChange.get(target.change);
        if (c) c.approved = true;
      }
      if (r.kind === "revert" && typeof p.reverts_seq === "number") {
        for (const c of byChange.values()) if (c.landedSeq === p.reverts_seq) c.reverted = true;
      }
    }
    return [...byChange.values()].sort((a, b) => (a.change < b.change ? -1 : a.change > b.change ? 1 : 0));
  }

  /** Whether a human paused this agent in this repo (the last `control` pause/resume wins). */
  isPaused(agent: string, repo: string): boolean {
    const rows = this.events(repo);
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.kind !== "control") continue;
      const target = (r.payload?.target ?? {}) as { agent?: unknown };
      if (target.agent !== agent) continue;
      if (r.payload?.action === "pause") return true;
      if (r.payload?.action === "resume") return false;
    }
    return false;
  }

  /** The revert that undid a landing, if any (by `reverts_seq`, or `reverts_op_id`). */
  revertOf(land: FeedEvent): FeedEvent | undefined {
    const op = land.payload?.op_id;
    return this.events(land.repo).find(
      (r) => r.kind === "revert" && (r.payload?.reverts_seq === land.seq || (op !== undefined && r.payload?.reverts_op_id === op)),
    );
  }
}

export { idOf };
