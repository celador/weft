// Reference WCP v0 coordinator: an in-memory, deterministic, synchronous implementation of
// the normative rules in docs/protocol/wcp-v0.md (§5 sequencing, §6 validation, §7
// arbitration, inbox, gates, observer + human actions). It exists so that the conformance
// scenarios in fixtures/scenarios are executable; packages/sequencer (the Durable Object)
// MUST produce the same verdicts, diagnostics and inbox items for those scenarios.

import { renderContext, renderDue } from "./context";
import { addresseeOf, agreementOf, negotiationDues } from "./negotiation";
import { WcpProtocolError } from "./errors";
import { fileOf } from "./summary";
import { summarize } from "./summary";
import type {
  ActionResult,
  Actor,
  Arbitration,
  ArbitrationPolicy,
  Capabilities,
  Diagnostic,
  EnforcementMode,
  EscalationPolicy,
  EventDraft,
  EventKind,
  EventPage,
  EventRecord,
  Gate,
  GateResult,
  HeartbeatAck,
  Hello,
  HumanAction,
  InboxBatch,
  InboxItem,
  NegotiationDue,
  Seq,
  Submit,
  SymbolKey,
  Verdict,
  Welcome,
  Write,
  WriteKind,
} from "./types";
import { WCP_VERSION } from "./types";
import { validate } from "./validate";

export type CoordinatorOptions = {
  repo: string;
  policy?: ArbitrationPolicy;
  /** Who resolves `negotiate.escalate` (spec §7.6). Default `auto`: the coordinator merges. */
  escalation?: EscalationPolicy;
  /** Deployment-wide: `block` makes a same-symbol overlap with a neighbor's in-flight change an error. Default `advise`. */
  enforcement?: EnforcementMode;
  claim_ttl_ms?: number;
  session_ttl_ms?: number;
  heartbeat_interval_ms?: number;
  max_diff_bytes?: number;
  max_keys?: number;
  max_page?: number;
  /** Injected clock (ms since epoch) for deterministic tests. */
  now?: () => number;
};

type ChangeState = {
  id: string;
  agent: string;
  task?: string;
  priority: number;
  birth?: Seq;
  reads: Set<SymbolKey>;
  writes: Map<SymbolKey, WriteKind>;
  landed: boolean;
  approved: boolean;
  /** Lead change of the merged group this change joined (spec §7.6). */
  merged_into?: string;
};

type Claim = {
  change: string;
  agent: string;
  task?: string;
  key: SymbolKey;
  firm: boolean;
  source: "edit" | "explicit" | "predicted";
  seq: Seq;
  expires_at: number;
  shared: Set<string>;
};

