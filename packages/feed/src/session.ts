// A live feed: an ObserverClient feeding a FeedLog, with the state a UI needs (status, fresh
// rows, detail loading, actions). The UI-independent half of Otto's WeftStore.swift; the DOM
// view, a VS Code webview or a terminal subscribe to it.

import { type ActionInput, type ActionOption, actionBody } from "./actions";
import { type ObserverClient, type StreamHandle, type StreamStatus, WeftHttpError } from "./client";
import { FeedLog } from "./log";
import { type HeaderStatus, headerStatus } from "./repo";
import type { FeedEvent, RepoSummary } from "./types";
import { idOf } from "./types";

/** "Live" while the last successful read is younger than this (Otto's liveWindow). */
export const LIVE_WINDOW_MS = 15_000;
/** Rows highlighted as new for this long. */
export const FRESH_MS = 6_000;

export type SessionOptions = {
  repos?: string[];
  /** Prefer per-repo sockets (one per repo) over the combined feed. Default: combined feed. */
  perRepoStreams?: boolean;
  limit?: number;
  now?: () => number;
};

export class FeedSession {
  readonly log: FeedLog;
  repoList: RepoSummary[] = [];
  status: StreamStatus = "connecting";
  lastOk?: number;
  error?: string;
  /** `repo#seq` of rows that arrived live, with arrival time. */
  readonly fresh = new Map<string, number>();
  private handles: StreamHandle[] = [];
  private listeners = new Set<(added: FeedEvent[]) => void>();
  private ever = false;
  private readonly now: () => number;

  constructor(
    readonly client: ObserverClient,
    private readonly opts: SessionOptions = {},
    log?: FeedLog,
  ) {
    this.log = log ?? new FeedLog();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Subscribe to changes (new records, detail loads, status). Returns an unsubscribe. */
  on(fn: (added: FeedEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(added: FeedEvent[] = []): void {
    for (const fn of this.listeners) fn(added);
  }

  private ingest(events: FeedEvent[], live: boolean): void {
    const added = this.log.ingest(events);
    if (live) for (const e of added) this.fresh.set(idOf(e), this.now());
    this.lastOk = this.now();
    this.ever = true;
    this.emit(added);
  }

  private onStatus = (s: StreamStatus, detail?: string): void => {
    this.status = s;
    if (s === "live" || s === "polling") {
      this.lastOk = this.now();
      this.ever = true;
      this.error = undefined;
    } else if (s === "offline" || s === "error") this.error = detail;
    this.emit();
  };

  async start(): Promise<void> {
    this.stop();
    try {
      this.repoList = await this.client.repos();
      this.lastOk = this.now();
      this.ever = true;
    } catch (e) {
      this.error = e instanceof WeftHttpError ? e.message : String(e);
      this.status = e instanceof WeftHttpError && e.status === 401 ? "error" : "offline";
      this.emit();
      if (this.status === "error") return;
    }
    const repos = this.opts.repos ?? this.repoList.map((r) => r.repo);
    if (this.opts.perRepoStreams) {
      // Open with the newest page per repo, then stream from its head.
      for (const repo of repos) {
        let after = this.log.resumePoint(repo);
        if (!after) {
          try {
            const page = await this.client.events(repo, { tail: true, limit: this.opts.limit ?? 200 });
            this.ingest(page.events, false);
            after = page.head_seq;
          } catch {
            /* the stream replays instead */
          }
        }
        this.handles.push(this.client.streamRepo(repo, { after, onEvent: (e) => this.ingest([e], true), onStatus: this.onStatus }));
      }
    } else {
      let first = true;
      this.handles.push(
        this.client.streamFeed({
          ...(this.opts.repos ? { repos: this.opts.repos } : {}),
          ...(this.opts.limit ? { limit: this.opts.limit } : {}),
          onEvents: (events) => {
            this.ingest(events, !first);
            first = false;
          },
          onStatus: this.onStatus,
        }),
      );
    }
    this.emit();
  }

  stop(): void {
    for (const h of this.handles) h.close();
    this.handles = [];
  }

  wake(): void {
    for (const h of this.handles) h.wake();
  }

  /** Re-reads `/v1/repos` (live counts for the summary lines). */
  async refreshRepos(): Promise<void> {
    this.repoList = await this.client.repos();
    this.emit();
  }

  isLive(now = this.now()): boolean {
    if (this.status === "live") return true; // an authenticated socket
    return this.status === "polling" && this.lastOk !== undefined && now - this.lastOk < LIVE_WINDOW_MS;
  }

  header(now = this.now()): HeaderStatus {
    return headerStatus({
      configured: true,
      live: this.isLive(now),
      loading: this.status === "connecting" || this.status === "paging",
      everSucceeded: this.ever,
      active: this.log.activeRepos(7, now),
      hasSaved: this.log.size > 0,
    });
  }

  isFresh(id: string, now = this.now()): boolean {
    const t = this.fresh.get(id);
    return t !== undefined && now - t < FRESH_MS;
  }

  /** Loads the full record (with `diff`) into the log. */
  async loadDetail(repo: string, seq: number): Promise<FeedEvent | undefined> {
    const held = this.log.event(repo, seq);
    if (held?.diff !== undefined) return held;
    try {
      const full = await this.client.event(repo, seq);
      this.log.ingest([full]);
      this.emit();
      return this.log.event(repo, seq);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.emit();
      return held;
    }
  }

  /** Sends a human action and puts its record in the log at once (the stream dedupes it). */
  async act(o: ActionOption, input: ActionInput = {}): Promise<FeedEvent> {
    const res = await this.client.act(o.repo, actionBody(o, input));
    this.ingest([res.record], true);
    return res.record;
  }
}
