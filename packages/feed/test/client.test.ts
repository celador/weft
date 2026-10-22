// ObserverClient against an in-memory gateway double: HTTP routes from WCP §9, and sockets that
// speak §9.4 (first-frame auth, replay, replay.done, live, 4413 cap). No network.

import { encodeCursor } from "@weft/protocol";
import { FeedSession, normalizeBaseUrl, ObserverClient, pollInterval, reconnectDelay, WeftHttpError, type WebSocketLike } from "../src";
import { record } from "./helpers";

type Req = { url: string; method: string; headers: Record<string, string>; body?: string };

class FakeGateway {
  log = new Map<string, ReturnType<typeof record>[]>();
  requests: Req[] = [];
  sockets: FakeSocket[] = [];
  /** Replay cap per connect (4413 above it). */
  replayCap = Infinity;
  feedStream = false;
  token = "tok";

  add(repo: string, n: number) {
    const rows = this.log.get(repo) ?? [];
    for (let i = 0; i < n; i++) {
      const r = record({ seq: rows.length + 1, repo, ts: new Date(Date.UTC(2026, 9, 22, 12, 0, rows.length)).toISOString() });
      rows.push(r);
      for (const s of this.sockets) if (s.live && s.repo === repo && s.readyState === 1) s.push({ type: "event", event: r });
    }
    this.log.set(repo, rows);
  }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    this.requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body ? { body: init.body } : {}) });
    const u = new URL(url);
    const json = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (init.headers?.authorization !== `Bearer ${this.token}`) return json(401, { error: { code: "unauthorized", message: "invalid token" } });
    if (u.pathname === "/v1/repos") return json(200, { type: "repos", repos: [...this.log.keys()].map((r) => ({ repo: r, head_seq: this.log.get(r)!.length, active_agents: 1, active_changes: 1, open_conflicts: 0, policy: {} })) });
    if (u.pathname === "/v1/feed") {
      const all = [...this.log.values()].flat();
      if (u.searchParams.get("tail")) {
        const limit = Number(u.searchParams.get("limit") ?? 100);
        const heads = Object.fromEntries([...this.log.entries()].map(([r, rows]) => [r, rows.length]));
        return json(200, { type: "feed", events: all.slice(-limit), cursor: encodeCursor(heads), has_more: false });
      }
      const c = JSON.parse(atob(u.searchParams.get("after")!.slice(3).replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, number>;
      const ev = all.filter((e) => e.seq > (c[e.repo] ?? 0));
      const next = { ...c };
      for (const e of ev) next[e.repo] = Math.max(next[e.repo] ?? 0, e.seq);
      return json(200, { type: "feed", events: ev, cursor: encodeCursor(next), has_more: false });
    }
    const m = /^\/v1\/repos\/([^/]+)\/(events|actions)(?:\/(\d+))?$/.exec(u.pathname);
    if (m) {
      const repo = decodeURIComponent(m[1]!);
      const rows = this.log.get(repo) ?? [];
      if (m[2] === "actions") {
        const body = JSON.parse(init.body!) as { action: string; agent?: string };
        const seq = rows.length + 1;
        const rec = { ...record({ seq, repo, kind: "control", agent: "john", payload: { action: body.action, target: { agent: body.agent } } }), actor: { type: "human", id: "john" } };
        rows.push(rec as never);
        return json(200, { type: "action.result", seq, record: rec });
      }
      if (m[3]) {
        const e = rows[Number(m[3]) - 1];
        return e ? json(200, { ...e, diff: "+x" }) : json(404, { error: { code: "not_found", message: "no" } });
      }
      const after = Number(u.searchParams.get("after") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 100);
      const page = rows.filter((e) => e.seq > after).slice(0, limit);
      const next = page.length ? page.at(-1)!.seq : after;
      return json(200, { type: "events", repo, events: page, head_seq: rows.length, next_after: next, has_more: next < rows.length });
    }
    return json(404, { error: { code: "not_found", message: "no route" } });
  };

  // Bound so it can be passed as a constructor.
  get WebSocket() {
    const gw = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(gw, url);
      }
    };
  }
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  repo?: string;
  after = 0;
  live = false;
  constructor(
    private gw: FakeGateway,
    readonly url: string,
  ) {
    gw.sockets.push(this);
    const u = new URL(url);
    const m = /^\/v1\/repos\/([^/]+)\/stream$/.exec(u.pathname);
    queueMicrotask(() => {
      if (!m && !(gw.feedStream && u.pathname === "/v1/feed/stream")) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({ code: 1006, reason: "" });
        return;
      }
      this.repo = m ? decodeURIComponent(m[1]!) : undefined;
      this.after = Number(u.searchParams.get("after") ?? 0);
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  push(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
    const f = JSON.parse(data) as { type: string; token?: string };
    if (f.type !== "auth") return;
    if (f.token !== this.gw.token) return this.close(4401, "unauthorized");
    this.push({ type: "auth.ok" });
    const rows = (this.gw.log.get(this.repo!) ?? []).filter((e) => e.seq > this.after);
    if (rows.length > this.gw.replayCap) return this.close(4413, "payload_too_large");
    for (const e of rows) this.push({ type: "event", event: e });
    this.push({ type: "replay.done", head_seq: this.gw.log.get(this.repo!)?.length ?? 0 });
    this.live = true;
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.live = false;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  /** Server-side drop (network loss). */
  drop() {
    this.close(1006, "");
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, ms = 2000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await tick();
  }
}

describe("ObserverClient", () => {
  it("normalizes the base URL", () => {
    expect(normalizeBaseUrl("weft.example.dev/v1/")).toBe("https://weft.example.dev");
    expect(normalizeBaseUrl("http://localhost:8787/")).toBe("http://localhost:8787");
  });

  it("sends the bearer token and WCP-Version, never the token in a URL", async () => {
    const gw = new FakeGateway();
    gw.add("r", 3);
    const c = new ObserverClient({ baseUrl: "http://gw.test", token: "tok", fetch: gw.fetch, WebSocket: gw.WebSocket });
    expect((await c.repos()).map((r) => r.repo)).toEqual(["r"]);
    const page = await c.events("r", { after: 1, limit: 10 });
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect((await c.event("r", 2)).diff).toBe("+x");
    expect(gw.requests.every((q) => q.headers.authorization === "Bearer tok" && q.headers["wcp-version"] === "0.1")).toBe(true);
    expect(gw.requests[1]!.url).toBe("http://gw.test/v1/repos/r/events?after=1&limit=10");
    const h = c.streamRepo("r", { onEvent: () => {} });
    await until(() => gw.sockets.length === 1 && gw.sockets[0]!.sent.length === 1);
    expect(gw.sockets[0]!.url).toBe("ws://gw.test/v1/repos/r/stream?after=0");
    expect(gw.sockets[0]!.sent[0]).toEqual({ type: "auth", token: "tok" });
    h.close();
  });

  it("maps errors: 401 unauthorized, 403 on an action is read-only", async () => {
    const gw = new FakeGateway();
    const c = new ObserverClient({ baseUrl: "http://gw.test", token: "bad", fetch: gw.fetch });
    const err = await c.repos().catch((e) => e);
    expect(err).toBeInstanceOf(WeftHttpError);
    expect([err.status, err.code, err.message]).toEqual([401, "unauthorized", "Weft rejected the token."]);
  });

  it("streams a repo: replay, replay.done, live; resumes after a drop and de-duplicates by seq", async () => {
    const gw = new FakeGateway();
    gw.add("r", 3);
    const c = new ObserverClient({ baseUrl: "http://gw.test", token: "tok", fetch: gw.fetch, WebSocket: gw.WebSocket });
    const got: number[] = [];
    const statuses: string[] = [];
    let head = 0;
    const h = c.streamRepo("r", { after: 1, onEvent: (e) => got.push(e.seq), onReplayDone: (n) => (head = n), onStatus: (s) => statuses.push(s) });
    await until(() => head === 3);
    expect(got).toEqual([2, 3]);
    gw.add("r", 1);
    expect(got).toEqual([2, 3, 4]);
    // Network drop: the client reconnects with after=4 after its backoff.
    vi.useFakeTimers();
    gw.sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    gw.add("r", 2); // written while offline
    await vi.advanceTimersByTimeAsync(reconnectDelay(1));
    vi.useRealTimers();
    await until(() => got.length === 5);
    expect(gw.sockets[1]!.url).toContain("after=4");
    // A replayed duplicate (replay and live may overlap) is ignored.
    gw.sockets[1]!.push({ type: "event", event: record({ seq: 5, repo: "r" }) });
    expect(got).toEqual([2, 3, 4, 5, 6]);
    expect(statuses).toContain("offline");
    expect(h.status).toBe("live");
    h.close();
    expect(h.status).toBe("closed");
  });

  it("4413: pages /events after the high-water mark, then reconnects", async () => {
    const gw = new FakeGateway();
    gw.add("r", 25);
    gw.replayCap = 10;
    const c = new ObserverClient({ baseUrl: "http://gw.test", token: "tok", fetch: gw.fetch, WebSocket: gw.WebSocket });
    const got: number[] = [];
    const h = c.streamRepo("r", { onEvent: (e) => got.push(e.seq), pageLimit: 10 });
    await until(() => got.length === 25 && gw.sockets.length === 2 && gw.sockets[1]!.live).catch((e) => {
      throw new Error(`${e} got=${got.length} socks=${gw.sockets.length} reqs=${gw.requests.map((q) => q.url).join(" ")}`);
    });
    expect(got).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(gw.requests.filter((q) => q.url.includes("/events?")).map((q) => new URL(q.url).searchParams.get("after"))).toEqual(["0", "10", "20"]);
    expect(gw.sockets[1]!.url).toContain("after=25");
    gw.add("r", 1);
    expect(got.at(-1)).toBe(26);
    h.close();
  });

  it("a wrong token on the socket stops (no reconnect loop)", async () => {
    const gw = new FakeGateway();
    gw.add("r", 1);
    const c = new ObserverClient({ baseUrl: "http://gw.test", token: "nope", fetch: gw.fetch, WebSocket: gw.WebSocket });
    let status = "";
    c.streamRepo("r", { onEvent: () => {}, onStatus: (s) => (status = s) });
    await until(() => status === "error");
    await new Promise((r) => setTimeout(r, 20));
    expect(gw.sockets).toHaveLength(1);
  });

  it("the combined feed falls back to polling /v1/feed when there is no feed stream", async () => {
    const gw = new FakeGateway();
    gw.add("a", 2);
    gw.add("b", 1);
    const c = new ObserverClient({ baseUrl: "http://gw.test", token: "tok", fetch: gw.fetch, WebSocket: gw.WebSocket });
    const batches: string[][] = [];
    vi.useFakeTimers();
    const h = c.streamFeed({ onEvents: (ev) => batches.push(ev.map((e) => `${e.repo}#${e.seq}`)) });
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([["a#1", "a#2", "b#1"]]);
    // It tried the combined stream (resuming from the tail page's cursor), found none, and polls.
    expect(gw.sockets.at(-1)!.url).toMatch(/^ws:\/\/gw\.test\/v1\/feed\/stream\?after=v0\./);
    gw.add("b", 1);
    await vi.advanceTimersByTimeAsync(pollInterval(0, 0));
    expect(batches.at(-1)).toEqual(["b#2"]);
    expect(h.status).toBe("polling");
    expect(gw.requests.filter((q) => q.url.includes("/v1/feed?after=v0.")).length).toBeGreaterThan(0);
    h.close();
    vi.useRealTimers();
  });

  it("poll and reconnect schedules match Otto", () => {
    expect([pollInterval(0, 0), pollInterval(20, 0), pollInterval(100, 0)]).toEqual([4000, 7000, 10_000]);
    expect([1, 2, 3, 4, 5, 6].map((f) => pollInterval(0, f))).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect([1, 2, 3, 6].map(reconnectDelay)).toEqual([1000, 2000, 4000, 30_000]);
  });
});

describe("FeedSession", () => {
  it("ingests the feed, marks live rows fresh, and puts an action's record in the log at once", async () => {
    const gw = new FakeGateway();
    gw.add("r", 2);
    const c = new ObserverClient({ baseUrl: "http://gw.test", token: "tok", fetch: gw.fetch, WebSocket: gw.WebSocket });
    const s = new FeedSession(c, { perRepoStreams: true });
    await s.start();
    await until(() => s.status === "live");
    expect(s.log.combined.map((e) => e.seq)).toEqual([2, 1]);
    expect(s.isFresh("r#2")).toBe(false);
    gw.add("r", 1);
    expect(s.isFresh("r#3")).toBe(true);
    expect(s.header().text).toBe("Live · r");
    const rec = await s.act({ kind: "pause", title: "Pause", label: "Pause a", repo: "r", agent: "a", destructive: false }, { reason: "hold on" });
    expect(rec.kind).toBe("control");
    expect(JSON.parse(gw.requests.at(-1)!.body!)).toEqual({ type: "action", action: "pause", agent: "a", reason: "hold on" });
    expect(s.log.isPaused("a", "r")).toBe(true);
    const d = await s.loadDetail("r", 1);
    expect(d?.diff).toBe("+x");
    s.stop();
  });
});
