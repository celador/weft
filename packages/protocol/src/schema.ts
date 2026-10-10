// WCP v0 JSON Schema (draft 2020-12). Single source of truth for message shape.
// `schema/wcp-v0.schema.json` is generated from this object (see scripts/gen-schema.mjs);
// a test fails if the two drift.
//
// Forward compatibility: objects deliberately do NOT set additionalProperties:false.
// Receivers MUST ignore unknown fields (spec §10).

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonSchema = { [k: string]: Json };

const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const str: JsonSchema = { type: "string", minLength: 1 };
const seq: JsonSchema = { type: "integer", minimum: 0 };
const posSeq: JsonSchema = { type: "integer", minimum: 1 };
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
});
const arr = (items: JsonSchema, extra: JsonSchema = {}): JsonSchema => ({ type: "array", items, ...extra });
const enumOf = (...values: string[]): JsonSchema => ({ enum: values });
const typed = (type: string, properties: Record<string, JsonSchema>, required: string[] = []) =>
  obj({ type: { const: type }, ...properties }, ["type", ...required]);

const KINDS = [
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
];

const PAYLOAD_BY_KIND: Record<string, string> = {
  checkpoint: "CheckpointPayload",
  claim: "ClaimPayload",
  release: "ReleasePayload",
  "negotiate.propose": "ProposePayload",
  "negotiate.accept": "AcceptPayload",
  "negotiate.reject": "RejectPayload",
  "negotiate.counter": "CounterPayload",
  "negotiate.escalate": "EscalatePayload",
  land: "LandPayload",
  revert: "RevertPayload",
  message: "MessagePayload",
  control: "ControlPayload",
  join: "PresencePayload",
  leave: "PresencePayload",
};

/** if kind == K then payload is required and matches its schema. */
const payloadRules: JsonSchema[] = Object.entries(PAYLOAD_BY_KIND).map(([kind, def]) => ({
  if: { properties: { kind: { const: kind } }, required: ["kind"] },
  then: { properties: { payload: ref(def) }, required: ["payload"] },
}));
const editRule: JsonSchema = {
  if: { properties: { kind: { const: "edit" } }, required: ["kind"] },
  then: { required: ["writes"], properties: { writes: { type: "array", minItems: 1 } } },
};

const eventCore: Record<string, JsonSchema> = {
  kind: enumOf(...KINDS),
  base_seq: seq,
  task: str,
  change: str,
  files: arr({ type: "string", minLength: 1 }),
  reads: arr(ref("SymbolKey")),
  writes: arr(ref("Write")),
  diff: { type: "string" },
  intent: { type: "string" },
  payload: { type: "object" },
  tool: ref("ToolRef"),
  transcript: ref("TranscriptRef"),
};

const agentRef: JsonSchema = {
  ...obj({ agent: str, change: str }),
  anyOf: [{ required: ["agent"] }, { required: ["change"] }],
};

