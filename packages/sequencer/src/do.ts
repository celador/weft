// RepoCoordinator: one Durable Object per repository — THE ordered log (design §2.3).
// SQLite storage holds the log, the input journal and all coordinator state; the
// hibernatable WebSocket API carries live inbox pushes to agents (spec §8.6) and the
// resumable observer stream (spec §9.4); the alarm expires claims and sessions (§7.5,
// §8.2) and pings observer streams.

import { DurableObject } from "cloudflare:workers";
import {
  closeCode,
  listView,
  validate,
  WcpProtocolError,
  type ErrorCode,
  type EventRecord,
  type Gate,
  type InboxBatch,
  type StreamFrame,
  type Submit,
  type WcpError,
} from "@weft/protocol";
import { canAccessRepo, hasScope, type Grant, type TokenVerifier } from "./auth";
import { SqlCoordinator, type CoordinatorConfig, type CoordinatorInit, type EventQuery } from "./coordinator";
import { JournaledCoordinator, type JournalOp } from "./journal";
import { redactRecord } from "./redact";
import type { Sql } from "./sql";

export type Result<T> = { ok: true; value: T } | { ok: false; error: WcpError };

export interface SequencerEnv {
  /** Registry Durable Object (token verification for WebSocket auth frames). */
  WEFT_REGISTRY?: DurableObjectNamespace;
}

/** Observer replay cap per stream connect (spec §9.4: MAY close with 4413 beyond it). */
export const REPLAY_CAP = 5000;
export const PING_INTERVAL_MS = 25_000;
export const AUTH_FRAME_TIMEOUT_MS = 10_000;

type Attachment =
  | { role: "stream"; authed: boolean; after: number; deadline?: number }
  | { role: "agent"; authed: boolean; session: string; agent?: string; deadline?: number };

/** Headers the gateway sets when forwarding a WebSocket upgrade to the DO. */
export const SOCKET_HEADERS = {
  role: "x-weft-socket",
  grant: "x-weft-grant",
  after: "x-weft-after",
  session: "x-weft-session",
} as const;

function fail(e: unknown): { ok: false; error: WcpError } {
  if (e instanceof WcpProtocolError) return { ok: false, error: e.toJSON() };
  const message = e instanceof Error ? e.message : String(e);
  return { ok: false, error: { type: "error", error: { code: "internal", message, retryable: true } } };
}

export class RepoCoordinator extends DurableObject<SequencerEnv> {
  private readonly sql: Sql;
  private engine?: JournaledCoordinator;
  /** Injectable clock (tests). Production uses the Workers clock. */
  clock: () => number = () => Date.now();
  /** Alarms are disabled while a test drives a synthetic clock. */
  private manualClock = false;

  constructor(ctx: DurableObjectState, env: SequencerEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql as unknown as Sql;
  }

  /** Test hook: drive the coordinator from a synthetic clock (disables alarms). */
  setClock(now: () => number): void {
    this.clock = now;
    this.manualClock = true;
  }

  private get j(): JournaledCoordinator {
    if (!this.engine) this.engine = new JournaledCoordinator(this.sql, () => this.clock());
    return this.engine;
  }

  // ------------------------------------------------------------------ RPC surface

  /** Create the repo (idempotent). The gateway's registry calls this on repo creation. */
  async init(init: CoordinatorInit): Promise<Result<{ created: boolean; config: CoordinatorConfig }>> {
    try {
      const created = SqlCoordinator.init(this.sql, init);
      this.engine = undefined;
      return { ok: true, value: { created, config: this.j.coord.config } };
    } catch (e) {
      return fail(e);
    }
  }

  async initialized(): Promise<boolean> {
    return SqlCoordinator.initialized(this.sql);
  }

  /** Every state change goes through here: journaled, applied, then broadcast. */
  async op<T = unknown>(op: JournalOp, args: unknown[]): Promise<Result<T>> {
    return this.mutate(() => this.j.call<T>(op, ...args));
  }

