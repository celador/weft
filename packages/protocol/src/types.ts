// WCP v0 wire types. Normative text: docs/protocol/wcp-v0.md.
// Every type here has a matching definition in ./schema.ts ($defs/<Name>).

/** Protocol revision carried in `hello.protocol` and the `WCP-Version` header. */
export const WCP_VERSION = "0.1" as const;
/** HTTP binding prefix. A breaking change to WCP bumps this prefix. */
export const HTTP_PREFIX = "/v1" as const;

export type Seq = number;
/** Symbol key: `path#qualified.name` (e.g. `src/auth/session.ts#refreshToken`). */
export type SymbolKey = string;
export type WriteKind = "signature" | "body" | "new" | "deleted";
export type Write = { key: SymbolKey; kind: WriteKind };

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };

export type Severity = "info" | "warning" | "error";

export const DIAGNOSTIC_CODES = [
  "stale_overwrite",
  "stale_assumption",
  "stale_read",
  "claim_wait",
  "claim_die",
  "claim_wounded",
  "claim_contended",
  "claim_predicted_overlap",
  "contract_changed",
  "trunk_advanced",
  "agent_paused",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type ArbitrationOutcome = "wait" | "die" | "wound" | "none";
export type Arbitration = {
  policy: ArbitrationPolicy;
  outcome: ArbitrationOutcome;
  /** The party that keeps the area. */
  winner: { agent: string; change: string };
  /** The party that must act (retreat, wait, negotiate, escalate). */
  loser: { agent: string; change: string };
  options: Array<"retreat" | "wait" | "negotiate" | "escalate">;
};

export type Diagnostic = {
  severity: Severity;
  code: DiagnosticCode;
  file: string;
  range?: Range;
  symbol: SymbolKey;
  message: string;
  caused_by_seq: Seq;
  caused_by_agent: string;
  caused_by_task?: string;
  suggestion?: string;
  arbitration?: Arbitration;
};

export const EVENT_KINDS = [
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
  "land",
  "revert",
  "message",
  "control",
  "join",
  "leave",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type ActorType = "agent" | "human" | "system";
export type Actor = { type: ActorType; id: string; harness?: string };

export type AgentRef = { agent?: string; change?: string };

export type NegotiationTerms = {
  kind: "overload" | "transfer" | "share" | "sequence" | "merge_tasks" | "other";
  text: string;
};

export type ClaimPayload = { firm: boolean; source: "explicit" | "predicted"; ttl_ms?: number };
export type ReleasePayload = {
  keys?: SymbolKey[];
  reason?: "done" | "expired" | "abandoned" | "negotiated" | "landed" | "session_ended" | "session_expired";
};
export type CheckpointPayload = { sha: string; ref?: string };
export type LandPayload = { sha: string; op_id: string; trunk_ref?: string };
export type RevertPayload = {
  op_id: string;
  reverts_seq?: Seq;
  reverts_op_id?: string;
  sha?: string;
  reason: string;
  requested_by?: Actor;
};
export type ProposePayload = { to: AgentRef; keys: SymbolKey[]; terms: NegotiationTerms };
export type CounterPayload = { reply_to: Seq; terms: NegotiationTerms };
export type AcceptPayload = { reply_to: Seq };
export type RejectPayload = { reply_to: Seq; reason?: string };
/**
 * The losing agent asks the coordinator to resolve a conflict with another change by
 * merging the two tasks (spec §7.6). `with` names the other change (or its agent).
 */
export type EscalatePayload = { with: AgentRef; keys?: SymbolKey[]; reason: string };
export type MessagePayload = { to: AgentRef; text: string; intent?: "steer" | "negotiate" | "info" };
export type ControlPayload = {
  action: "pause" | "resume" | "approve" | "undo" | "merge";
  /** `merge`: `changes` = the two changes whose tasks are merged (spec §7.6). */
  target: { agent?: string; change?: string; seq?: Seq; op_id?: string; changes?: string[] };
  reason?: string;
  /** `merge` appended by the coordinator: the escalate/accept record that caused it. */
  cause?: Seq;
};
export type PresencePayload = { harness: string; level: CapabilityLevel };

export type ToolRef = { name: string; call_id?: string; harness_event?: string };
export type TranscriptRef = { uri: string; offset?: number };

/** What a client submits. The coordinator turns it into an EventRecord. */
export type EventDraft = {
  kind: EventKind;
  base_seq: Seq;
  task?: string;
  change?: string;
  files?: string[];
  reads?: SymbolKey[];
  writes?: Write[];
  diff?: string;
  intent?: string;
  summary_hint?: string;
  payload?: Record<string, unknown>;
  tool?: ToolRef;
  transcript?: TranscriptRef;
};

export type RecordStatus = "accepted" | "rejected";

/** One entry of the per-repo log. `seq` is gapless and starts at 1. */
export type EventRecord = {
  seq: Seq;
  repo: string;
  status: RecordStatus;
  kind: EventKind;
  ts: string;
  actor: Actor;
  agent?: string;
  task?: string;
  change?: string;
  session?: string;
  base_seq?: Seq;
  mode?: SubmitMode;
  files: string[];
  reads: SymbolKey[];
  writes: Write[];
  diff?: string;
  /** Present (true) in list views when `diff` was omitted. */
  has_diff?: boolean;
  intent?: string;
  summary: string;
  diagnostics: Diagnostic[];
  payload?: Record<string, unknown>;
  tool?: ToolRef;
  transcript?: TranscriptRef;
};

export type CapabilityLevel = 0 | 1 | 2 | 3;
export type Capabilities = {
  level: CapabilityLevel;
  observe: "sync" | "async";
  inject: "immediate" | "delayed" | false;
  deny_edit: boolean;
  refuse_stop: boolean;
  commit_gate: "native" | "tool_interception" | false;
};

export type AgentInfo = {
  id: string;
  harness: string;
  harness_version?: string;
  model?: string;
  adapter?: string;
};

export type TaskRef = { id: string; title?: string; priority?: number };

// ---- agent session messages ----

export type Hello = {
  type: "hello";
  protocol: string;
  agent: AgentInfo;
  capabilities: Capabilities;
  task?: TaskRef;
  change?: string;
  resume_session?: string;
};

export type ArbitrationPolicy = "wound-wait" | "wait-die";
/** Who resolves `negotiate.escalate` (spec §7.6): the coordinator merges at once, or a human. */
export type EscalationPolicy = "auto" | "human";
/**
 * Claims policy (spec §7.5): soft claims are leases of `lease_ms`, renewed by activity;
 * firm claims end at most `firm_max_ms` after their claim event.
 */
export type ClaimsPolicy = { lease_ms: number; firm_max_ms: number };
export const DEFAULT_CLAIMS_POLICY: ClaimsPolicy = { lease_ms: 120_000, firm_max_ms: 600_000 };
/** Why `p` is not a valid claims policy, or undefined when it is. */
export function claimsPolicyError(p: unknown): string | undefined {
  if (!p || typeof p !== "object") return "claims must be an object {lease_ms, firm_max_ms}";
  const o = p as Record<string, unknown>;
  for (const k of ["lease_ms", "firm_max_ms"] as const) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return `claims.${k} must be a positive integer (ms)`;
  }
  return undefined;
}
/** `claims` is absent for repos created before the claims policy (legacy TTL rules). */
export type RepoPolicy = { arbitration: ArbitrationPolicy; escalation?: EscalationPolicy; claims?: ClaimsPolicy };

export type Welcome = {
  type: "welcome";
  protocol: string;
  session: string;
  repo: string;
  head_seq: Seq;
  delivered_through: Seq;
  heartbeat_interval_ms: number;
  session_ttl_ms: number;
  claim_ttl_ms: number;
  policy: RepoPolicy;
  limits: { max_diff_bytes: number; max_keys: number; max_page: number };
};

export type SubmitMode = "check" | "commit";
export type Submit = { type: "submit"; mode: SubmitMode; event: EventDraft; inbox_ack?: number };

export type InboxItem = {
  id: number;
  seq: Seq;
  kind: "diagnostic" | "negotiation" | "message" | "control" | "trunk";
  diagnostic?: Diagnostic;
  record?: EventRecord;
  requires_rebase?: boolean;
};

export type Verdict = {
  type: "verdict";
  verdict: "accept" | "reject";
  mode: SubmitMode;
  /** Assigned seq; null for an accepting check (nothing appended). */
  seq: Seq | null;
  head_seq: Seq;
  diagnostics: Diagnostic[];
  summary?: string;
  inbox: InboxItem[];
  delivered_through: Seq;
  /** Model-visible text the adapter SHOULD inject/deny with (L1/L2). */
  context?: string;
};

export type InboxDrain = { type: "inbox.drain"; ack?: number };
export type InboxBatch = {
  type: "inbox";
  items: InboxItem[];
  head_seq: Seq;
  delivered_through: Seq;
  open_errors: Diagnostic[];
  paused: boolean;
  context?: string;
};

export type Heartbeat = { type: "heartbeat" };
export type HeartbeatAck = {
  type: "heartbeat.ack";
  head_seq: Seq;
  inbox_pending: number;
  session_expires_at: string;
};

export type Gate = { type: "gate"; gate: "stop" | "commit" };
/**
 * A negotiation the session still owes (spec §8.4): `reply` = a proposal/counter addressed
 * to it is unanswered; `fulfil` = it accepted (or had accepted) an `overload` agreement as
 * the giver and has not yet made an accepted edit of the agreed keys.
 */
export type NegotiationDue = { seq: Seq; due: "reply" | "fulfil"; record: EventRecord; keys: SymbolKey[] };
export type GateResult = {
  type: "gate.result";
  gate: "stop" | "commit";
  allow: boolean;
  reason?: string;
  open_errors: Diagnostic[];
  /** Stop gate only; absent when nothing is due. */
  negotiations?: NegotiationDue[];
};

export type Bye = { type: "bye"; reason?: string };

// ---- observer + human ----

export type RepoSummary = {
  repo: string;
  head_seq: Seq;
  active_agents: number;
  active_changes: number;
  open_conflicts: number;
  last_event_at?: string;
  policy: RepoPolicy;
};
export type RepoList = { type: "repos"; repos: RepoSummary[] };

export type EventPage = {
  type: "events";
  repo: string;
  events: EventRecord[];
  head_seq: Seq;
  next_after: Seq;
  has_more: boolean;
};

export type FeedPage = {
  type: "feed";
  events: EventRecord[];
  cursor: string;
  has_more: boolean;
};

export type StreamFrame =
  | { type: "event"; event: EventRecord }
  | { type: "replay.done"; head_seq: Seq }
  | { type: "ping"; head_seq: Seq };

export type HumanAction =
  | { type: "action"; action: "approve"; change: string; task?: string; note?: string }
  | { type: "action"; action: "undo"; seq?: Seq; op_id?: string; reason: string }
  | { type: "action"; action: "pause" | "resume"; agent: string; reason?: string }
  | { type: "action"; action: "merge"; changes: [string, string]; reason?: string }
  | {
      type: "action";
      action: "message";
      to: AgentRef;
      text: string;
      intent?: "steer" | "negotiate" | "info";
    };

export type ActionResult = { type: "action.result"; seq: Seq; record: EventRecord };

export const ERROR_CODES = [
  "invalid_message",
  "unsupported_version",
  "unauthorized",
  "forbidden",
  "repo_not_found",
  "not_found",
  "session_expired",
  "base_ahead",
  "invalid_reference",
  "payload_too_large",
  "rate_limited",
  "internal",
  "unavailable",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type WcpError = {
  type: "error";
  error: { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> };
};

export type Scope = "agent" | "observe" | "human" | "system";

/** Name of every top-level message with a schema. */
export const MESSAGE_TYPES = [
  "Hello",
  "Welcome",
  "Submit",
  "Verdict",
  "InboxDrain",
  "InboxBatch",
  "Heartbeat",
  "HeartbeatAck",
  "Gate",
  "GateResult",
  "Bye",
  "RepoList",
  "EventPage",
  "FeedPage",
  "StreamFrame",
  "HumanAction",
  "ActionResult",
  "WcpError",
  "EventRecord",
  "EventDraft",
  "Diagnostic",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
