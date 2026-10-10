// SqlCoordinator: the WCP v0.1 coordinator over SQLite. A line-by-line port of
// @weft/protocol's ReferenceCoordinator (the executable form of spec §5–§9) whose state
// lives in tables instead of memory, so it survives Durable Object eviction. Every public
// method is synchronous: a Durable Object runs one call at a time and SQLite writes made
// without an intervening await are committed atomically, so one protocol call is one
// transaction (spec §6.3 "applied atomically with the append").
//
// Differential tests (src/coordinator.test.ts) drive this class and the reference through
// every conformance scenario and require identical outputs, step by step.

import {
  addresseeOf,
  agreementOf,
  negotiationDues,
  renderDue,
  fileOf,
  listView,
  mergeWriteKind,
  renderContext,
  summarize,
  validate,
  WCP_VERSION,
  WcpProtocolError,
  type ActionResult,
  type Actor,
  type Arbitration,
  type ArbitrationPolicy,
  type Capabilities,
  type Diagnostic,
  type EscalationPolicy,
  type EventDraft,
  type EventKind,
  type EventPage,
  type EventRecord,
  type Gate,
  type GateResult,
  type HeartbeatAck,
  type Hello,
  type HumanAction,
  type InboxBatch,
  type InboxItem,
  type NegotiationDue,
  type RepoSummary,
  type Seq,
  type Submit,
  type SymbolKey,
  type Verdict,
  type Welcome,
  type Write,
  type WriteKind,
  type EnforcementMode,
} from "@weft/protocol";
import { all, migrate, one, run, type Sql } from "./sql";

export type CoordinatorConfig = {
  repo: string;
  policy: ArbitrationPolicy;
  /** Absent in configs written before B11: treated as `auto`. */
  escalation?: EscalationPolicy;
  claim_ttl_ms: number;
  session_ttl_ms: number;
  heartbeat_interval_ms: number;
  limits: { max_diff_bytes: number; max_keys: number; max_page: number };
  /** Absent = advise. `block` turns a same-symbol `claim_wait` into an error. Part of the journal's config, so replay is exact. */
  enforcement?: EnforcementMode;
};

export type CoordinatorInit = {
  repo: string;
  policy?: ArbitrationPolicy;
  escalation?: EscalationPolicy;
  enforcement?: EnforcementMode;
  claim_ttl_ms?: number;
  session_ttl_ms?: number;
  heartbeat_interval_ms?: number;
  max_diff_bytes?: number;
  max_keys?: number;
  max_page?: number;
};

export function configFrom(o: CoordinatorInit): CoordinatorConfig {
  return {
    repo: o.repo,
    policy: o.policy ?? "wound-wait",
    escalation: o.escalation ?? "auto",
    claim_ttl_ms: o.claim_ttl_ms ?? 30 * 60_000,
    session_ttl_ms: o.session_ttl_ms ?? 5 * 60_000,
    heartbeat_interval_ms: o.heartbeat_interval_ms ?? 30_000,
    limits: { max_diff_bytes: o.max_diff_bytes ?? 1_048_576, max_keys: o.max_keys ?? 2000, max_page: o.max_page ?? 500 },
    ...(o.enforcement ? { enforcement: o.enforcement } : {}),
  };
}

/** Server-side filters for GET /events (spec §9.3); comma-separated values are OR-ed. */
export type EventFilters = { kind?: string[]; agent?: string[]; task?: string[]; change?: string[]; status?: string[] };
export type EventQuery = { after?: Seq; limit?: number; include_diff?: boolean; tail?: boolean; before?: Seq; filters?: EventFilters };

type SessionRow = {
  id: string;
  ord: number;
  agent: string;
  harness: string;
  change_id: string;
  task: string | null;
  capabilities: string;
  delivered_through: number;
  next_inbox_id: number;
  paused_by: number | null;
  last_seen: number;
};

type Session = {
  id: string;
  agent: string;
  harness: string;
  change: string;
  task?: string;
  capabilities: Capabilities;
  delivered_through: Seq;
  paused_by?: Seq;
  last_seen: number;
};

type ChangeRow = {
  id: string;
  agent: string;
  task: string | null;
  priority: number;
  birth: number | null;
  landed: number;
  approved: number;
  /** Lead change of the merged group this change joined (spec §7.6). */
  merged_into: string | null;
};

type ClaimRow = {
  ord: number;
  change_id: string;
  agent: string;
  task: string | null;
  key: string;
  firm: number;
  source: "edit" | "explicit" | "predicted";
  seq: number;
  expires_at: number;
  shared: string;
};

type Claim = {
  ord: number;
  change: string;
  agent: string;
  task?: string;
  key: SymbolKey;
  firm: boolean;
  source: "edit" | "explicit" | "predicted";
  seq: Seq;
  expires_at: number;
  shared: string[];
};

export type QueueEntry = {
  id: number;
  change: string;
  status: "queued" | "landing" | "landed" | "failed" | "cancelled";
  requested_by: string;
  enqueued_seq: Seq | null;
  landed_seq: Seq | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

const AGENT_KINDS = new Set<EventKind>([
  "intent",
  "edit",
  "checkpoint",
  "claim",
  "release",
  "negotiate.propose",
  "negotiate.accept",
  "negotiate.reject",
  "negotiate.counter",
  "negotiate.escalate",
  "message",
]);
// `checkpoint` from the system = an observed push to the change's fork (Artifacts event).
const SYSTEM_KINDS = new Set<EventKind>(["land", "revert", "release", "checkpoint", "message"]);
const PAUSABLE = new Set<EventKind>(["edit", "claim", "checkpoint"]);
const NEGOTIATION_REPLIES = new Set<EventKind>(["negotiate.accept", "negotiate.reject", "negotiate.counter"]);
const STRONG: WriteKind[] = ["deleted", "signature"];

const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)];
const opt = <K extends string, V>(k: K, v: V | null | undefined) => (v === null || v === undefined ? {} : ({ [k]: v } as { [P in K]: V }));

