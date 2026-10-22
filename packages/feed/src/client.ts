// HTTP + WebSocket client for the WCP observer and human API (spec §9), ported from Otto
// (WeftClient.swift, WeftStore.swift polling). Runs anywhere with `fetch` and `WebSocket`
// (browsers, VS Code webviews, JCEF, Node >= 22); both can be injected for tests.
//
// Auth: `Authorization: Bearer` on HTTP. Sockets authenticate with a first `{"type":"auth"}`
// frame because browsers cannot set upgrade headers; the token is never put in a URL.

import { encodeCursor, decodeCursor } from "@weft/protocol";
import type { ActionResult, EventPage, FeedEvent, FeedPage, HumanAction, RepoSummary } from "./types";
import { normalize } from "./types";

export const WCP_VERSION = "0.1";

export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};
export type WebSocketCtor = new (url: string) => WebSocketLike;
type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type ClientOptions = {
  /** Gateway origin, e.g. `http://localhost:8787` (a trailing `/v1` or `/` is dropped). */
  baseUrl: string;
  /** Token with `observe` scope (`human` too for actions). */
  token: string;
  fetch?: FetchLike;
  WebSocket?: WebSocketCtor;
};

/** A gateway error (`{"error": {code, message}}`) or a bare HTTP failure. */
export class WeftHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WeftHttpError";
  }
  /** 401: the token is wrong. 403 on an action: the token can only read. */
  get readOnly(): boolean {
    return this.status === 403;
  }
}

/** Otto's poll policy: 4 s while busy, easing to 10 s when quiet; failures back off 2, 4, 8… 30 s. */
export function pollInterval(idlePolls: number, failures: number): number {
  if (failures > 0) return Math.min(30, 2 ** Math.min(failures, 5)) * 1000;
  if (idlePolls < 15) return 4000;
  if (idlePolls < 45) return 7000;
  return 10_000;
}
/** Socket reconnect backoff: 1, 2, 4… 30 s. */
export const reconnectDelay = (failures: number): number => Math.min(30, 2 ** Math.max(0, failures - 1)) * 1000;

/** Normalizes a typed-in address: scheme defaults to https, trailing `/` and `/v1` dropped. */
export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim();
  if (!s.includes("://")) s = `https://${s}`;
  s = s.replace(/\/+$/, "");
  if (s.endsWith("/v1")) s = s.slice(0, -3);
  return s.replace(/\/+$/, "");
}

export type EventsQuery = {
  after?: number;
  before?: number;
  tail?: boolean;
  limit?: number;
  include?: "diff";
  kind?: string;
  agent?: string;
  task?: string;
  change?: string;
  status?: string;
};

export type StreamStatus = "connecting" | "live" | "paging" | "polling" | "offline" | "closed" | "error";

export type RepoStreamOptions = {
  /** Resume point: the highest seq already processed (records with seq > after are sent). */
  after?: number;
  onEvent: (e: FeedEvent) => void;
  onReplayDone?: (head: number) => void;
  onStatus?: (s: StreamStatus, detail?: string) => void;
  /** Page size when the coordinator refuses a long replay with 4413. */
  pageLimit?: number;
};

export type FeedStreamOptions = {
  /** Opaque cursor from a previous page; omit to start from the newest `limit` records. */
  cursor?: string;
  limit?: number;
  repos?: string[];
  onEvents: (events: FeedEvent[], cursor: string) => void;
  onStatus?: (s: StreamStatus, detail?: string) => void;
  /** Try `GET /v1/feed/stream` (spec §9.5, SHOULD) before polling `/v1/feed`. Default true. */
  socket?: boolean;
};

export type StreamHandle = {
  close(): void;
  /** Reconnect / poll now (e.g. when a phone returns to the foreground). */
  wake(): void;
  readonly status: StreamStatus;
};

const FATAL_CLOSE = new Set([4401, 4403, 4404]);