  private mutate<T>(fn: () => T): Result<T> {
    if (!SqlCoordinator.initialized(this.sql)) return fail(new WcpProtocolError("repo_not_found", "repository is not initialized"));
    const before = this.j.coord.head;
    let out: Result<T>;
    try {
      out = { ok: true, value: fn() };
    } catch (e) {
      out = fail(e);
    }
    this.afterMutation(before);
    return out;
  }

  /** Observer reads (diffs/intents redacted, spec §13). */
  async events(q: EventQuery): Promise<Result<ReturnType<SqlCoordinator["events"]>>> {
    return this.read(() => {
      const p = this.j.coord.events(q);
      return { ...p, events: p.events.map(redactRecord) };
    });
  }
  async event(seq: number): Promise<Result<EventRecord>> {
    return this.read(() => redactRecord(this.j.coord.event(seq)));
  }
  async summary(): Promise<Result<ReturnType<SqlCoordinator["summary"]>>> {
    return this.read(() => this.j.coord.summary());
  }
  async queue(statuses?: string[]): Promise<Result<ReturnType<SqlCoordinator["queue"]>>> {
    return this.read(() => this.j.coord.queue(statuses));
  }
  async ops(): Promise<Result<ReturnType<SqlCoordinator["ops"]>>> {
    return this.read(() => this.j.coord.ops());
  }
  async journal(after = 0, limit = 10_000): Promise<Result<ReturnType<JournaledCoordinator["journal"]>>> {
    return this.read(() => this.j.journal(after, limit));
  }
  async dump(): Promise<Result<Record<string, unknown[]>>> {
    return this.read(() => this.j.coord.dump());
  }
  async sessionAgent(sid: string): Promise<string | undefined> {
    if (!SqlCoordinator.initialized(this.sql)) return undefined;
    return this.j.coord.sessionAgent(sid);
  }