type Session = {
  id: string;
  agent: string;
  harness: string;
  change: string;
  task?: string;
  capabilities: Capabilities;
  delivered_through: Seq;
  inbox: InboxItem[];
  next_inbox_id: number;
  open: Map<string, Diagnostic>;
  paused_by?: Seq;
  last_seen: number;
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

export class ReferenceCoordinator {
  readonly repo: string;
  readonly policy: ArbitrationPolicy;
  readonly escalation: EscalationPolicy;
  readonly enforcement: EnforcementMode;
  readonly claimTtl: number;
  readonly sessionTtl: number;
  readonly heartbeatInterval: number;
  readonly limits: { max_diff_bytes: number; max_keys: number; max_page: number };
  private readonly now: () => number;

  readonly log: EventRecord[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly changes = new Map<string, ChangeState>();
  private claims: Claim[] = [];
  private sessionCounter = 0;

  constructor(o: CoordinatorOptions) {
    this.repo = o.repo;
    this.policy = o.policy ?? "wound-wait";
    this.escalation = o.escalation ?? "auto";
    this.enforcement = o.enforcement ?? "advise";
    this.claimTtl = o.claim_ttl_ms ?? 30 * 60_000;
    this.sessionTtl = o.session_ttl_ms ?? 5 * 60_000;
    this.heartbeatInterval = o.heartbeat_interval_ms ?? 30_000;
    this.limits = { max_diff_bytes: o.max_diff_bytes ?? 1_048_576, max_keys: o.max_keys ?? 2000, max_page: o.max_page ?? 500 };
    this.now = o.now ?? (() => Date.now());
  }

  get head(): Seq {
    return this.log.length;
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
      const s = this.sessions.get(h.resume_session);
      if (!s || s.agent !== h.agent.id) throw new WcpProtocolError("session_expired", "session cannot be resumed");
      s.last_seen = now;
      s.capabilities = h.capabilities;
      return this.welcome(s);
    }

    const changeId = h.change ?? `${h.agent.id}/${h.task?.id ?? "adhoc"}`;
    let change = this.changes.get(changeId);
    if (!change) {
      change = {
        id: changeId,
        agent: h.agent.id,
        priority: h.task?.priority ?? 0,
        reads: new Set(),
        writes: new Map(),
        landed: false,
        approved: false,
        ...(h.task ? { task: h.task.id } : {}),
      };
      this.changes.set(changeId, change);
    }
    const s: Session = {
      id: `s${++this.sessionCounter}`,
      agent: h.agent.id,
      harness: h.agent.harness,
      change: changeId,
      capabilities: h.capabilities,
      delivered_through: 0,
      inbox: [],
      next_inbox_id: 1,
      open: new Map(),
      last_seen: now,
      ...(change.task ? { task: change.task } : {}),
    };
    this.sessions.set(s.id, s);
    this.append({
      kind: "join",
      actor: { type: "agent", id: s.agent, harness: s.harness },
      session: s,
      draft: { kind: "join", base_seq: this.head, payload: { harness: s.harness, level: h.capabilities.level } },
      diagnostics: [],
      status: "accepted",
    });
    // A new session of a change inherits what the change still owes (spec §8.4): pending
    // proposals addressed to it and unfulfilled agreements, so a restarted agent sees them.
    for (const d of this.dues(s)) this.push(s, { seq: d.seq, kind: "negotiation", record: d.record });
    s.delivered_through = this.head;
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
      heartbeat_interval_ms: this.heartbeatInterval,
      session_ttl_ms: this.sessionTtl,
      claim_ttl_ms: this.claimTtl,
      policy: { arbitration: this.policy, escalation: this.escalation },
      limits: this.limits,
    };
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new WcpProtocolError("session_expired", `unknown or expired session ${id}`);
    s.last_seen = this.now();
    return s;
  }

  heartbeat(sid: string): HeartbeatAck {
    const s = this.session(sid);
    const exp = this.now() + this.claimTtl;
    for (const c of this.claims) if (c.change === s.change && c.source !== "predicted") c.expires_at = Math.max(c.expires_at, exp);
    return {
      type: "heartbeat.ack",
      head_seq: this.head,
      inbox_pending: s.inbox.length,
      session_expires_at: new Date(s.last_seen + this.sessionTtl).toISOString(),
    };
  }

  bye(sid: string, reason?: string): void {
    const s = this.session(sid);
    this.sessions.delete(sid);
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

  submit(sid: string, msg: Submit): Verdict {
    const v = validate<Submit>("Submit", msg);
    if (!v.ok) throw new WcpProtocolError("invalid_message", "invalid submit", { issues: v.issues });
    const s = this.session(sid);
    if (msg.inbox_ack !== undefined) this.ack(s, msg.inbox_ack);
    const e = msg.event;
    if (!AGENT_KINDS.has(e.kind)) throw new WcpProtocolError("forbidden", `agents may not submit ${e.kind}`);
    if (e.change !== undefined && e.change !== s.change)
      throw new WcpProtocolError("invalid_message", `event.change ${e.change} does not match session change ${s.change}`);
    if (e.task !== undefined && e.task !== s.task)
      throw new WcpProtocolError("invalid_message", `event.task ${e.task} does not match session task`);
    if (e.base_seq > s.delivered_through)
      throw new WcpProtocolError("base_ahead", `base_seq ${e.base_seq} > delivered_through ${s.delivered_through}`, {
        delivered_through: s.delivered_through,
      });
    this.checkLimits(e);
    this.checkReferences(s, e);

    const diagnostics = this.evaluate(s, e);
    const reject = diagnostics.some((d) => d.severity === "error");
    const actor: Actor = { type: "agent", id: s.agent, harness: s.harness };

    if (msg.mode === "check" && !reject) {
      return this.verdict(s, "accept", "check", null, diagnostics);
    }
    const rec = this.append({ kind: e.kind, actor, session: s, draft: e, diagnostics, status: reject ? "rejected" : "accepted", mode: msg.mode });
    if (reject) {
      for (const d of diagnostics) if (d.severity === "error" && d.code !== "agent_paused") s.open.set(d.symbol, d);
    } else {
      this.applyAccepted(rec, s);
    }
    return this.verdict(s, reject ? "reject" : "accept", msg.mode, rec.seq, diagnostics, rec.summary);
  }

  private verdict(s: Session, verdict: "accept" | "reject", mode: "check" | "commit", seq: Seq | null, diagnostics: Diagnostic[], summary?: string): Verdict {
    s.delivered_through = this.head;
    const inbox = [...s.inbox];
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
    return this.log[seq - 1];
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
    return this.changes.get(id)?.merged_into ?? id;
  }

  private sameGroup(a: string | undefined, b: string | undefined): boolean {
    return a !== undefined && b !== undefined && this.group(a) === this.group(b);
  }

  /**
   * Alternatives (spec §7.7): distinct changes of the same task, i.e. best-of-N candidates.
   * At most one of them lands, so they never validate or arbitrate against each other's
   * in-flight work; a landed or reverted alternative is trunk and counts like any other.
   */
  private alternatives(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined || b === undefined || a === b) return false;
    const ta = this.changes.get(a)?.task;
    return ta !== undefined && ta === this.changes.get(b)?.task;
  }

  private members(lead: string): ChangeState[] {
    return [...this.changes.values()].filter((c) => this.group(c.id) === lead);
  }

  /**
   * The change an escalation from `from` targets: `with.change`, else the newest unlanded
   * change of `with.agent` outside `from`'s group. Undefined when there is none.
   */
  private escalationTarget(from: string, w: { agent?: string; change?: string }): string | undefined {
    if (w.change) return this.changes.has(w.change) ? w.change : undefined;
    const cands = [...this.changes.values()].filter((c) => c.agent === w.agent && !c.landed && !this.sameGroup(c.id, from));
    return cands.length ? cands[cands.length - 1]!.id : undefined;
  }

  /** Two groups conflict: an open error of `s` cites the target group, or keys overlap. */
  private groupsConflict(s: Session, target: string): boolean {
    const lead = this.group(target);
    for (const d of s.open.values()) {
      const c = this.record(d.caused_by_seq)?.change;
      if (c !== undefined && this.group(c) === lead) return true;
    }
    const now = this.now();
    const theirs = new Set<SymbolKey>();
    for (const m of this.members(lead)) for (const k of m.writes.keys()) theirs.add(k);
    for (const c of this.claims) if (this.group(c.change) === lead && c.source !== "predicted" && c.expires_at > now) theirs.add(c.key);
    for (const m of this.members(this.group(s.change))) {
      for (const k of m.reads) if (theirs.has(k)) return true;
      for (const k of m.writes.keys()) if (theirs.has(k)) return true;
    }
    return false;
  }

  private checkEscalation(s: Session, w: { agent?: string; change?: string }): string {
    const own = this.changes.get(s.change)!;
    const target = this.escalationTarget(s.change, w);
    if (!target) throw new WcpProtocolError("invalid_reference", "unknown escalation target (no unlanded change of that agent)", { with: w });
    const t = this.changes.get(target)!;
    if (this.sameGroup(target, s.change)) throw new WcpProtocolError("invalid_reference", `${target} is already merged with ${s.change}`);
    if (t.landed || own.landed) throw new WcpProtocolError("invalid_reference", "a landed change cannot be merged");
    if (!this.groupsConflict(s, target))
      throw new WcpProtocolError("invalid_reference", `nothing to escalate: ${s.change} and ${target} do not conflict`, { change: target });
    return target;
  }

  private knownTarget(to: { agent?: string; change?: string }): boolean {
    if (to.change) return this.changes.has(to.change);
    return [...this.changes.values()].some((c) => c.agent === to.agent);
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
    const c = this.changes.get(lead);
    return [-(c?.priority ?? 0), c?.birth ?? Number.MAX_SAFE_INTEGER, lead];
  }

  /** true when change a is senior to change b (higher priority, then older birth seq). */
  senior(a: string, b: string): boolean {
    const ra = this.rank(a);
    const rb = this.rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i]! < rb[i]!;
    return false;
  }

  private activeClaims(key: SymbolKey, exceptChange: string): Claim[] {
    const now = this.now();
    return this.claims.filter(
      (c) => c.key === key && !this.sameGroup(c.change, exceptChange) && !this.alternatives(c.change, exceptChange) && !c.shared.has(exceptChange) && c.expires_at > now,
    );
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
    const W = this.log.filter(
      (r) =>
        r.status === "accepted" &&
        r.seq > e.base_seq &&
        !this.sameGroup(r.change, s.change) &&
        (r.kind === "edit" || r.kind === "land" || r.kind === "revert") &&
        !(r.kind === "edit" && this.alternatives(r.change, s.change)),
    );
    const latest = (key: SymbolKey, pred: (r: EventRecord, w: Write) => boolean) => {
      for (let i = W.length - 1; i >= 0; i--) {
        const r = W[i]!;
        const w = r.writes.find((x) => x.key === key);
        if (w && pred(r, w)) return { r, w };
      }
      return undefined;
    };
    const cause = (r: EventRecord) => ({
      caused_by_seq: r.seq,
      caused_by_agent: r.agent ?? r.actor.id,
      ...(r.task ? { caused_by_task: r.task } : {}),
    });

    // R1 stale overwrite (edit only): a committed (landed/reverted) write since base.
    const r1 = new Set<SymbolKey>();
    if (e.kind === "edit") {
      for (const w of writes) {
        const hit = latest(w.key, (r) => r.kind === "land" || r.kind === "revert");
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
        const strong = latest(key, (_r, w) => STRONG.includes(w.kind));
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
        const body = latest(key, (_r, w) => w.kind === "body");
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
      const h = real.reduce((a, b) => (this.senior(b.change, a.change) ? b : a));
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
    const rec: EventRecord = {
      seq: this.head + 1,
      repo: this.repo,
      status: a.status,
      kind: a.kind,
      ts: new Date(this.now()).toISOString(),
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
    this.log.push(rec);
    return rec;
  }

  private sessionsOf(t: { agent?: string; change?: string }): Session[] {
    return [...this.sessions.values()].filter((s) => (t.change ? s.change === t.change : s.agent === t.agent));
  }

  private push(s: Session, item: Omit<InboxItem, "id">): void {
    s.inbox.push({ id: s.next_inbox_id++, ...item });
    if (item.diagnostic?.severity === "error") s.open.set(item.diagnostic.symbol, item.diagnostic);
  }

  private upsertClaim(c: Omit<Claim, "shared">): void {
    const existing = this.claims.find((x) => x.change === c.change && x.key === c.key);
    if (!existing) {
      this.claims.push({ ...c, shared: new Set() });
      return;
    }
    existing.seq = c.seq;
    existing.expires_at = Math.max(existing.expires_at, c.expires_at);
    if (c.source !== "edit" || existing.source === "predicted") existing.source = c.source;
    existing.firm = existing.firm || c.firm;
  }

  private touchesChange(c: ChangeState, key: SymbolKey): boolean {
    return c.reads.has(key) || c.writes.has(key) || this.claims.some((x) => x.change === c.id && x.key === key);
  }

  private applyAccepted(rec: EventRecord, s?: Session): void {
    const now = this.now();
    const change = rec.change ? this.changes.get(rec.change) : undefined;
    if (change && change.birth === undefined && rec.kind !== "join" && rec.kind !== "leave") change.birth = rec.seq;
    if (change && (rec.kind === "edit" || rec.kind === "intent")) {
      for (const k of rec.reads) change.reads.add(k);
      for (const w of rec.writes) change.writes.set(w.key, mergeWriteKind(change.writes.get(w.key), w.kind));
    }
    // Own open errors on touched keys are resolved by an accepted event.
    if (s) for (const k of [...rec.reads, ...rec.writes.map((w) => w.key)]) s.open.delete(k);
    // Any accepted event from a change keeps its non-predicted claims alive (§7.5).
    if (change && rec.actor.type === "agent")
      for (const c of this.claims) if (c.change === change.id && c.source !== "predicted") c.expires_at = Math.max(c.expires_at, now + this.claimTtl);

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
            this.claims = this.claims.filter((c) => !(wounded.includes(c.change) && c.key === d.symbol));
            for (const loser of wounded) {
              const la = this.changes.get(loser)!;
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
        this.claims = this.claims.filter((c) => !(c.change === rec.change && (!keys || keys.includes(c.key))));
        if (s && keys) for (const k of keys) s.open.delete(k);
        if (s && !keys) s.open.clear();
        break;
      }
      case "land": {
        // The landed change's claims go, and so do its alternatives' (§7.7): they lost.
        this.claims = this.claims.filter((c) => c.change !== rec.change && !this.alternatives(c.change, rec.change));
        if (change) change.landed = true;
        for (const cs of this.sessionsOf({ change: rec.change! })) cs.open.clear();
        break;
      }
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
            if (action === "pause") ts.paused_by = rec.seq;
            else delete ts.paused_by;
            this.push(ts, { seq: rec.seq, kind: "control", record: rec });
          }
        } else if (action === "approve" && target.change) {
          const c = this.changes.get(target.change);
          if (c) c.approved = true;
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
      for (const c of this.changes.values()) {
        if (c.id === rec.change || c.landed) continue;
        if (rec.kind === "edit" && this.alternatives(c.id, rec.change)) continue;
        const targets = this.sessionsOf({ change: c.id });
        if (!targets.length) continue;
        if (rec.kind !== "edit") {
          const hit = rec.writes.filter((w) => this.touchesChange(c, w.key));
          if (!hit.length) continue;
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

  /** negotiate.accept: apply transfer/share terms (spec §7.4). Returns the agreement. */
  private applyAgreement(rec: EventRecord) {
    const a = agreementOf(rec, (n) => this.record(n));
    if (!a) return undefined;
    // Direction is anchored at the root proposal: its author asks, the other party gives.
    const { root, terms, keys, asker, giver, askerAgent } = a;
    if (terms.kind === "transfer") {
      for (const c of this.claims) if (c.change === giver && keys.includes(c.key)) {
        c.change = asker;
        c.agent = askerAgent;
        if (root.task) c.task = root.task;
        else delete c.task;
      }
    } else if (terms.kind === "share") {
      for (const c of this.claims) {
        if (!keys.includes(c.key)) continue;
        if (c.change === giver) c.shared.add(asker);
        if (c.change === asker) c.shared.add(giver);
      }
    } else return a;
    for (const ss of [...this.sessionsOf({ change: giver }), ...this.sessionsOf({ change: asker })])
      for (const k of keys) ss.open.delete(k);
    return a;
  }

  /**
   * Merge the tasks of changes `a` and `b` (spec §7.6): the coordinator appends a system
   * `control merge` record naming the senior group's lead first. No-op when already merged
   * or either change landed.
   */
  private merge(a: string, b: string, cause: Seq, reason?: string): void {
    const ca = this.changes.get(a);
    const cb = this.changes.get(b);
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
    for (const c of this.changes.values()) if (this.group(c.id) === other) c.merged_into = lead;
    const leadChange = this.changes.get(lead);
    if (leadChange) delete leadChange.merged_into;
    const members = this.members(lead);
    for (const m of members)
      for (const ss of this.sessionsOf({ change: m.id })) {
        for (const [k, d] of [...ss.open]) {
          const c = this.record(d.caused_by_seq)?.change;
          if (c !== undefined && this.group(c) === lead) ss.open.delete(k);
        }
        this.push(ss, { seq: rec.seq, kind: "control", record: rec });
      }
  }

  // ---------------------------------------------------------------- inbox + gates

  private ack(s: Session, ack: number): void {
    s.inbox = s.inbox.filter((i) => i.id > ack);
  }

  drain(sid: string, ack?: number): InboxBatch {
    const s = this.session(sid);
    if (ack !== undefined) this.ack(s, ack);
    s.delivered_through = this.head;
    const items = [...s.inbox];
    const context = renderContext([], items);
    return {
      type: "inbox",
      items,
      head_seq: this.head,
      delivered_through: s.delivered_through,
      open_errors: [...s.open.values()],
      paused: s.paused_by !== undefined,
      ...(context ? { context } : {}),
    };
  }

  /** Negotiations the session still owes (spec §8.4). */
  private dues(s: Session): NegotiationDue[] {
    return negotiationDues({
      records: this.log.filter((r) => r.status === "accepted" && r.kind.startsWith("negotiate.")),
      me: { agent: s.agent, change: s.change },
      record: (n) => this.record(n),
      fulfilled: (giver, after, keys) =>
        this.log.some((r) => r.seq > after && r.status === "accepted" && r.kind === "edit" && r.change === giver && r.writes.some((w) => keys.includes(w.key))),
    });
  }

  gate(sid: string, g: Gate): GateResult {
    const s = this.session(sid);
    const open = [...s.open.values()];
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
        if (!this.changes.has(a.change)) throw new WcpProtocolError("invalid_reference", `unknown change ${a.change}`);
        draft = { kind: "control", base_seq: this.head, payload: { action: "approve", target: { change: a.change }, ...(a.note ? { reason: a.note } : {}) } };
        break;
      case "undo": {
        const target = a.seq !== undefined ? this.record(a.seq) : this.log.find((r) => r.kind === "land" && r.payload?.op_id === a.op_id);
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
        const cx = this.changes.get(x);
        const cy = this.changes.get(y);
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
   * validated against committed writes since its base (trunk CAS, §6.2 R1).
   */
  system(draft: EventDraft, actor: Actor = { type: "system", id: "coordinator" }): EventRecord {
    if (!SYSTEM_KINDS.has(draft.kind)) throw new WcpProtocolError("forbidden", `system may not submit ${draft.kind}`);
    const change = draft.change ? this.changes.get(draft.change) : undefined;
    if (draft.kind === "land" && !change) throw new WcpProtocolError("invalid_reference", `unknown change ${String(draft.change)}`);
    let d = draft;
    if (draft.kind === "land" && !draft.writes) d = { ...draft, writes: [...change!.writes].map(([key, kind]) => ({ key, kind })) };
    const diagnostics: Diagnostic[] = [];
    if (d.kind === "land") {
      for (const w of d.writes ?? []) {
        const hit = [...this.log]
          .reverse()
          .find((r) => r.status === "accepted" && r.seq > d.base_seq && r.change !== d.change && (r.kind === "land" || r.kind === "revert") && r.writes.some((x) => x.key === w.key));
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

  /** Expire claims and sessions (DO alarm in the real coordinator). Returns appended records. */
  tick(): EventRecord[] {
    const now = this.now();
    const out: EventRecord[] = [];
    const expired = this.claims.filter((c) => c.expires_at <= now);
    this.claims = this.claims.filter((c) => c.expires_at > now);
    const byChange = new Map<string, Claim[]>();
    for (const c of expired) byChange.set(c.change, [...(byChange.get(c.change) ?? []), c]);
    for (const [changeId, cs] of byChange) {
      const c = this.changes.get(changeId)!;
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
    for (const s of [...this.sessions.values()]) {
      if (s.last_seen + this.sessionTtl > now) continue;
      this.sessions.delete(s.id);
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

  // ---------------------------------------------------------------- observer

  /**
   * Paged log read (spec §9.3). Default: records with seq > after, ascending. `tail`: the
   * newest `limit` records. `before`: the `limit` records immediately preceding `before`
   * (scrollback). Results are always ascending by seq.
   */
  events(after = 0, limit = 100, opts: { include_diff?: boolean; tail?: boolean; before?: Seq } = {}): EventPage {
    const n = Math.min(Math.max(1, limit), this.limits.max_page);
    const end = opts.tail ? this.head : opts.before !== undefined ? Math.min(Math.max(opts.before - 1, 0), this.head) : undefined;
    const from = end !== undefined ? Math.max(0, end - n) : after;
    const slice = this.log.slice(from, end ?? after + n).map((r) => (opts.include_diff ? r : listView(r)));
    const last = slice.length ? slice[slice.length - 1]!.seq : after;
    return { type: "events", repo: this.repo, events: slice, head_seq: this.head, next_after: last, has_more: last < this.head };
  }

  event(seq: Seq): EventRecord {
    const r = this.record(seq);
    if (!r) throw new WcpProtocolError("not_found", `no event #${seq}`);
    return r;
  }

  summary() {
    const now = this.now();
    return {
      repo: this.repo,
      head_seq: this.head,
      active_agents: new Set([...this.sessions.values()].map((s) => s.agent)).size,
      active_changes: new Set([...this.sessions.values()].map((s) => s.change)).size,
      open_conflicts: [...this.sessions.values()].reduce((n, s) => n + s.open.size, 0),
      ...(this.log.length ? { last_event_at: this.log[this.log.length - 1]!.ts } : {}),
      policy: { arbitration: this.policy, escalation: this.escalation },
    };
  }

  /** Debug/test view of active claims. */
  claimsFor(key: SymbolKey): Array<{ change: string; firm: boolean; source: string }> {
    const now = this.now();
    return this.claims.filter((c) => c.key === key && c.expires_at > now).map((c) => ({ change: c.change, firm: c.firm, source: c.source }));
  }
}

/**
 * Net effect of two successive writes to one key within a change (spec §6.1): a symbol the
 * change introduced stays `new`; `deleted`/`signature` dominate `body`.
 */
export function mergeWriteKind(prev: WriteKind | undefined, next: WriteKind): WriteKind {
  if (!prev) return next;
  if (prev === "new") return next === "deleted" ? "deleted" : "new";
  if (next === "deleted") return "deleted";
  // Deleted then re-declared: relative to trunk the contract may differ — be conservative.
  if (prev === "deleted") return "signature";
  if (prev === "signature" || next === "signature") return "signature";
  return "body";
}

/** List view: omit diff, flag its presence (spec §9.3). */
export function listView(r: EventRecord): EventRecord {
  if (r.diff === undefined) return r;
  const { diff: _diff, ...rest } = r;
  return { ...rest, has_diff: true };
}