export class ObserverClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly WS: WebSocketCtor | undefined;

  constructor(opts: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.token = opts.token;
    const f = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new Error("ObserverClient needs fetch");
    this.fetchImpl = f.bind(globalThis) as FetchLike;
    this.WS = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  }

  // ------------------------------------------------------------ observer (spec §9.2–9.5)

  async repos(): Promise<RepoSummary[]> {
    return (await this.get<{ repos: RepoSummary[] }>("/v1/repos")).repos;
  }

  /** `after` mode (ascending, resume), `tail` (newest `limit`), or `before` (scroll-back). */
  async events(repo: string, q: EventsQuery = {}): Promise<Omit<EventPage, "events"> & { events: FeedEvent[] }> {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== false) query[k] = v === true ? "1" : String(v);
    const page = await this.get<EventPage>(`/v1/repos/${enc(repo)}/events`, query);
    return { ...page, events: page.events.map(normalize) };
  }

  /** The complete record: diff, payload, transcript pointer. */
  async event(repo: string, seq: number): Promise<FeedEvent> {
    return normalize(await this.get<unknown>(`/v1/repos/${enc(repo)}/events/${seq}`));
  }

  /** The combined change log (spec §9.5). `tail` = newest `limit` with a cursor at every head. */
  async feed(q: { cursor?: string; tail?: boolean; limit?: number; repos?: string[] } = {}): Promise<Omit<FeedPage, "events"> & { events: FeedEvent[] }> {
    const query: Record<string, string> = {};
    if (q.limit) query.limit = String(q.limit);
    if (q.tail) query.tail = "1";
    else if (q.cursor) query.after = q.cursor;
    if (q.repos?.length) query.repos = q.repos.join(",");
    const page = await this.get<FeedPage>("/v1/feed", query);
    return { ...page, events: page.events.map(normalize) };
  }

  // ------------------------------------------------------------ human (spec §9.6)

  /** Appends a human action; the result's record is the log entry it made. */
  async act(repo: string, action: HumanAction): Promise<Omit<ActionResult, "record"> & { record: FeedEvent }> {
    const text = await this.request("POST", `/v1/repos/${enc(repo)}/actions`, {}, JSON.stringify(action), true);
    const r = JSON.parse(text) as ActionResult;
    return { ...r, record: normalize(r.record) };
  }

  // ------------------------------------------------------------ streams (spec §9.4–9.5)

  wsUrl(path: string, query: Record<string, string>): string {
    const u = new URL(this.baseUrl + path);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  /**
   * One repo's stream with resume: replays records after `after`, then live. On a drop it
   * reconnects with `after=` the highest seq processed and de-duplicates by seq (replay and
   * live overlap by design). When the coordinator caps the replay (close 4413), it pages
   * `GET /events?after=` until caught up and reconnects.
   */
  streamRepo(repo: string, o: RepoStreamOptions): StreamHandle {
    let highest = o.after ?? 0;
    let ws: WebSocketLike | undefined;
    let closed = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: StreamStatus = "connecting";
    const set = (s: StreamStatus, d?: string) => {
      status = s;
      o.onStatus?.(s, d);
    };
    const deliver = (raw: unknown) => {
      const e = normalize(raw);
      if (e.seq <= highest) return;
      highest = e.seq;
      o.onEvent(e);
    };
    const schedule = (ms: number) => {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(connect, ms);
    };
    const catchUp = async () => {
      set("paging");
      try {
        for (let i = 0; i < 1000 && !closed; i++) {
          const before = highest;
          const page = await this.events(repo, { after: highest, limit: o.pageLimit ?? 500 });
          for (const e of page.events) deliver(e);
          // `next_after` is the highest seq examined, so filtered paging never stalls.
          if (page.next_after > highest) highest = page.next_after;
          if (!page.has_more || highest === before) break;
        }
        failures = 0;
        schedule(0);
      } catch (err) {
        failures++;
        set("offline", String(err));
        schedule(reconnectDelay(failures));
      }
    };
    const connect = () => {
      if (closed) return;
      if (!this.WS) {
        set("error", "no WebSocket implementation");
        return;
      }
      set("connecting");
      let authed = false;
      const sock = new this.WS(this.wsUrl(`/v1/repos/${enc(repo)}/stream`, { after: String(highest) }));
      ws = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: "auth", token: this.token }));
      sock.onmessage = (m) => {
        const f = parseFrame(m.data);
        if (!f) return;
        if (f.type === "auth.ok") {
          authed = true;
          failures = 0;
          set("live");
        } else if (f.type === "event" && f.event) deliver(f.event);
        else if (f.type === "replay.done") o.onReplayDone?.(Number(f.head_seq ?? highest));
      };
      sock.onerror = () => {};
      sock.onclose = (ev) => {
        if (ws !== sock || closed) return;
        ws = undefined;
        if (ev.code === 4413) return void catchUp();
        if (FATAL_CLOSE.has(ev.code)) return set("error", ev.reason || `closed ${ev.code}`);
        if (!authed) failures++;
        else failures = Math.max(failures, 1);
        set("offline", ev.reason || `closed ${ev.code}`);
        schedule(reconnectDelay(failures));
      };
    };
    connect();
    return {
      close: () => {
        closed = true;
        clearTimeout(timer);
        try {
          ws?.close(1000, "client closed");
        } catch {
          /* already closed */
        }
        set("closed");
      },
      wake: () => {
        if (closed || (ws && status === "live")) return;
        failures = 0;
        schedule(0);
      },
      get status() {
        return status;
      },
    };
  }

  /**
   * The combined feed, live. Tries the combined stream (`/v1/feed/stream`, spec §9.5 SHOULD)
   * and, if the gateway does not offer it, polls `GET /v1/feed` with the opaque cursor on
   * Otto's schedule. Records are de-duplicated by (repo, seq) either way.
   */
  streamFeed(o: FeedStreamOptions): StreamHandle {
    const hw: Record<string, number> = o.cursor ? decodeCursor(o.cursor) : {};
    let cursor = o.cursor;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle = 0;
    let failures = 0;
    let status: StreamStatus = "connecting";
    let ws: WebSocketLike | undefined;
    const set = (s: StreamStatus, d?: string) => {
      status = s;
      o.onStatus?.(s, d);
    };
    const fresh = (events: FeedEvent[]) =>
      events.filter((e) => {
        if (e.seq <= (hw[e.repo] ?? 0)) return false;
        hw[e.repo] = e.seq;
        return true;
      });
    const poll = async (): Promise<void> => {
      if (closed) return;
      try {
        const page = await this.feed(cursor ? { cursor, limit: o.limit ?? 500, ...(o.repos ? { repos: o.repos } : {}) } : { tail: true, limit: o.limit ?? 300, ...(o.repos ? { repos: o.repos } : {}) });
        if (closed) return;
        // A tail page's cursor sits at every repo's head; adopt it as the high-water mark.
        if (!cursor) Object.assign(hw, decodeCursor(page.cursor));
        const added = cursor ? fresh(page.events) : page.events;
        cursor = page.cursor;
        failures = 0;
        set("polling");
        if (added.length) o.onEvents(added, cursor);
        idle = added.length ? 0 : idle + 1;
        timer = setTimeout(poll, page.has_more ? 0 : pollInterval(idle, 0));
      } catch (err) {
        if (closed) return;
        failures++;
        set(err instanceof WeftHttpError && err.status === 401 ? "error" : "offline", String(err));
        if (err instanceof WeftHttpError && err.status === 401) return;
        timer = setTimeout(poll, pollInterval(idle, failures));
      }
    };
    const trySocket = () => {
      if (!this.WS || o.socket === false) return void poll();
      let authed = false;
      let sock: WebSocketLike;
      try {
        sock = new this.WS(this.wsUrl("/v1/feed/stream", cursor ? { after: cursor } : {}));
      } catch {
        return void poll();
      }
      ws = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: "auth", token: this.token }));
      sock.onerror = () => {};
      sock.onmessage = (m) => {
        const f = parseFrame(m.data);
        if (!f) return;
        if (f.type === "auth.ok") {
          authed = true;
          set("live");
        } else if (f.type === "event" && f.event) {
          const added = fresh([normalize(f.event)]);
          if (added.length) {
            cursor = encodeCursor(hw);
            o.onEvents(added, cursor);
          }
        }
      };
      sock.onclose = () => {
        if (ws !== sock || closed) return;
        ws = undefined;
        // Never authenticated: the gateway has no combined stream. Poll instead, for good.
        if (!authed) return void poll();
        set("offline");
        timer = setTimeout(trySocket, reconnectDelay(++failures));
      };
    };
    // Before a cursor exists, read the newest page over HTTP so the feed opens with history.
    if (cursor) trySocket();
    else
      void (async () => {
        await poll();
        if (closed || o.socket === false || !this.WS) return;
        // Keep polling unless the combined stream turns out to exist.
        clearTimeout(timer);
        trySocket();
      })();
    return {
      close: () => {
        closed = true;
        clearTimeout(timer);
        try {
          ws?.close(1000, "client closed");
        } catch {
          /* already closed */
        }
        set("closed");
      },
      wake: () => {
        if (closed || ws) return;
        clearTimeout(timer);
        idle = 0;
        failures = 0;
        void poll();
      },
      get status() {
        return status;
      },
    };
  }

  // ------------------------------------------------------------ plumbing

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    return JSON.parse(await this.request("GET", path, query)) as T;
  }

  private async request(method: string, path: string, query: Record<string, string> = {}, body?: string, isAction = false): Promise<string> {
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
      .join("&");
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, "wcp-version": WCP_VERSION };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = randomKey();
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}${qs ? `?${qs}` : ""}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = `Weft answered HTTP ${res.status}`;
      let retryable = res.status >= 500;
      try {
        const e = (JSON.parse(text) as { error?: { code?: string; message?: string; retryable?: boolean } }).error;
        if (e?.code) code = e.code;
        if (e?.message) message = e.message;
        if (typeof e?.retryable === "boolean") retryable = e.retryable;
      } catch {
        /* not JSON */
      }
      if (res.status === 401) message = "Weft rejected the token.";
      else if (res.status === 403 && isAction) message = "This token can only read. Approve, undo, pause and messages need a human token.";
      throw new WeftHttpError(res.status, code, message, retryable);
    }
    return text;
  }
}

function enc(repo: string): string {
  return encodeURIComponent(repo);
}

function parseFrame(data: unknown): { type: string; event?: unknown; head_seq?: number } | undefined {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    const f = JSON.parse(text) as { type?: unknown };
    return typeof f.type === "string" ? (f as { type: string }) : undefined;
  } catch {
    return undefined;
  }
}

function randomKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