  private read<T>(fn: () => T): Result<T> {
    if (!SqlCoordinator.initialized(this.sql)) return fail(new WcpProtocolError("repo_not_found", "repository is not initialized"));
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      return fail(e);
    }
  }

  // ------------------------------------------------------------------ broadcast

  private afterMutation(headBefore: number): void {
    const c = this.j.coord;
    const head = c.head;
    if (head > headBefore) {
      const streams = this.ctx.getWebSockets("stream");
      if (streams.length) {
        const fresh = c.events({ after: headBefore, limit: Math.max(1, head - headBefore) }).events.map(redactRecord);
        for (const ws of streams) {
          const a = ws.deserializeAttachment() as Attachment | null;
          if (!a?.authed) continue;
          for (const ev of fresh) this.send(ws, { type: "event", event: ev });
        }
      }
    }
    // Agent sockets: pushing the inbox delivers it, so it is a (journaled) drain without ack.
    for (const sid of c.takeDirty()) {
      for (const ws of this.ctx.getWebSockets(`agent:${sid}`)) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (!a?.authed) continue;
        try {
          this.send(ws, this.j.call<InboxBatch>("drain", sid, undefined, undefined));
        } catch {
          /* session gone: the close below handles it */
        }
      }
    }
    c.takeDirty();
    this.reschedule();
  }

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already closed */
    }
  }

  private reschedule(): void {
    if (this.manualClock) return;
    const now = Date.now();
    const candidates: number[] = [];
    if (SqlCoordinator.initialized(this.sql)) {
      const exp = this.j.coord.nextExpiry();
      if (exp !== null) candidates.push(exp);
    }
    const sockets = this.ctx.getWebSockets();
    if (this.ctx.getWebSockets("stream").length) candidates.push(now + PING_INTERVAL_MS);
    for (const ws of sockets) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && !a.authed && a.deadline) candidates.push(a.deadline);
    }
    if (!candidates.length) return;
    void this.ctx.storage.setAlarm(Math.max(now + 10, Math.min(...candidates)));
  }

  /** Claim/session expiry (spec §7.5, §8.2), observer pings, auth-frame deadlines. */
  async alarm(): Promise<void> {
    await this.runAlarm();
  }

  /** The alarm body; returns records appended by expiry. */
  async runAlarm(): Promise<EventRecord[]> {
    const now = this.clock();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && !a.authed && a.deadline && a.deadline <= now) ws.close(closeCode("unauthorized"), "unauthorized");
    }
    if (!SqlCoordinator.initialized(this.sql)) return [];
    const before = this.j.coord.head;
    let appended: EventRecord[] = [];
    try {
      // An open agent socket counts as liveness (spec §8.6).
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.role === "agent" && a.authed) {
          try {
            this.j.call("heartbeat", a.session, undefined);
          } catch {
            ws.close(closeCode("session_expired"), "session_expired");
          }
        }
      }
      const exp = this.j.coord.nextExpiry();
      if (exp !== null && exp <= now) appended = this.j.call<EventRecord[]>("tick");
    } finally {
      for (const ws of this.ctx.getWebSockets("stream")) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.authed) this.send(ws, { type: "ping", head_seq: this.j.coord.head } satisfies StreamFrame);
      }
      this.afterMutation(before);
    }
    return appended;
  }

  /** Test hook mirroring the conformance `tick` op: expire now and broadcast. */
  async tick(): Promise<Result<EventRecord[]>> {
    return this.mutate(() => this.j.call<EventRecord[]>("tick"));
  }

  // ------------------------------------------------------------------ WebSockets

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    if (!SqlCoordinator.initialized(this.sql)) return new Response("repo_not_found", { status: 404 });
    const role = req.headers.get(SOCKET_HEADERS.role);
    const grant = req.headers.get(SOCKET_HEADERS.grant);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const now = this.clock();
    if (role === "stream") {
      const after = Number(req.headers.get(SOCKET_HEADERS.after) ?? "0") || 0;
      const att: Attachment = { role: "stream", authed: Boolean(grant), after, ...(grant ? {} : { deadline: now + AUTH_FRAME_TIMEOUT_MS }) };
      this.ctx.acceptWebSocket(server, ["stream"]);
      server.serializeAttachment(att);
      if (att.authed) this.replay(server, after);
    } else if (role === "agent") {
      const session = req.headers.get(SOCKET_HEADERS.session) ?? "";
      const g = grant ? (JSON.parse(grant) as Grant) : undefined;
      if (g && this.j.coord.sessionAgent(session) !== g.agent) return new Response("session_expired", { status: 410 });
      const att: Attachment = {
        role: "agent",
        authed: Boolean(g),
        session,
        ...(g?.agent ? { agent: g.agent } : {}),
        ...(g ? {} : { deadline: now + AUTH_FRAME_TIMEOUT_MS }),
      };
      this.ctx.acceptWebSocket(server, [`agent:${session}`, "agent"]);
      server.serializeAttachment(att);
      if (att.authed) this.pushInbox(server, session);
    } else {
      return new Response("bad socket role", { status: 400 });
    }
    this.reschedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Replay records after `after`, then replay.done (spec §9.4). */
  private replay(ws: WebSocket, after: number): void {
    const c = this.j.coord;
    const head = c.head;
    if (head - after > REPLAY_CAP) {
      ws.close(closeCode("payload_too_large"), "payload_too_large");
      return;
    }
    let cursor = after;
    while (cursor < head) {
      const page = c.events({ after: cursor, limit: c.config.limits.max_page });
      if (!page.events.length) break;
      for (const ev of page.events) this.send(ws, { type: "event", event: redactRecord(listView(ev)) } satisfies StreamFrame);
      cursor = page.next_after;
    }
    this.send(ws, { type: "replay.done", head_seq: head } satisfies StreamFrame);
  }

  private pushInbox(ws: WebSocket, session: string): void {
    const before = this.j.coord.head;
    try {
      if (this.j.coord.pending(session).length) this.send(ws, this.j.call<InboxBatch>("drain", session, undefined, undefined));
    } catch (e) {
      if (e instanceof WcpProtocolError) ws.close(closeCode(e.code), e.code);
    }
    this.afterMutation(before);
  }

  private async verifyAuthFrame(token: unknown): Promise<Grant | null> {
    if (typeof token !== "string" || !this.env.WEFT_REGISTRY) return null;
    const ns = this.env.WEFT_REGISTRY;
    const reg = ns.get(ns.idFromName("registry")) as unknown as TokenVerifier;
    return reg.verify(token);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as Record<string, unknown>;
    } catch {
      this.send(ws, new WcpProtocolError("invalid_message", "frame is not JSON").toJSON());
      return;
    }
    const id = msg.id;
    const re = id === undefined ? {} : { re: id };

    if (!a.authed) {
      if (msg.type !== "auth") {
        ws.close(closeCode("unauthorized"), "unauthorized");
        return;
      }
      const g = await this.verifyAuthFrame(msg.token);
      const repo = this.j.coord.repo;
      const ok =
        g &&
        canAccessRepo(g, repo) &&
        (a.role === "stream" ? hasScope(g, "observe") : hasScope(g, "agent") && g.agent !== undefined && this.j.coord.sessionAgent(a.session) === g.agent);
      if (!ok) {
        ws.close(g ? closeCode(a.role === "stream" && g && !canAccessRepo(g, repo) ? "repo_not_found" : "forbidden") : closeCode("unauthorized"), g ? "forbidden" : "unauthorized");
        return;
      }
      const { deadline: _d, ...rest } = a;
      const next = { ...rest, authed: true, ...(a.role === "agent" && g.agent ? { agent: g.agent } : {}) } as Attachment;
      ws.serializeAttachment(next);
      this.send(ws, { type: "auth.ok", ...re });
      if (next.role === "stream") this.replay(ws, next.after);
      else this.pushInbox(ws, next.session);
      return;
    }

    if (a.role === "stream") {
      if (msg.type === "ping") this.send(ws, { type: "ping", head_seq: this.j.coord.head, ...re });
      return; // observer streams are read-only
    }

    // Agent socket requests (spec §8.6).
    const sid = a.session;
    const owner = a.agent;
    const call = (op: JournalOp, args: unknown[]) => {
      const r = this.mutate(() => this.j.call(op, ...args));
      if (r.ok) this.send(ws, r.value === undefined ? { type: "ok", ...re } : { ...(r.value as object), ...re });
      else {
        this.send(ws, { ...r.error, ...re });
        if (r.error.error.code === "session_expired") ws.close(closeCode("session_expired"), "session_expired");
      }
    };
    const invalid = (issues: unknown) => this.send(ws, { ...new WcpProtocolError("invalid_message", "invalid frame", { issues }).toJSON(), ...re });
    switch (msg.type) {
      case "submit": {
        const { id: _id, idempotency_key, ...body } = msg;
        const v = validate<Submit>("Submit", body);
        if (!v.ok) return invalid(v.issues);
        call("submit", [sid, body, { ...(owner ? { owner } : {}), ...(typeof idempotency_key === "string" ? { idempotencyKey: idempotency_key } : {}) }]);
        return;
      }
      case "inbox.drain":
        call("drain", [sid, typeof msg.ack === "number" ? msg.ack : undefined, owner]);
        return;
      case "heartbeat":
        call("heartbeat", [sid, owner]);
        return;
      case "gate": {
        const { id: _id, ...body } = msg;
        const v = validate<Gate>("Gate", body);
        if (!v.ok) return invalid(v.issues);
        call("gate", [sid, body, owner]);
        return;
      }
      default:
        this.send(ws, { ...new WcpProtocolError("invalid_message", `unknown frame type ${String(msg.type)}`).toJSON(), ...re });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    /* nothing to clean up: state lives in SQLite, sockets are re-derived via getWebSockets() */
  }
}

export function errorCodeOf(r: Result<unknown>): ErrorCode | undefined {
  return r.ok ? undefined : r.error.error.code;
}