export class SqlCoordinator {
  readonly config: CoordinatorConfig;
  /** Sessions whose inbox gained items since the last takeDirty() (for WebSocket pushes). */
  private dirty = new Set<string>();

  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = () => Date.now(),
  ) {
    migrate(sql);
    const c = one<{ v: string }>(sql, `SELECT v FROM meta WHERE k = 'config'`);
    if (!c) throw new WcpProtocolError("repo_not_found", "repository is not initialized");
    this.config = JSON.parse(c.v) as CoordinatorConfig;
  }

  /** Create (or keep) the repo's configuration. Returns true when it was newly created. */
  static init(sql: Sql, o: CoordinatorInit): boolean {
    migrate(sql);
    if (one(sql, `SELECT v FROM meta WHERE k = 'config'`)) return false;
    run(sql, `INSERT INTO meta (k, v) VALUES ('config', ?)`, JSON.stringify(configFrom(o)));
    return true;
  }

  static initialized(sql: Sql): boolean {
    migrate(sql);
    return Boolean(one(sql, `SELECT v FROM meta WHERE k = 'config'`));
  }

  get repo(): string {
    return this.config.repo;
  }
  get policy(): ArbitrationPolicy {
    return this.config.policy;
  }
  get escalation(): EscalationPolicy {
    return this.config.escalation ?? "auto";
  }
  /** Repo enforcement from the journaled config; absent means advise. */
  get enforcement(): EnforcementMode {
    return this.config.enforcement ?? "advise";
  }
  private get claimTtl(): number {
    return this.config.claim_ttl_ms;
  }
  private get sessionTtl(): number {
    return this.config.session_ttl_ms;
  }
  private get limits() {
    return this.config.limits;
  }

  get head(): Seq {
    return one<{ h: number | null }>(this.sql, `SELECT MAX(seq) AS h FROM events`)?.h ?? 0;
  }

  takeDirty(): string[] {
    const d = [...this.dirty];
    this.dirty.clear();
    return d;
  }

  // ---------------------------------------------------------------- counters

  private counter(name: string): number {
    const r = one<{ v: string }>(this.sql, `SELECT v FROM meta WHERE k = ?`, name);
    const n = (r ? Number(r.v) : 0) + 1;
    run(this.sql, `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, name, String(n));
    return n;
  }
  private ord(): number {
    return this.counter("ord");
  }

  // ---------------------------------------------------------------- row mapping

  private toSession(r: SessionRow): Session {
    return {
      id: r.id,
      agent: r.agent,
      harness: r.harness,
      change: r.change_id,
      ...opt("task", r.task),
      capabilities: JSON.parse(r.capabilities) as Capabilities,
      delivered_through: r.delivered_through,
      ...opt("paused_by", r.paused_by),
      last_seen: r.last_seen,
    };
  }

  private getSession(id: string): Session | undefined {
    const r = one<SessionRow>(this.sql, `SELECT * FROM sessions WHERE id = ?`, id);
    return r ? this.toSession(r) : undefined;
  }

  private allSessions(): Session[] {
    return all<SessionRow>(this.sql, `SELECT * FROM sessions ORDER BY ord`).map((r) => this.toSession(r));
  }

  private toClaim(r: ClaimRow): Claim {
    return {
      ord: r.ord,
      change: r.change_id,
      agent: r.agent,
      ...opt("task", r.task),
      key: r.key,
      firm: r.firm === 1,
      source: r.source,
      seq: r.seq,
      expires_at: r.expires_at,
      shared: JSON.parse(r.shared) as string[],
    };
  }

  private getChange(id: string | undefined): ChangeRow | undefined {
    if (id === undefined) return undefined;
    return one<ChangeRow>(this.sql, `SELECT * FROM changes WHERE id = ?`, id);
  }

  private setDelivered(s: Session, seq: Seq): void {
    s.delivered_through = seq;
    run(this.sql, `UPDATE sessions SET delivered_through = ? WHERE id = ?`, seq, s.id);
  }

  private inboxOf(sid: string): InboxItem[] {
    return all<{ item: string }>(this.sql, `SELECT item FROM inbox WHERE session = ? ORDER BY id`, sid).map((r) => JSON.parse(r.item) as InboxItem);
  }

  private openOf(sid: string): Diagnostic[] {
    return all<{ diagnostic: string }>(this.sql, `SELECT diagnostic FROM open_errors WHERE session = ? ORDER BY ord`, sid).map(
      (r) => JSON.parse(r.diagnostic) as Diagnostic,
    );
  }

  /** Map.set semantics: an existing key keeps its position, its value is replaced. */
  private openSet(sid: string, key: string, d: Diagnostic): void {
    run(
      this.sql,
      `INSERT INTO open_errors (session, key, ord, diagnostic) VALUES (?, ?, ?, ?)
       ON CONFLICT(session, key) DO UPDATE SET diagnostic = excluded.diagnostic`,
      sid,
      key,
      this.ord(),
      JSON.stringify(d),
    );
  }
  private openDelete(sid: string, key: string): void {
    run(this.sql, `DELETE FROM open_errors WHERE session = ? AND key = ?`, sid, key);
  }
  private openClear(sid: string): void {
    run(this.sql, `DELETE FROM open_errors WHERE session = ?`, sid);
  }

  private dropSession(sid: string): void {
    run(this.sql, `DELETE FROM sessions WHERE id = ?`, sid);
    run(this.sql, `DELETE FROM inbox WHERE session = ?`, sid);
    run(this.sql, `DELETE FROM open_errors WHERE session = ?`, sid);
    run(this.sql, `DELETE FROM idempotency WHERE session = ?`, sid);
  }

  // ---------------------------------------------------------------- sessions

  hello(h: Hello): Welcome {
    const v = validate<Hello>("Hello", h);
    if (!v.ok) throw new WcpProtocolError("invalid_message", "invalid hello", { issues: v.issues });
    const major = /^wcp\/(\d+)\./.exec(h.protocol)?.[1];
    if (major !== WCP_VERSION.split(".")[0])
      throw new WcpProtocolError("unsupported_version", `server speaks wcp/${WCP_VERSION}`, { supported: [`wcp/${WCP_VERSION}`] });

    const now = this.now();
    if (h.resume_session) {
      const s = this.getSession(h.resume_session);
      if (!s || s.agent !== h.agent.id) throw new WcpProtocolError("session_expired", "session cannot be resumed");
      s.last_seen = now;
      s.capabilities = h.capabilities;
      run(this.sql, `UPDATE sessions SET last_seen = ?, capabilities = ? WHERE id = ?`, now, JSON.stringify(h.capabilities), s.id);
      return this.welcome(s);
    }

    const changeId = h.change ?? `${h.agent.id}/${h.task?.id ?? "adhoc"}`;
    let change = this.getChange(changeId);
    if (!change) {
      run(
        this.sql,
        `INSERT INTO changes (id, ord, agent, task, priority, birth, landed, approved) VALUES (?, ?, ?, ?, ?, NULL, 0, 0)`,
        changeId,
        this.ord(),
        h.agent.id,
        h.task?.id ?? null,
        h.task?.priority ?? 0,
      );
      change = this.getChange(changeId)!;
    }
    const n = this.counter("session_counter");
    const s: Session = {
      id: `s${n}`,
      agent: h.agent.id,
      harness: h.agent.harness,
      change: changeId,
      capabilities: h.capabilities,
      delivered_through: 0,
      last_seen: now,
      ...opt("task", change.task),
    };
    run(
      this.sql,
      `INSERT INTO sessions (id, ord, agent, harness, change_id, task, capabilities, delivered_through, next_inbox_id, paused_by, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, ?)`,
      s.id,
      n,
      s.agent,
      s.harness,
      s.change,
      s.task ?? null,
      JSON.stringify(s.capabilities),
      now,
    );
    this.append({
      kind: "join",
      actor: { type: "agent", id: s.agent, harness: s.harness },
      session: s,
      draft: { kind: "join", base_seq: this.head, payload: { harness: s.harness, level: h.capabilities.level } },
      diagnostics: [],
      status: "accepted",
    });
    // A new session of a change inherits what the change still owes (spec §8.4).
    for (const d of this.dues(s)) this.push(s, { seq: d.seq, kind: "negotiation", record: d.record });
    this.setDelivered(s, this.head);
    return this.welcome(s);
  }

  private welcome(s: Session): Welcome {
    return {
      type: "welcome",
      protocol: `wcp/${WCP_VERSION}`,
      session: s.id,
      repo: this.repo,
      head_seq: this.head,
      delivered_through: s.delivered_through,
      heartbeat_interval_ms: this.config.heartbeat_interval_ms,
      session_ttl_ms: this.sessionTtl,
      claim_ttl_ms: this.claimTtl,
      policy: { arbitration: this.policy, escalation: this.escalation },
      limits: this.limits,
    };
  }

  /**
   * Resolve a live session and mark it seen. `owner` is the agent id bound to the caller's
   * token (spec §3); a session of another agent is `403 forbidden`.
   */
  private session(id: string, owner?: string): Session {
    const s = this.getSession(id);
    if (!s) throw new WcpProtocolError("session_expired", `unknown or expired session ${id}`);
    if (owner !== undefined && s.agent !== owner) throw new WcpProtocolError("forbidden", `session ${id} belongs to another agent`);
    s.last_seen = this.now();
    run(this.sql, `UPDATE sessions SET last_seen = ? WHERE id = ?`, s.last_seen, s.id);
    return s;
  }

  /** Owner of a session, for gateway-side checks (undefined when unknown/expired). */
  sessionAgent(id: string): string | undefined {
    return this.getSession(id)?.agent;
  }

  heartbeat(sid: string, owner?: string): HeartbeatAck {
    const s = this.session(sid, owner);
    const exp = this.now() + this.claimTtl;
    run(this.sql, `UPDATE claims SET expires_at = MAX(expires_at, ?) WHERE change_id = ? AND source != 'predicted'`, exp, s.change);
    const pending = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM inbox WHERE session = ?`, s.id)!.n;
    return {
      type: "heartbeat.ack",
      head_seq: this.head,
      inbox_pending: pending,
      session_expires_at: new Date(s.last_seen + this.sessionTtl).toISOString(),
    };
  }

  bye(sid: string, reason?: string, owner?: string): void {
    const s = this.session(sid, owner);
    this.dropSession(sid);
    this.append({
      kind: "leave",
      actor: { type: "agent", id: s.agent, harness: s.harness },
      session: s,
      draft: { kind: "leave", base_seq: this.head, payload: { harness: s.harness, level: s.capabilities.level }, ...(reason ? { intent: reason } : {}) },
      diagnostics: [],
      status: "accepted",
    });
  }

  // ---------------------------------------------------------------- submit

  /**
   * Submit an event. With `idempotencyKey`, a repeated key within the same session returns
   * the original verdict and appends nothing (spec §2.1).
   */
  submit(sid: string, msg: Submit, opts: { owner?: string; idempotencyKey?: string } = {}): Verdict {
    if (opts.idempotencyKey !== undefined) {
      const prior = one<{ verdict: string }>(this.sql, `SELECT verdict FROM idempotency WHERE session = ? AND key = ?`, sid, opts.idempotencyKey);
      if (prior) return JSON.parse(prior.verdict) as Verdict;
    }
    const v = validate<Submit>("Submit", msg);
    if (!v.ok) throw new WcpProtocolError("invalid_message", "invalid submit", { issues: v.issues });
    const s = this.session(sid, opts.owner);
    if (msg.inbox_ack !== undefined) this.ack(s, msg.inbox_ack);
    const e = msg.event;
    if (!AGENT_KINDS.has(e.kind)) throw new WcpProtocolError("forbidden", `agents may not submit ${e.kind}`);
    if (e.change !== undefined && e.change !== s.change)
      throw new WcpProtocolError("invalid_message", `event.change ${e.change} does not match session change ${s.change}`);
    if (e.task !== undefined && e.task !== s.task) throw new WcpProtocolError("invalid_message", `event.task ${e.task} does not match session task`);
    if (e.base_seq > s.delivered_through)
      throw new WcpProtocolError("base_ahead", `base_seq ${e.base_seq} > delivered_through ${s.delivered_through}`, {
        delivered_through: s.delivered_through,
      });
    this.checkLimits(e);
    this.checkReferences(s, e);

    const diagnostics = this.evaluate(s, e);
    const reject = diagnostics.some((d) => d.severity === "error");
    const actor: Actor = { type: "agent", id: s.agent, harness: s.harness };

    let out: Verdict;
    if (msg.mode === "check" && !reject) {
      out = this.verdict(s, "accept", "check", null, diagnostics);
    } else {
      const rec = this.append({ kind: e.kind, actor, session: s, draft: e, diagnostics, status: reject ? "rejected" : "accepted", mode: msg.mode });
      if (reject) {
        for (const d of diagnostics) if (d.severity === "error" && d.code !== "agent_paused") this.openSet(s.id, d.symbol, d);
      } else {
        this.applyAccepted(rec, s);
      }
      out = this.verdict(s, reject ? "reject" : "accept", msg.mode, rec.seq, diagnostics, rec.summary);
    }
    if (opts.idempotencyKey !== undefined)
      run(this.sql, `INSERT OR REPLACE INTO idempotency (session, key, at, verdict) VALUES (?, ?, ?, ?)`, sid, opts.idempotencyKey, this.now(), JSON.stringify(out));
    return out;
  }

  private verdict(s: Session, verdict: "accept" | "reject", mode: "check" | "commit", seq: Seq | null, diagnostics: Diagnostic[], summary?: string): Verdict {
    this.setDelivered(s, this.head);
    const inbox = this.inboxOf(s.id);
    const context = renderContext(diagnostics, inbox);
    return {
      type: "verdict",
      verdict,
      mode,
      seq,
      head_seq: this.head,
      diagnostics,
      inbox,
      delivered_through: s.delivered_through,
      ...(summary ? { summary } : {}),
      ...(context ? { context } : {}),
    };
  }

  private checkLimits(e: EventDraft): void {
    const keys = (e.reads?.length ?? 0) + (e.writes?.length ?? 0);
    if (keys > this.limits.max_keys) throw new WcpProtocolError("payload_too_large", `${keys} keys > ${this.limits.max_keys}`);
    if (e.diff && new TextEncoder().encode(e.diff).length > this.limits.max_diff_bytes)
      throw new WcpProtocolError("payload_too_large", `diff larger than ${this.limits.max_diff_bytes} bytes`);
  }

  private record(seq: Seq): EventRecord | undefined {
    if (!Number.isInteger(seq)) return undefined;
    const r = one<{ record: string }>(this.sql, `SELECT record FROM events WHERE seq = ?`, seq);
    return r ? (JSON.parse(r.record) as EventRecord) : undefined;
  }

  /** Who a negotiation record is addressed to. */
  private addressee(r: EventRecord): { agent?: string; change?: string } {
    if (r.kind === "negotiate.escalate") {
      const t = this.escalationTarget(r.change!, (r.payload?.with as { agent?: string; change?: string }) ?? {});
      return t ? { change: t } : {};
    }
    return addresseeOf(r, (n) => this.record(n));
  }

  // ---------------------------------------------------------------- merged groups (§7.6)

  /** Lead change of `id`'s merged group (itself when not merged). */
  group(id: string): string {
    return this.getChange(id)?.merged_into ?? id;
  }

  private sameGroup(a: string | undefined | null, b: string | undefined | null): boolean {
    return a !== undefined && a !== null && b !== undefined && b !== null && this.group(a) === this.group(b);
  }

  /** Alternatives (spec §7.7): distinct changes of the same task (best-of-N candidates). */
  private alternatives(a: string | undefined | null, b: string | undefined | null): boolean {
    if (a === undefined || a === null || b === undefined || b === null || a === b) return false;
    const ta = this.getChange(a)?.task;
    return ta !== undefined && ta !== null && ta === this.getChange(b)?.task;
  }

  private members(lead: string): ChangeRow[] {
    return all<ChangeRow>(this.sql, `SELECT * FROM changes WHERE COALESCE(merged_into, id) = ? ORDER BY ord`, lead);
  }

  /** `with.change`, else the newest unlanded change of `with.agent` outside `from`'s group. */
  private escalationTarget(from: string, w: { agent?: string; change?: string }): string | undefined {
    if (w.change) return this.getChange(w.change) ? w.change : undefined;
    if (w.agent === undefined) return undefined;
    const cands = all<ChangeRow>(this.sql, `SELECT * FROM changes WHERE agent = ? AND landed = 0 ORDER BY ord`, w.agent).filter((c) => !this.sameGroup(c.id, from));
    return cands.length ? cands[cands.length - 1]!.id : undefined;
  }

  /** Two groups conflict: an open error of `s` cites the target group, or keys overlap. */
  private groupsConflict(s: Session, target: string): boolean {
    const lead = this.group(target);
    for (const d of this.openOf(s.id)) {
      const c = this.record(d.caused_by_seq)?.change;
      if (c !== undefined && this.group(c) === lead) return true;
    }
    const now = this.now();
    const theirs = new Set<SymbolKey>();
    for (const m of this.members(lead)) {
      for (const r of all<{ key: string }>(this.sql, `SELECT key FROM change_writes WHERE change_id = ?`, m.id)) theirs.add(r.key);
      for (const r of all<{ key: string }>(this.sql, `SELECT key FROM claims WHERE change_id = ? AND source != 'predicted' AND expires_at > ?`, m.id, now)) theirs.add(r.key);
    }
    for (const m of this.members(this.group(s.change))) {
      for (const r of all<{ key: string }>(this.sql, `SELECT key FROM change_reads WHERE change_id = ?`, m.id)) if (theirs.has(r.key)) return true;
      for (const r of all<{ key: string }>(this.sql, `SELECT key FROM change_writes WHERE change_id = ?`, m.id)) if (theirs.has(r.key)) return true;
    }
    return false;
  }

  private checkEscalation(s: Session, w: { agent?: string; change?: string }): string {
    const own = this.getChange(s.change)!;
    const target = this.escalationTarget(s.change, w);
    if (!target) throw new WcpProtocolError("invalid_reference", "unknown escalation target (no unlanded change of that agent)", { with: w });
    const t = this.getChange(target)!;
    if (this.sameGroup(target, s.change)) throw new WcpProtocolError("invalid_reference", `${target} is already merged with ${s.change}`);
    if (t.landed || own.landed) throw new WcpProtocolError("invalid_reference", "a landed change cannot be merged");
    if (!this.groupsConflict(s, target))
      throw new WcpProtocolError("invalid_reference", `nothing to escalate: ${s.change} and ${target} do not conflict`, { change: target });
    return target;
  }

  private knownTarget(to: { agent?: string; change?: string }): boolean {
    if (to.change) return Boolean(this.getChange(to.change));
    if (to.agent === undefined) return false;
    return Boolean(one(this.sql, `SELECT 1 AS x FROM changes WHERE agent = ? LIMIT 1`, to.agent));
  }

  private checkReferences(s: Session, e: EventDraft): void {
    const p = e.payload ?? {};
    if (e.kind === "negotiate.propose" || e.kind === "message") {
      const to = p.to as { agent?: string; change?: string };
      if (!this.knownTarget(to)) throw new WcpProtocolError("invalid_reference", "unknown negotiation/message target", { to });
    }
    if (e.kind === "negotiate.escalate") this.checkEscalation(s, (p.with as { agent?: string; change?: string }) ?? {});
    if (NEGOTIATION_REPLIES.has(e.kind)) {
      const parent = this.record(Number(p.reply_to));
      if (!parent || parent.status !== "accepted" || (parent.kind !== "negotiate.propose" && parent.kind !== "negotiate.counter"))
        throw new WcpProtocolError("invalid_reference", `reply_to #${String(p.reply_to)} is not a proposal or counter`);
      const to = this.addressee(parent);
      if (!((to.change && to.change === s.change) || (!to.change && to.agent === s.agent)))
        throw new WcpProtocolError("invalid_reference", `reply_to #${parent.seq} is not addressed to this session`);
    }
  }

  // ---------------------------------------------------------------- §6 validation

  /** Seniority of a change = seniority of its merged group's lead (spec §7.1, §7.6). */
  private rank(changeId: string): [number, number, string] {
    const lead = this.group(changeId);
    const c = this.getChange(lead);
    return [-(c?.priority ?? 0), c?.birth ?? Number.MAX_SAFE_INTEGER, lead];
  }

  /** true when change a is senior to change b (higher priority, then older birth seq, then id). */
  senior(a: string, b: string): boolean {
    const ra = this.rank(a);
    const rb = this.rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i]! < rb[i]!;
    return false;
  }

  private claimsOnKey(key: SymbolKey): Claim[] {
    return all<ClaimRow>(this.sql, `SELECT * FROM claims WHERE key = ? ORDER BY ord`, key).map((r) => this.toClaim(r));
  }

  private activeClaims(key: SymbolKey, exceptChange: string): Claim[] {
    const now = this.now();
    return this.claimsOnKey(key).filter(
      (c) => !this.sameGroup(c.change, exceptChange) && !this.alternatives(c.change, exceptChange) && !c.shared.includes(exceptChange) && c.expires_at > now,
    );
  }

  /** Latest record in W (spec §6.1) writing `key`, restricted by a predicate on the write. */
  private latestW(key: SymbolKey, base: Seq, change: string | undefined, where: string): { r: EventRecord; w: Write } | undefined {
    const hit = one<{ seq: number; wkind: WriteKind }>(
      this.sql,
      // W excludes the submitter's whole merged group (spec §6.1, §7.6) and the in-flight
      // edits of its alternatives, i.e. other changes of the same task (§7.7).
      `SELECT seq, wkind FROM event_writes WHERE key = ? AND seq > ?
         AND (change_id IS NULL OR change_id NOT IN (SELECT id FROM changes WHERE COALESCE(merged_into, id) = ?))
         AND NOT (committed = 0 AND change_id IS NOT NULL AND change_id IS NOT ? AND change_id IN (SELECT id FROM changes WHERE task = ?)) AND ${where}
       ORDER BY seq DESC LIMIT 1`,
      key,
      base,
      change === undefined ? null : this.group(change),
      change ?? null,
      change === undefined ? null : (this.getChange(change)?.task ?? null),
    );
    if (!hit) return undefined;
    return { r: this.record(hit.seq)!, w: { key, kind: hit.wkind } };
  }

  private evaluate(s: Session, e: EventDraft): Diagnostic[] {
    const out: Diagnostic[] = [];
    if (s.paused_by !== undefined && PAUSABLE.has(e.kind)) {
      const pause = this.record(s.paused_by)!;
      out.push({
        severity: "error",
        code: "agent_paused",
        file: "",
        symbol: "",
        message: `Paused by ${pause.actor.id}${pause.payload?.reason ? `: ${String(pause.payload.reason)}` : ""}. Stop and wait for resume.`,
        caused_by_seq: pause.seq,
        caused_by_agent: pause.actor.id,
      });
      return out;
    }
    if (e.kind !== "edit" && e.kind !== "claim") return out;
    const writes = e.writes ?? [];
    const cause = (r: EventRecord) => ({
      caused_by_seq: r.seq,
      caused_by_agent: r.agent ?? r.actor.id,
      ...(r.task ? { caused_by_task: r.task } : {}),
    });

    // R1 stale overwrite (edit only): a committed (landed/reverted) write since base.
    const r1 = new Set<SymbolKey>();
    if (e.kind === "edit") {
      for (const w of writes) {
        const hit = this.latestW(w.key, e.base_seq, s.change, "committed = 1");
        if (!hit) continue;
        r1.add(w.key);
        out.push({
          severity: "error",
          code: "stale_overwrite",
          file: fileOf(w.key),
          symbol: w.key,
          message: `${w.key} changed on trunk (#${hit.r.seq}, ${hit.r.kind} by ${hit.r.agent ?? hit.r.actor.id}) after your base #${e.base_seq}; this edit would overwrite it.`,
          suggestion: `Rebase onto trunk at or after #${hit.r.seq}, then redo the edit.`,
          ...cause(hit.r),
        });
      }

      // R2 stale assumption / stale read.
      for (const key of uniq(e.reads ?? [])) {
        const strong = this.latestW(key, e.base_seq, s.change, `wkind IN ('deleted', 'signature')`);
        if (strong) {
          out.push({
            severity: "error",
            code: "stale_assumption",
            file: fileOf(key),
            symbol: key,
            message: `You use ${key}, whose ${strong.w.kind === "deleted" ? "declaration was removed" : "signature changed"} in #${strong.r.seq} by ${strong.r.agent ?? strong.r.actor.id} after your base #${e.base_seq}.`,
            suggestion: `Read the new ${key} (event #${strong.r.seq}) and update this call site, or negotiate with ${strong.r.agent ?? strong.r.actor.id}.`,
            ...cause(strong.r),
          });
          continue;
        }
        const body = this.latestW(key, e.base_seq, s.change, `wkind = 'body'`);
        if (body)
          out.push({
            severity: "warning",
            code: "stale_read",
            file: fileOf(key),
            symbol: key,
            message: `${key} body changed in #${body.r.seq} by ${body.r.agent ?? body.r.actor.id} after your base #${e.base_seq}; its contract is unchanged.`,
            ...cause(body.r),
          });
      }
    }

    // R3 claim overlap + arbitration (edit and claim).
    const predicted = e.kind === "claim" && e.payload?.source === "predicted";
    for (const w of writes) {
      if (r1.has(w.key)) continue;
      const holders = this.activeClaims(w.key, s.change);
      if (!holders.length) continue;
      const real = holders.filter((c) => c.source !== "predicted");
      if (predicted || !real.length) {
        const h = (real[0] ?? holders[0])!;
        out.push({
          severity: "info",
          code: "claim_predicted_overlap",
          file: fileOf(w.key),
          symbol: w.key,
          message: `${w.key} is also ${h.source === "predicted" ? "predicted for" : "claimed by"} ${h.agent} (${h.change}).`,
          caused_by_seq: h.seq,
          caused_by_agent: h.agent,
          ...(h.task ? { caused_by_task: h.task } : {}),
        });
        continue;
      }
      const h = real.reduce((a, c) => (this.senior(c.change, a.change) ? c : a));
      const meSenior = this.senior(s.change, h.change);
      const me = { agent: s.agent, change: s.change };
      const them = { agent: h.agent, change: h.change };
      let outcome: Arbitration["outcome"];
      if (this.policy === "wound-wait") outcome = meSenior ? "wound" : "wait";
      else outcome = meSenior ? "wait" : "die";
      const arbitration: Arbitration = {
        policy: this.policy,
        outcome,
        winner: outcome === "wound" ? me : them,
        loser: outcome === "wound" ? them : me,
        options: outcome === "die" ? ["retreat", "negotiate", "escalate"] : ["retreat", "wait", "negotiate", "escalate"],
      };
      const base = {
        file: fileOf(w.key),
        symbol: w.key,
        caused_by_seq: h.seq,
        caused_by_agent: h.agent,
        ...(h.task ? { caused_by_task: h.task } : {}),
        arbitration,
      };
      if (outcome === "wound") {
        out.push({
          ...base,
          severity: "info",
          code: "claim_contended",
          message: `${w.key} was claimed by ${h.agent} (${h.change}); your task has precedence, so ${h.agent} must yield.`,
        });
      } else if (outcome === "wait") {
        out.push({
          ...base,
          severity: h.firm || this.enforcement === "block" ? "error" : "warning",
          code: "claim_wait",
          message: `${w.key} is ${h.firm ? "firmly claimed" : "being edited"} by ${h.agent} (${h.change}), which has precedence.`,
          suggestion: `Wait for ${h.agent} to land or release ${w.key}, work elsewhere, or negotiate (negotiate.propose to ${h.agent}).`,
        });
      } else {
        out.push({
          ...base,
          severity: "error",
          code: "claim_die",
          message: `${w.key} is held by older change ${h.change} (${h.agent}); under wait-die the younger change retreats.`,
          suggestion: `Retreat from ${w.key} (rework without it) or negotiate with ${h.agent}.`,
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- append + effects

  private append(a: {
    kind: EventKind;
    actor: Actor;
    session?: Session;
    draft: EventDraft;
    diagnostics: Diagnostic[];
    status: "accepted" | "rejected";
    mode?: "check" | "commit";
    agent?: string;
    change?: string;
    task?: string;
  }): EventRecord {
    const d = a.draft;
    const writes = d.writes ?? [];
    const reads = uniq(d.reads ?? []);
    const agent = a.session?.agent ?? a.agent;
    const change = a.session?.change ?? a.change ?? d.change;
    const task = a.session?.task ?? a.task ?? d.task;
    const files = uniq([...(d.files ?? []), ...writes.map((w) => fileOf(w.key))]);
    const draftRecord = {
      kind: a.kind,
      status: a.status,
      actor: a.actor,
      writes,
      ...(agent ? { agent } : {}),
      ...(d.intent ? { intent: d.intent } : {}),
      ...(d.payload ? { payload: d.payload } : {}),
      ...(change ? { change } : {}),
      ...(d.summary_hint ? { summary_hint: d.summary_hint } : {}),
    };
    // ts is non-decreasing in seq even if the clock steps back (spec §5.1).
    const last = Number(one<{ v: string }>(this.sql, `SELECT v FROM meta WHERE k = 'last_ts'`)?.v ?? 0);
    const t = Math.max(this.now(), last);
    run(this.sql, `INSERT INTO meta (k, v) VALUES ('last_ts', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, String(t));
    const rec: EventRecord = {
      seq: this.head + 1,
      repo: this.repo,
      status: a.status,
      kind: a.kind,
      ts: new Date(t).toISOString(),
      actor: a.actor,
      ...(agent ? { agent } : {}),
      ...(task ? { task } : {}),
      ...(change ? { change } : {}),
      ...(a.session ? { session: a.session.id } : {}),
      base_seq: d.base_seq,
      ...(a.mode ? { mode: a.mode } : {}),
      files,
      reads,
      writes,
      ...(d.diff !== undefined ? { diff: d.diff } : {}),
      ...(d.intent ? { intent: d.intent } : {}),
      summary: summarize(draftRecord),
      diagnostics: a.diagnostics,
      ...(d.payload ? { payload: d.payload } : {}),
      ...(d.tool ? { tool: d.tool } : {}),
      ...(d.transcript ? { transcript: d.transcript } : {}),
    };
    run(
      this.sql,
      `INSERT INTO events (seq, kind, status, ts, actor_type, actor_id, agent, change_id, task, session, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.seq,
      rec.kind,
      rec.status,
      rec.ts,
      rec.actor.type,
      rec.actor.id,
      rec.agent,
      rec.change,
      rec.task,
      rec.session,
      JSON.stringify(rec),
    );
    if (rec.status === "accepted" && (rec.kind === "edit" || rec.kind === "land" || rec.kind === "revert")) {
      const committed = rec.kind !== "edit";
      // First write per key wins, as `writes.find()` does in the reference.
      for (const w of rec.writes)
        run(this.sql, `INSERT OR IGNORE INTO event_writes (seq, key, wkind, change_id, committed) VALUES (?, ?, ?, ?, ?)`, rec.seq, w.key, w.kind, rec.change, committed);
    }
    return rec;
  }

  private sessionsOf(t: { agent?: string; change?: string }): Session[] {
    const rows = t.change
      ? all<SessionRow>(this.sql, `SELECT * FROM sessions WHERE change_id = ? ORDER BY ord`, t.change)
      : t.agent === undefined
        ? []
        : all<SessionRow>(this.sql, `SELECT * FROM sessions WHERE agent = ? ORDER BY ord`, t.agent);
    return rows.map((r) => this.toSession(r));
  }

  private push(s: Session, item: Omit<InboxItem, "id">): void {
    const r = one<{ id: number }>(this.sql, `UPDATE sessions SET next_inbox_id = next_inbox_id + 1 WHERE id = ? RETURNING next_inbox_id - 1 AS id`, s.id)!;
    const full: InboxItem = { id: r.id, ...item };
    run(this.sql, `INSERT INTO inbox (session, id, seq, item) VALUES (?, ?, ?, ?)`, s.id, r.id, full.seq, JSON.stringify(full));
    if (item.diagnostic?.severity === "error") this.openSet(s.id, item.diagnostic.symbol, item.diagnostic);
    this.dirty.add(s.id);
  }

  private upsertClaim(c: Omit<Claim, "shared" | "ord">): void {
    const existing = one<ClaimRow>(this.sql, `SELECT * FROM claims WHERE change_id = ? AND key = ? ORDER BY ord LIMIT 1`, c.change, c.key);
    if (!existing) {
      run(
        this.sql,
        `INSERT INTO claims (ord, change_id, agent, task, key, firm, source, seq, expires_at, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
        this.ord(),
        c.change,
        c.agent,
        c.task ?? null,
        c.key,
        c.firm,
        c.source,
        c.seq,
        c.expires_at,
      );
      return;
    }
    const source = c.source !== "edit" || existing.source === "predicted" ? c.source : existing.source;
    run(
      this.sql,
      `UPDATE claims SET seq = ?, expires_at = ?, source = ?, firm = ? WHERE ord = ?`,
      c.seq,
      Math.max(existing.expires_at, c.expires_at),
      source,
      existing.firm === 1 || c.firm,
      existing.ord,
    );
  }

  private touchesChange(c: ChangeRow, key: SymbolKey): boolean {
    return Boolean(
      one(this.sql, `SELECT 1 AS x FROM change_reads WHERE change_id = ? AND key = ?`, c.id, key) ||
        one(this.sql, `SELECT 1 AS x FROM change_writes WHERE change_id = ? AND key = ?`, c.id, key) ||
        one(this.sql, `SELECT 1 AS x FROM claims WHERE change_id = ? AND key = ? LIMIT 1`, c.id, key),
    );
  }

  private applyAccepted(rec: EventRecord, s?: Session): void {
    const now = this.now();
    const change = this.getChange(rec.change);
    if (change && change.birth === null && rec.kind !== "join" && rec.kind !== "leave") {
      run(this.sql, `UPDATE changes SET birth = ? WHERE id = ?`, rec.seq, change.id);
      change.birth = rec.seq;
    }
    if (change && (rec.kind === "edit" || rec.kind === "intent")) {
      for (const k of rec.reads) run(this.sql, `INSERT OR IGNORE INTO change_reads (change_id, key) VALUES (?, ?)`, change.id, k);
      for (const w of rec.writes) {
        const prev = one<{ wkind: WriteKind }>(this.sql, `SELECT wkind FROM change_writes WHERE change_id = ? AND key = ?`, change.id, w.key);
        const merged = mergeWriteKind(prev?.wkind, w.kind);
        if (prev) run(this.sql, `UPDATE change_writes SET wkind = ? WHERE change_id = ? AND key = ?`, merged, change.id, w.key);
        else run(this.sql, `INSERT INTO change_writes (change_id, key, wkind, ord) VALUES (?, ?, ?, ?)`, change.id, w.key, merged, this.ord());
      }
    }
    // Own open errors on touched keys are resolved by an accepted event.
    if (s) for (const k of [...rec.reads, ...rec.writes.map((w) => w.key)]) this.openDelete(s.id, k);
    // Any accepted event from a change keeps its non-predicted claims alive (§7.5).
    if (change && rec.actor.type === "agent")
      run(this.sql, `UPDATE claims SET expires_at = MAX(expires_at, ?) WHERE change_id = ? AND source != 'predicted'`, now + this.claimTtl, change.id);

    const p = rec.payload ?? {};
    switch (rec.kind) {
      case "edit":
      case "claim": {
        const isClaim = rec.kind === "claim";
        const ttl = isClaim && typeof p.ttl_ms === "number" ? p.ttl_ms : this.claimTtl;
        for (const d of rec.diagnostics) {
          const arb = d.arbitration;
          if (!arb) continue;
          if (arb.outcome === "wound") {
            // The requester outranks the most senior holder, hence every holder (§7.2).
            const wounded = uniq(
              this.activeClaims(d.symbol, rec.change!)
                .filter((c) => c.source !== "predicted")
                .map((c) => c.change),
            );
            for (const loser of wounded) run(this.sql, `DELETE FROM claims WHERE change_id = ? AND key = ?`, loser, d.symbol);
            for (const loser of wounded) {
              const la = this.getChange(loser)!;
              const larb: Arbitration = { ...arb, loser: { agent: la.agent, change: la.id } };
              for (const hs of this.sessionsOf({ change: loser }))
                this.push(hs, {
                  seq: rec.seq,
                  kind: "diagnostic",
                  diagnostic: {
                    severity: "error",
                    code: "claim_wounded",
                    file: d.file,
                    symbol: d.symbol,
                    message: `${s?.agent ?? rec.actor.id} (${rec.change}) has precedence on ${d.symbol} and took it over; your claim was revoked.`,
                    suggestion: `Retreat from ${d.symbol}, wait for ${rec.change} to land, or negotiate.`,
                    caused_by_seq: rec.seq,
                    caused_by_agent: rec.agent ?? rec.actor.id,
                    ...(rec.task ? { caused_by_task: rec.task } : {}),
                    arbitration: larb,
                  },
                });
            }
          } else {
            for (const hs of this.sessionsOf({ change: arb.winner.change }))
              this.push(hs, {
                seq: rec.seq,
                kind: "diagnostic",
                diagnostic: {
                  severity: "info",
                  code: "claim_contended",
                  file: d.file,
                  symbol: d.symbol,
                  message: `${rec.agent} (${rec.change}) also touched ${d.symbol}; you keep it (${arb.outcome}).`,
                  caused_by_seq: rec.seq,
                  caused_by_agent: rec.agent ?? rec.actor.id,
                  ...(rec.task ? { caused_by_task: rec.task } : {}),
                  arbitration: arb,
                },
              });
          }
        }
        for (const w of rec.writes)
          this.upsertClaim({
            change: rec.change!,
            agent: rec.agent!,
            ...(rec.task ? { task: rec.task } : {}),
            key: w.key,
            firm: isClaim ? Boolean(p.firm) : false,
            source: isClaim ? (p.source === "predicted" ? "predicted" : "explicit") : "edit",
            seq: rec.seq,
            expires_at: now + ttl,
          });
        break;
      }
      case "release": {
        const keys = p.keys as SymbolKey[] | undefined;
        if (keys) for (const k of keys) run(this.sql, `DELETE FROM claims WHERE change_id IS ? AND key = ?`, rec.change ?? null, k);
        else run(this.sql, `DELETE FROM claims WHERE change_id IS ?`, rec.change ?? null);
        if (s && keys) for (const k of keys) this.openDelete(s.id, k);
        if (s && !keys) this.openClear(s.id);
        break;
      }
      case "land": {
        run(this.sql, `DELETE FROM claims WHERE change_id IS ?`, rec.change ?? null);
        // ... and its alternatives' claims (§7.7): they lost.
        const task = this.getChange(rec.change ?? undefined)?.task;
        if (task !== undefined && task !== null) run(this.sql, `DELETE FROM claims WHERE change_id IN (SELECT id FROM changes WHERE task = ? AND id IS NOT ?)`, task, rec.change ?? null);
        if (change) run(this.sql, `UPDATE changes SET landed = 1 WHERE id = ?`, change.id);
        if (change) change.landed = 1;
        for (const cs of this.sessionsOf({ change: rec.change! })) this.openClear(cs.id);
        this.recordOp(rec);
        run(
          this.sql,
          `UPDATE submit_queue SET status = 'landed', landed_seq = ?, updated_at = ? WHERE change_id IS ? AND status IN ('queued', 'landing')`,
          rec.seq,
          rec.ts,
          rec.change ?? null,
        );
        break;
      }
      case "revert":
        this.recordOp(rec);
        break;
      case "negotiate.propose":
      case "negotiate.counter":
      case "negotiate.reject":
      case "message": {
        const to = rec.kind === "message" || rec.kind === "negotiate.propose" ? (p.to as { agent?: string; change?: string }) : this.addressee(rec);
        for (const ts of this.sessionsOf(to)) this.push(ts, { seq: rec.seq, kind: rec.kind === "message" ? "message" : "negotiation", record: rec });
        break;
      }
      case "negotiate.accept": {
        const to = this.addressee(rec);
        for (const ts of this.sessionsOf(to)) this.push(ts, { seq: rec.seq, kind: "negotiation", record: rec });
        const a = this.applyAgreement(rec);
        if (a?.terms.kind === "merge_tasks") this.merge(a.asker, a.giver, rec.seq, a.terms.text);
        break;
      }
      case "negotiate.escalate": {
        const to = this.addressee(rec);
        for (const ts of this.sessionsOf(to)) this.push(ts, { seq: rec.seq, kind: "negotiation", record: rec });
        if (this.escalation === "auto" && to.change) this.merge(rec.change!, to.change, rec.seq, typeof p.reason === "string" ? p.reason : undefined);
        break;
      }
      case "control": {
        const action = p.action as string;
        const target = p.target as { agent?: string; change?: string };
        if (action === "pause" || action === "resume") {
          for (const ts of this.sessionsOf(target)) {
            if (action === "pause") run(this.sql, `UPDATE sessions SET paused_by = ? WHERE id = ?`, rec.seq, ts.id);
            else run(this.sql, `UPDATE sessions SET paused_by = NULL WHERE id = ?`, ts.id);
            this.push(ts, { seq: rec.seq, kind: "control", record: rec });
          }
        } else if (action === "approve" && target.change) {
          run(this.sql, `UPDATE changes SET approved = 1 WHERE id = ?`, target.change);
          for (const ts of this.sessionsOf(target)) this.push(ts, { seq: rec.seq, kind: "control", record: rec });
        } else if (action === "merge") {
          this.applyMerge(rec);
        }
        break;
      }
      default:
        break;
    }

    // Broadcast contract changes and trunk movement to intersecting changes (spec §6.3).
    if (rec.kind === "edit" || rec.kind === "land" || rec.kind === "revert") {
      for (const c of all<ChangeRow>(this.sql, `SELECT * FROM changes ORDER BY ord`)) {
        if (c.id === rec.change || c.landed) continue;
        if (rec.kind === "edit" && this.alternatives(c.id, rec.change)) continue;
        const targets = this.sessionsOf({ change: c.id });
        if (!targets.length) continue;
        if (rec.kind !== "edit") {
          const hit = rec.writes.filter((w) => this.touchesChange(c, w.key));
          if (hit.length) {
            for (const ts of targets)
              this.push(ts, {
                seq: rec.seq,
                kind: "trunk",
                requires_rebase: true,
                diagnostic: {
                  severity: "info",
                  code: "trunk_advanced",
                  file: fileOf(hit[0]!.key),
                  symbol: hit[0]!.key,
                  message: `Trunk moved (#${rec.seq} ${rec.kind}) over ${hit.map((w) => w.key).join(", ")}; rebase before touching ${hit.length === 1 ? "it" : "them"}.`,
                  caused_by_seq: rec.seq,
                  caused_by_agent: rec.agent ?? rec.actor.id,
                  ...(rec.task ? { caused_by_task: rec.task } : {}),
                },
              });
          } else continue;
        }
        for (const w of rec.writes) {
          if (!STRONG.includes(w.kind) || !this.touchesChange(c, w.key)) continue;
          for (const ts of targets)
            this.push(ts, {
              seq: rec.seq,
              kind: "diagnostic",
              diagnostic: {
                severity: "warning",
                code: "contract_changed",
                file: fileOf(w.key),
                symbol: w.key,
                message: `${rec.agent ?? rec.actor.id} ${w.kind === "deleted" ? "removed" : "changed the signature of"} ${w.key} (#${rec.seq}), which your change uses.`,
                suggestion: `Re-read ${w.key} and adapt your call sites before your next edit, or negotiate (e.g. keep the old signature as an overload).`,
                caused_by_seq: rec.seq,
                caused_by_agent: rec.agent ?? rec.actor.id,
                ...(rec.task ? { caused_by_task: rec.task } : {}),
              },
            });
        }
      }
    }
  }

  private recordOp(rec: EventRecord): void {
    const p = rec.payload ?? {};
    const opId = typeof p.op_id === "string" ? p.op_id : `seq-${rec.seq}`;
    run(
      this.sql,
      `INSERT OR IGNORE INTO ops (op_id, seq, kind, change_id, sha, trunk_ref, reverts_seq, reverts_op_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      opId,
      rec.seq,
      rec.kind,
      rec.change ?? null,
      typeof p.sha === "string" ? p.sha : null,
      typeof p.trunk_ref === "string" ? p.trunk_ref : null,
      typeof p.reverts_seq === "number" ? p.reverts_seq : null,
      typeof p.reverts_op_id === "string" ? p.reverts_op_id : null,
      rec.ts,
    );
  }

  /** negotiate.accept: apply transfer/share terms (spec §7.4). Returns the agreement. */
  private applyAgreement(rec: EventRecord) {
    const a = agreementOf(rec, (n) => this.record(n));
    if (!a) return undefined;
    // Direction is anchored at the root proposal: its author asks, the other party gives.
    const { root, terms, keys, asker, giver, askerAgent } = a;
    if (terms.kind === "transfer") {
      for (const k of keys)
        run(this.sql, `UPDATE claims SET change_id = ?, agent = ?, task = ? WHERE change_id = ? AND key = ?`, asker, askerAgent, root.task ?? null, giver, k);
    } else if (terms.kind === "share") {
      for (const k of keys)
        for (const c of this.claimsOnKey(k)) {
          const shared = [...c.shared];
          if (c.change === giver && !shared.includes(asker)) shared.push(asker);
          if (c.change === asker && !shared.includes(giver)) shared.push(giver);
          if (shared.length !== c.shared.length) run(this.sql, `UPDATE claims SET shared = ? WHERE ord = ?`, JSON.stringify(shared), c.ord);
        }
    } else return a;
    for (const ss of [...this.sessionsOf({ change: giver }), ...this.sessionsOf({ change: asker })]) for (const k of keys) this.openDelete(ss.id, k);
    return a;
  }

  /** Merge the tasks of `a` and `b` (spec §7.6): append a system `control merge`, senior lead first. */
  private merge(a: string, b: string, cause: Seq, reason?: string): void {
    const ca = this.getChange(a);
    const cb = this.getChange(b);
    if (!ca || !cb || ca.landed || cb.landed || this.sameGroup(a, b)) return;
    const ga = this.group(a);
    const gb = this.group(b);
    const [lead, other] = this.senior(ga, gb) ? [ga, gb] : [gb, ga];
    const rec = this.append({
      kind: "control",
      actor: { type: "system", id: "coordinator" },
      draft: { kind: "control", base_seq: this.head, payload: { action: "merge", target: { changes: [lead, other] }, cause, ...(reason ? { reason } : {}) } },
      diagnostics: [],
      status: "accepted",
    });
    this.applyAccepted(rec);
  }

  /** Effects of an accepted `control merge`: one group, cross-group errors forgiven, everyone told. */
  private applyMerge(rec: EventRecord): void {
    const [lead, other] = ((rec.payload?.target as { changes?: string[] })?.changes ?? []) as [string, string];
    run(this.sql, `UPDATE changes SET merged_into = ? WHERE COALESCE(merged_into, id) = ?`, lead, other);
    run(this.sql, `UPDATE changes SET merged_into = NULL WHERE id = ?`, lead);
    for (const m of this.members(lead))
      for (const ss of this.sessionsOf({ change: m.id })) {
        for (const r of all<{ key: string; diagnostic: string }>(this.sql, `SELECT key, diagnostic FROM open_errors WHERE session = ? ORDER BY ord`, ss.id)) {
          const c = this.record((JSON.parse(r.diagnostic) as Diagnostic).caused_by_seq)?.change;
          if (c !== undefined && this.group(c) === lead) this.openDelete(ss.id, r.key);
        }
        this.push(ss, { seq: rec.seq, kind: "control", record: rec });
      }
  }

  // ---------------------------------------------------------------- inbox + gates

  private ack(s: Session, ack: number): void {
    run(this.sql, `DELETE FROM inbox WHERE session = ? AND id <= ?`, s.id, ack);
  }

  drain(sid: string, ack?: number, owner?: string): InboxBatch {
    const s = this.session(sid, owner);
    if (ack !== undefined) this.ack(s, ack);
    this.setDelivered(s, this.head);
    const items = this.inboxOf(s.id);
    const context = renderContext([], items);
    return {
      type: "inbox",
      items,
      head_seq: this.head,
      delivered_through: s.delivered_through,
      open_errors: this.openOf(s.id),
      paused: s.paused_by !== undefined,
      ...(context ? { context } : {}),
    };
  }

  /** Pending inbox for a WebSocket push (no ack, no delivered_through change). */
  pending(sid: string): InboxItem[] {
    return this.inboxOf(sid);
  }

  /** Negotiations the session still owes (spec §8.4). */
  private dues(s: Session): NegotiationDue[] {
    const records = all<{ record: string }>(this.sql, `SELECT record FROM events WHERE status = 'accepted' AND kind LIKE 'negotiate.%' ORDER BY seq`).map(
      (r) => JSON.parse(r.record) as EventRecord,
    );
    if (!records.length) return [];
    return negotiationDues({
      records,
      me: { agent: s.agent, change: s.change },
      record: (n) => this.record(n),
      fulfilled: (giver, after, keys) =>
        keys.some((k) =>
          one(
            this.sql,
            `SELECT 1 AS x FROM event_writes w JOIN events e ON e.seq = w.seq WHERE w.key = ? AND w.seq > ? AND w.change_id = ? AND w.committed = 0 AND e.kind = 'edit' LIMIT 1`,
            k,
            after,
            giver,
          ),
        ),
    });
  }

  gate(sid: string, g: Gate, owner?: string): GateResult {
    const s = this.session(sid, owner);
    const open = this.openOf(s.id);
    const dues = g.gate === "stop" ? this.dues(s) : [];
    const extra = dues.length ? { negotiations: dues } : {};
    if (g.gate === "stop" && s.paused_by !== undefined)
      return { type: "gate.result", gate: g.gate, allow: true, reason: "paused by a human; stopping is allowed", open_errors: open, ...extra };
    if (!open.length && !dues.length) return { type: "gate.result", gate: g.gate, allow: true, open_errors: [] };
    const parts = [
      ...(open.length ? [`${open.length} open Weft error(s) must be resolved first:\n${renderContext(open)}`] : []),
      ...(dues.length ? [`${dues.length} negotiation(s) still due:\n${dues.map(renderDue).join("\n")}`] : []),
    ];
    return { type: "gate.result", gate: g.gate, allow: false, reason: parts.join("\n"), open_errors: open, ...extra };
  }

  // ---------------------------------------------------------------- human + system

  action(human: string, a: HumanAction): ActionResult {
    const v = validate<HumanAction>("HumanAction", a);
    if (!v.ok) throw new WcpProtocolError("invalid_message", "invalid action", { issues: v.issues });
    const actor: Actor = { type: "human", id: human };
    let draft: EventDraft;
    switch (a.action) {
      case "approve":
        if (!this.getChange(a.change)) throw new WcpProtocolError("invalid_reference", `unknown change ${a.change}`);
        draft = { kind: "control", base_seq: this.head, payload: { action: "approve", target: { change: a.change }, ...(a.note ? { reason: a.note } : {}) } };
        break;
      case "undo": {
        let target: EventRecord | undefined;
        if (a.seq !== undefined) target = this.record(a.seq);
        else {
          const r = one<{ record: string }>(
            this.sql,
            `SELECT record FROM events WHERE kind = 'land' AND json_extract(record, '$.payload.op_id') = ? ORDER BY seq LIMIT 1`,
            a.op_id ?? null,
          );
          target = r ? (JSON.parse(r.record) as EventRecord) : undefined;
        }
        if (!target || target.kind !== "land") throw new WcpProtocolError("invalid_reference", "undo target must be a land event");
        draft = { kind: "control", base_seq: this.head, payload: { action: "undo", target: { seq: target.seq, op_id: String(target.payload?.op_id) }, reason: a.reason } };
        break;
      }
      case "pause":
      case "resume":
        if (!this.knownTarget({ agent: a.agent })) throw new WcpProtocolError("invalid_reference", `unknown agent ${a.agent}`);
        draft = { kind: "control", base_seq: this.head, payload: { action: a.action, target: { agent: a.agent }, ...(a.reason ? { reason: a.reason } : {}) } };
        break;
      case "message":
        if (!this.knownTarget(a.to)) throw new WcpProtocolError("invalid_reference", "unknown message target");
        draft = { kind: "message", base_seq: this.head, payload: { to: a.to, text: a.text, ...(a.intent ? { intent: a.intent } : {}) } };
        break;
      case "merge": {
        const [x, y] = a.changes;
        const cx = this.getChange(x);
        const cy = this.getChange(y);
        if (!cx || !cy) throw new WcpProtocolError("invalid_reference", `unknown change ${!cx ? x : y}`);
        if (this.sameGroup(x, y)) throw new WcpProtocolError("invalid_reference", `${x} and ${y} are already merged`);
        if (cx.landed || cy.landed) throw new WcpProtocolError("invalid_reference", "a landed change cannot be merged");
        const gx = this.group(x);
        const gy = this.group(y);
        const changes = this.senior(gx, gy) ? [gx, gy] : [gy, gx];
        draft = { kind: "control", base_seq: this.head, payload: { action: "merge", target: { changes }, ...(a.reason ? { reason: a.reason } : {}) } };
        break;
      }
    }
    const rec = this.append({ kind: draft.kind, actor, draft, diagnostics: [], status: "accepted" });
    this.applyAccepted(rec);
    return { type: "action.result", seq: rec.seq, record: rec };
  }

  /**
   * Trusted system writers (landing queue, revert workflow, claim expiry). `land` is
   * validated against committed writes since its base (trunk compare-and-swap, §6.2 R1).
   */
  system(draft: EventDraft, actor: Actor = { type: "system", id: "coordinator" }): EventRecord {
    if (!SYSTEM_KINDS.has(draft.kind)) throw new WcpProtocolError("forbidden", `system may not submit ${draft.kind}`);
    const change = this.getChange(draft.change);
    if (draft.kind === "land" && !change) throw new WcpProtocolError("invalid_reference", `unknown change ${String(draft.change)}`);
    let d = draft;
    if (draft.kind === "land" && !draft.writes)
      d = {
        ...draft,
        writes: all<{ key: string; wkind: WriteKind }>(this.sql, `SELECT key, wkind FROM change_writes WHERE change_id = ? ORDER BY ord`, change!.id).map((r) => ({
          key: r.key,
          kind: r.wkind,
        })),
      };
    const diagnostics: Diagnostic[] = [];
    if (d.kind === "land") {
      for (const w of d.writes ?? []) {
        const hitRow = one<{ seq: number }>(
          this.sql,
          `SELECT seq FROM event_writes WHERE key = ? AND seq > ? AND change_id IS NOT ? AND committed = 1 ORDER BY seq DESC LIMIT 1`,
          w.key,
          d.base_seq,
          d.change ?? null,
        );
        const hit = hitRow ? this.record(hitRow.seq)! : undefined;
        if (hit)
          diagnostics.push({
            severity: "error",
            code: "stale_overwrite",
            file: fileOf(w.key),
            symbol: w.key,
            message: `Trunk changed ${w.key} in #${hit.seq} after the landing base #${d.base_seq}; rebase and retry the landing.`,
            caused_by_seq: hit.seq,
            caused_by_agent: hit.agent ?? hit.actor.id,
            ...(hit.task ? { caused_by_task: hit.task } : {}),
          });
      }
    }
    const status = diagnostics.some((x) => x.severity === "error") ? "rejected" : "accepted";
    const rec = this.append({
      kind: d.kind,
      actor,
      draft: d,
      diagnostics,
      status,
      ...(change ? { agent: change.agent, change: change.id, ...(change.task ? { task: change.task } : {}) } : {}),
    });
    if (status === "accepted") this.applyAccepted(rec);
    return rec;
  }

  /** Expire claims and sessions (the Durable Object alarm). Returns appended records. */
  tick(): EventRecord[] {
    const now = this.now();
    const out: EventRecord[] = [];
    const expired = all<ClaimRow>(this.sql, `SELECT * FROM claims WHERE expires_at <= ? ORDER BY ord`, now).map((r) => this.toClaim(r));
    run(this.sql, `DELETE FROM claims WHERE expires_at <= ?`, now);
    const byChange = new Map<string, Claim[]>();
    for (const c of expired) byChange.set(c.change, [...(byChange.get(c.change) ?? []), c]);
    for (const [changeId, cs] of byChange) {
      const c = this.getChange(changeId)!;
      out.push(
        this.append({
          kind: "release",
          actor: { type: "system", id: "coordinator" },
          draft: { kind: "release", base_seq: this.head, payload: { keys: cs.map((x) => x.key), reason: "expired" } },
          diagnostics: [],
          status: "accepted",
          agent: c.agent,
          change: c.id,
          ...(c.task ? { task: c.task } : {}),
        }),
      );
    }
    for (const s of this.allSessions()) {
      if (s.last_seen + this.sessionTtl > now) continue;
      this.dropSession(s.id);
      out.push(
        this.append({
          kind: "leave",
          actor: { type: "system", id: "coordinator" },
          session: s,
          draft: { kind: "leave", base_seq: this.head, payload: { harness: s.harness, level: s.capabilities.level }, intent: "session expired" },
          diagnostics: [],
          status: "accepted",
        }),
      );
    }
    return out;
  }

  /** Earliest time at which tick() has work: next claim or session expiry (ms), or null. */
  nextExpiry(): number | null {
    const c = one<{ t: number | null }>(this.sql, `SELECT MIN(expires_at) AS t FROM claims`)?.t ?? null;
    const s = one<{ t: number | null }>(this.sql, `SELECT MIN(last_seen) AS t FROM sessions`)?.t ?? null;
    const sExp = s === null ? null : s + this.sessionTtl;
    if (c === null) return sExp;
    if (sExp === null) return c;
    return Math.min(c, sExp);
  }

  // ---------------------------------------------------------------- submit queue (B8 lands)

  enqueue(change: string, requestedBy: string, note?: string): QueueEntry {
    if (!this.getChange(change)) throw new WcpProtocolError("invalid_reference", `unknown change ${change}`);
    const existing = one<{ id: number }>(this.sql, `SELECT id FROM submit_queue WHERE change_id = ? AND status IN ('queued', 'landing')`, change);
    if (existing) return this.queueEntry(existing.id)!;
    const ts = new Date(this.now()).toISOString();
    const r = one<{ id: number }>(
      this.sql,
      `INSERT INTO submit_queue (change_id, status, requested_by, enqueued_seq, landed_seq, note, created_at, updated_at)
       VALUES (?, 'queued', ?, ?, NULL, ?, ?, ?) RETURNING id`,
      change,
      requestedBy,
      this.head,
      note ?? null,
      ts,
      ts,
    )!;
    return this.queueEntry(r.id)!;
  }

  setQueueStatus(id: number, status: QueueEntry["status"], note?: string): QueueEntry {
    if (!this.queueEntry(id)) throw new WcpProtocolError("not_found", `no queue entry ${id}`);
    run(this.sql, `UPDATE submit_queue SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?`, status, note ?? null, new Date(this.now()).toISOString(), id);
    return this.queueEntry(id)!;
  }

  private queueEntry(id: number): QueueEntry | undefined {
    const r = one<{ id: number; change_id: string; status: QueueEntry["status"]; requested_by: string; enqueued_seq: number | null; landed_seq: number | null; note: string | null; created_at: string; updated_at: string }>(
      this.sql,
      `SELECT * FROM submit_queue WHERE id = ?`,
      id,
    );
    if (!r) return undefined;
    const { change_id, ...rest } = r;
    return { ...rest, change: change_id };
  }

  queue(statuses: string[] = ["queued", "landing"]): QueueEntry[] {
    const ids = all<{ id: number; status: string }>(this.sql, `SELECT id, status FROM submit_queue ORDER BY id`).filter((r) => statuses.includes(r.status));
    return ids.map((r) => this.queueEntry(r.id)!);
  }

  ops(): Array<Record<string, unknown>> {
    return all(this.sql, `SELECT * FROM ops ORDER BY seq`);
  }

  // ---------------------------------------------------------------- observer

  /** Paged log read (spec §9.3) with optional server-side filters. Results are ascending. */
  events(q: EventQuery = {}): EventPage {
    const after = q.after ?? 0;
    const n = Math.min(Math.max(1, q.limit ?? 100), this.limits.max_page);
    const head = this.head;
    const view = (r: EventRecord) => (q.include_diff ? r : listView(r));
    const f = q.filters ?? {};
    const conds: string[] = [];
    const args: Array<string | number> = [];
    const add = (col: string, vals?: string[]) => {
      if (!vals?.length) return;
      conds.push(`${col} IN (${vals.map(() => "?").join(", ")})`);
      args.push(...vals);
    };
    add("kind", f.kind);
    add("agent", f.agent);
    add("task", f.task);
    add("change_id", f.change);
    add("status", f.status);
    const filtered = conds.length > 0;
    const where = (extra: string) => [extra, ...conds].filter(Boolean).join(" AND ");
    const rows = (whereSql: string, order: "ASC" | "DESC", ...a: Array<string | number>) =>
      all<{ record: string }>(this.sql, `SELECT record FROM events WHERE ${whereSql} ORDER BY seq ${order} LIMIT ?`, ...a, ...args, n).map(
        (r) => JSON.parse(r.record) as EventRecord,
      );

    let slice: EventRecord[];
    let nextAfter: Seq;
    if (q.tail || q.before !== undefined) {
      const end = q.tail ? head : Math.min(Math.max(q.before! - 1, 0), head);
      slice = rows(where("seq <= ?"), "DESC", end).reverse();
      nextAfter = slice.length ? slice[slice.length - 1]!.seq : after;
    } else {
      slice = rows(where("seq > ?"), "ASC", after);
      nextAfter = slice.length ? slice[slice.length - 1]!.seq : after;
      // With filters, a short page means everything up to head was examined (§9.3:
      // next_after is the highest seq examined, so filtered paging never stalls).
      if (filtered && slice.length < n) nextAfter = Math.max(after, head);
    }
    return { type: "events", repo: this.repo, events: slice.map(view), head_seq: head, next_after: nextAfter, has_more: nextAfter < head };
  }

  event(seq: Seq): EventRecord {
    const r = this.record(seq);
    if (!r) throw new WcpProtocolError("not_found", `no event #${seq}`);
    return r;
  }

  summary(): RepoSummary {
    const sessions = this.allSessions();
    const last = one<{ ts: string }>(this.sql, `SELECT ts FROM events ORDER BY seq DESC LIMIT 1`);
    const open = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM open_errors`)!.n;
    return {
      repo: this.repo,
      head_seq: this.head,
      active_agents: new Set(sessions.map((s) => s.agent)).size,
      active_changes: new Set(sessions.map((s) => s.change)).size,
      open_conflicts: open,
      ...(last ? { last_event_at: last.ts } : {}),
      policy: { arbitration: this.policy, escalation: this.escalation },
    };
  }

  /** Debug/test view of active claims. */
  claimsFor(key: SymbolKey): Array<{ change: string; firm: boolean; source: string }> {
    const now = this.now();
    return this.claimsOnKey(key)
      .filter((c) => c.expires_at > now)
      .map((c) => ({ change: c.change, firm: c.firm, source: c.source }));
  }

  /** Complete dump of coordinator state (for replay-determinism checks). */
  dump(): Record<string, unknown[]> {
    const tables = ["events", "event_writes", "sessions", "changes", "change_reads", "change_writes", "claims", "inbox", "open_errors", "ops", "submit_queue"];
    const out: Record<string, unknown[]> = {};
    for (const t of tables) out[t] = all(this.sql, `SELECT * FROM ${t} ORDER BY rowid`);
    out.meta = all(this.sql, `SELECT * FROM meta WHERE k != 'schema_version' ORDER BY k`);
    return out;
  }
}