export const schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://weft.elier.ai/schema/wcp-v0.schema.json",
  title: "Weft Coordination Protocol v0",
  $defs: {
    Seq: seq,
    SymbolKey: { type: "string", pattern: "^[^#\\s]+#[^#\\s]+$", maxLength: 1024 },
    RepoId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    Timestamp: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
    },
    WriteKind: enumOf("signature", "body", "new", "deleted"),
    Write: obj({ key: ref("SymbolKey"), kind: ref("WriteKind") }, ["key", "kind"]),
    Position: obj({ line: seq, character: seq }, ["line", "character"]),
    Range: obj({ start: ref("Position"), end: ref("Position") }, ["start", "end"]),
    AgentRef: agentRef,
    RepoPolicy: obj(
      {
        arbitration: enumOf("wound-wait", "wait-die"),
        escalation: enumOf("auto", "human"),
        // Spec §7.5. Absent on repos created before the claims policy (legacy TTL rules).
        claims: obj({ lease_ms: { type: "integer", minimum: 1 }, firm_max_ms: { type: "integer", minimum: 1 } }, ["lease_ms", "firm_max_ms"]),
      },
      ["arbitration"],
    ),
    Arbitration: obj(
      {
        policy: enumOf("wound-wait", "wait-die"),
        outcome: enumOf("wait", "die", "wound", "none"),
        winner: obj({ agent: str, change: str }, ["agent", "change"]),
        loser: obj({ agent: str, change: str }, ["agent", "change"]),
        options: arr(enumOf("retreat", "wait", "negotiate", "escalate")),
      },
      ["policy", "outcome", "winner", "loser", "options"],
    ),
    Diagnostic: obj(
      {
        severity: enumOf("info", "warning", "error"),
        code: enumOf(
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
        ),
        file: { type: "string" },
        range: ref("Range"),
        symbol: { type: "string" },
        message: str,
        caused_by_seq: seq,
        caused_by_agent: str,
        caused_by_task: str,
        suggestion: { type: "string" },
        arbitration: ref("Arbitration"),
      },
      ["severity", "code", "file", "symbol", "message", "caused_by_seq", "caused_by_agent"],
    ),
    Actor: obj({ type: enumOf("agent", "human", "system"), id: str, harness: str }, ["type", "id"]),
    ToolRef: obj({ name: str, call_id: str, harness_event: str }, ["name"]),
    TranscriptRef: obj({ uri: str, offset: seq }, ["uri"]),
    NegotiationTerms: obj(
      { kind: enumOf("overload", "transfer", "share", "sequence", "merge_tasks", "other"), text: str },
      ["kind", "text"],
    ),
    ClaimPayload: obj(
      { firm: { type: "boolean" }, source: enumOf("explicit", "predicted"), ttl_ms: { type: "integer", minimum: 1 } },
      ["firm", "source"],
    ),
    ReleasePayload: obj({
      keys: arr(ref("SymbolKey")),
      reason: enumOf("done", "expired", "abandoned", "negotiated", "landed", "session_ended", "session_expired"),
    }),
    CheckpointPayload: obj({ sha: { type: "string", pattern: "^[0-9a-f]{7,64}$" }, ref: str }, ["sha"]),
    LandPayload: obj(
      { sha: { type: "string", pattern: "^[0-9a-f]{7,64}$" }, op_id: str, trunk_ref: str },
      ["sha", "op_id"],
    ),
    RevertPayload: {
      ...obj(
        {
          op_id: str,
          reverts_seq: posSeq,
          reverts_op_id: str,
          sha: { type: "string", pattern: "^[0-9a-f]{7,64}$" },
          reason: str,
          requested_by: ref("Actor"),
        },
        ["op_id", "reason"],
      ),
      anyOf: [{ required: ["reverts_seq"] }, { required: ["reverts_op_id"] }],
    },
    ProposePayload: obj(
      { to: ref("AgentRef"), keys: arr(ref("SymbolKey"), { minItems: 1 }), terms: ref("NegotiationTerms") },
      ["to", "keys", "terms"],
    ),
    CounterPayload: obj({ reply_to: posSeq, terms: ref("NegotiationTerms") }, ["reply_to", "terms"]),
    AcceptPayload: obj({ reply_to: posSeq }, ["reply_to"]),
    RejectPayload: obj({ reply_to: posSeq, reason: { type: "string" } }, ["reply_to"]),
    EscalatePayload: obj({ with: ref("AgentRef"), keys: arr(ref("SymbolKey")), reason: str }, ["with", "reason"]),
    MessagePayload: obj(
      { to: ref("AgentRef"), text: str, intent: enumOf("steer", "negotiate", "info") },
      ["to", "text"],
    ),
    ControlPayload: obj(
      {
        action: enumOf("pause", "resume", "approve", "undo", "merge"),
        target: obj({ agent: str, change: str, seq: posSeq, op_id: str, changes: arr(str, { minItems: 2, maxItems: 2 }) }),
        reason: { type: "string" },
        cause: posSeq,
      },
      ["action", "target"],
    ),
    PresencePayload: obj({ harness: str, level: { enum: [0, 1, 2, 3] } }, ["harness", "level"]),
    EventDraft: {
      ...obj({ ...eventCore, summary_hint: { type: "string", maxLength: 140 } }, ["kind", "base_seq"]),
      allOf: [editRule, ...payloadRules],
    },
    EventRecord: {
      ...obj(
        {
          ...eventCore,
          seq: posSeq,
          repo: ref("RepoId"),
          status: enumOf("accepted", "rejected"),
          ts: ref("Timestamp"),
          actor: ref("Actor"),
          agent: str,
          session: str,
          mode: enumOf("check", "commit"),
          has_diff: { type: "boolean" },
          summary: { type: "string", minLength: 1, maxLength: 140 },
          diagnostics: arr(ref("Diagnostic")),
        },
        ["seq", "repo", "status", "kind", "ts", "actor", "files", "reads", "writes", "summary", "diagnostics"],
      ),
      allOf: payloadRules,
    },
    Capabilities: {
      ...obj(
        {
          level: { enum: [0, 1, 2, 3] },
          observe: enumOf("sync", "async"),
          inject: { enum: ["immediate", "delayed", false] },
          deny_edit: { type: "boolean" },
          refuse_stop: { type: "boolean" },
          commit_gate: { enum: ["native", "tool_interception", false] },
        },
        ["level", "observe", "inject", "deny_edit", "refuse_stop", "commit_gate"],
      ),
      // Level consistency (spec §8.1).
      allOf: [
        {
          if: { properties: { level: { enum: [1, 2, 3] } } },
          then: { properties: { inject: { enum: ["immediate", "delayed"] } } },
        },
        {
          if: { properties: { level: { enum: [2, 3] } } },
          then: { properties: { deny_edit: { const: true }, observe: { const: "sync" } } },
        },
        { if: { properties: { level: { const: 3 } } }, then: { properties: { refuse_stop: { const: true } } } },
      ],
    },
    AgentInfo: obj({ id: str, harness: str, harness_version: str, model: str, adapter: str }, ["id", "harness"]),
    TaskRef: obj({ id: str, title: { type: "string" }, priority: { type: "integer" } }, ["id"]),
    InboxItem: obj(
      {
        id: posSeq,
        seq: seq,
        kind: enumOf("diagnostic", "negotiation", "message", "control", "trunk"),
        diagnostic: ref("Diagnostic"),
        record: ref("EventRecord"),
        requires_rebase: { type: "boolean" },
      },
      ["id", "seq", "kind"],
    ),
    Hello: typed(
      "hello",
      {
        protocol: { type: "string", pattern: "^wcp/\\d+\\.\\d+$" },
        agent: ref("AgentInfo"),
        capabilities: ref("Capabilities"),
        task: ref("TaskRef"),
        change: str,
        resume_session: str,
      },
      ["protocol", "agent", "capabilities"],
    ),
    Welcome: typed(
      "welcome",
      {
        protocol: { type: "string", pattern: "^wcp/\\d+\\.\\d+$" },
        session: str,
        repo: ref("RepoId"),
        head_seq: seq,
        delivered_through: seq,
        heartbeat_interval_ms: { type: "integer", minimum: 1 },
        session_ttl_ms: { type: "integer", minimum: 1 },
        claim_ttl_ms: { type: "integer", minimum: 1 },
        policy: ref("RepoPolicy"),
        limits: obj(
          {
            max_diff_bytes: { type: "integer", minimum: 1 },
            max_keys: { type: "integer", minimum: 1 },
            max_page: { type: "integer", minimum: 1 },
          },
          ["max_diff_bytes", "max_keys", "max_page"],
        ),
      },
      [
        "protocol",
        "session",
        "repo",
        "head_seq",
        "delivered_through",
        "heartbeat_interval_ms",
        "session_ttl_ms",
        "claim_ttl_ms",
        "policy",
        "limits",
      ],
    ),
    Submit: typed(
      "submit",
      { mode: enumOf("check", "commit"), event: ref("EventDraft"), inbox_ack: seq },
      ["mode", "event"],
    ),
    Verdict: typed(
      "verdict",
      {
        verdict: enumOf("accept", "reject"),
        mode: enumOf("check", "commit"),
        seq: { anyOf: [posSeq, { type: "null" }] },
        head_seq: seq,
        diagnostics: arr(ref("Diagnostic")),
        summary: { type: "string" },
        inbox: arr(ref("InboxItem")),
        delivered_through: seq,
        context: { type: "string" },
      },
      ["verdict", "mode", "seq", "head_seq", "diagnostics", "inbox", "delivered_through"],
    ),
    InboxDrain: typed("inbox.drain", { ack: seq }),
    InboxBatch: typed(
      "inbox",
      {
        items: arr(ref("InboxItem")),
        head_seq: seq,
        delivered_through: seq,
        open_errors: arr(ref("Diagnostic")),
        paused: { type: "boolean" },
        context: { type: "string" },
      },
      ["items", "head_seq", "delivered_through", "open_errors", "paused"],
    ),
    Heartbeat: typed("heartbeat", {}),
    HeartbeatAck: typed(
      "heartbeat.ack",
      { head_seq: seq, inbox_pending: seq, session_expires_at: ref("Timestamp") },
      ["head_seq", "inbox_pending", "session_expires_at"],
    ),
    Gate: typed("gate", { gate: enumOf("stop", "commit") }, ["gate"]),
    GateResult: typed(
      "gate.result",
      {
        gate: enumOf("stop", "commit"),
        allow: { type: "boolean" },
        reason: { type: "string" },
        open_errors: arr(ref("Diagnostic")),
        negotiations: arr(
          obj({ seq: posSeq, due: enumOf("reply", "fulfil"), record: ref("EventRecord"), keys: arr(ref("SymbolKey")) }, ["seq", "due", "record", "keys"]),
        ),
      },
      ["gate", "allow", "open_errors"],
    ),
    Bye: typed("bye", { reason: { type: "string" } }),
    RepoSummary: obj(
      {
        repo: ref("RepoId"),
        head_seq: seq,
        active_agents: seq,
        active_changes: seq,
        open_conflicts: seq,
        last_event_at: ref("Timestamp"),
        policy: ref("RepoPolicy"),
      },
      ["repo", "head_seq", "active_agents", "active_changes", "open_conflicts", "policy"],
    ),
    RepoList: typed("repos", { repos: arr(ref("RepoSummary")) }, ["repos"]),
    EventPage: typed(
      "events",
      {
        repo: ref("RepoId"),
        events: arr(ref("EventRecord")),
        head_seq: seq,
        next_after: seq,
        has_more: { type: "boolean" },
      },
      ["repo", "events", "head_seq", "next_after", "has_more"],
    ),
    FeedPage: typed(
      "feed",
      { events: arr(ref("EventRecord")), cursor: { type: "string" }, has_more: { type: "boolean" } },
      ["events", "cursor", "has_more"],
    ),
    StreamFrame: {
      oneOf: [
        typed("event", { event: ref("EventRecord") }, ["event"]),
        typed("replay.done", { head_seq: seq }, ["head_seq"]),
        typed("ping", { head_seq: seq }, ["head_seq"]),
      ],
    },
    HumanAction: {
      oneOf: [
        obj({ type: { const: "action" }, action: { const: "approve" }, change: str, task: str, note: { type: "string" } }, [
          "type",
          "action",
          "change",
        ]),
        {
          ...obj(
            { type: { const: "action" }, action: { const: "undo" }, seq: posSeq, op_id: str, reason: str },
            ["type", "action", "reason"],
          ),
          anyOf: [{ required: ["seq"] }, { required: ["op_id"] }],
        },
        obj({ type: { const: "action" }, action: enumOf("pause", "resume"), agent: str, reason: { type: "string" } }, [
          "type",
          "action",
          "agent",
        ]),
        obj(
          {
            type: { const: "action" },
            action: { const: "merge" },
            changes: arr(str, { minItems: 2, maxItems: 2 }),
            reason: { type: "string" },
          },
          ["type", "action", "changes"],
        ),
        obj(
          {
            type: { const: "action" },
            action: { const: "message" },
            to: ref("AgentRef"),
            text: str,
            intent: enumOf("steer", "negotiate", "info"),
          },
          ["type", "action", "to", "text"],
        ),
      ],
    },
    ActionResult: typed("action.result", { seq: posSeq, record: ref("EventRecord") }, ["seq", "record"]),
    WcpError: typed(
      "error",
      {
        error: obj(
          {
            code: enumOf(
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
            ),
            message: str,
            retryable: { type: "boolean" },
            details: { type: "object" },
          },
          ["code", "message", "retryable"],
        ),
      },
      ["error"],
    ),
  },
};
