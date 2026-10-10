# Weft Coordination Protocol (WCP) — version 0.1

**A coordination extension to [Agent Hooks Core v0.1](hooks-core-v0.md).**

Status: implementation draft, not a ratified standard (initial draft 2026-10-03; updated 2026-10-04). This document is normative for Weft's `packages/sequencer`, `apps/gateway`, `packages/adapters/*`, and observer clients. It does not require other implementations to adopt Weft's architecture or service choices.

Version 0.1 is the wire version sent in `WCP-Version`. Additions listed as compatible in the changelog preserve that version only when existing message meanings and required fields remain valid; incompatible changes require a new protocol version. An implementation MUST reject an unsupported major version rather than silently interpreting it.

Machine-readable artifacts (the spec wins if they disagree; file a bug):

| Artifact | Path |
|---|---|
| JSON Schema (draft 2020-12) | `packages/protocol/schema/wcp-v0.schema.json` (generated from `src/schema.ts`) |
| TypeScript types | `packages/protocol/src/types.ts` |
| Validators (Workers-safe, no `eval`) | `packages/protocol/src/validate.ts` |
| Reference coordinator (in-memory) | `packages/protocol/src/reference.ts` |
| Message fixtures | `packages/protocol/fixtures/messages/{valid,invalid}/*.json` |
| Behavioural scenarios | `packages/protocol/fixtures/scenarios/*.json` |
| Scenario runner | `packages/protocol/src/conformance.ts` |

### Relationship to Agent Hooks Core

[Agent Hooks Core](hooks-core-v0.md) (the *core*) is the minimal, transport-agnostic hook
interoperability layer: capability declaration (L0–L3), normalized lifecycle events, the
allow/advise/deny decision envelope, the diagnostic model, timeout/failure policy, security,
host mappings and a conformance suite. WCP builds on it and adds what coordination needs and
the core deliberately leaves out: one strictly ordered event log per repository, symbol-level
validation against everything that entered the log after the agent's base (§6), claim
arbitration and negotiation between agents (§7), and the observer/human API (§9).

- A WCP adapter **is** a core hook. `hello.capabilities` is the core capability declaration
  (core §3.2, same fields); the core's rules on levels and honest declaration (core §3.3) apply.
- WCP verdicts become core decisions at the hook points of §8.3: a rejecting `check` is a
  `deny` on `tool.pre`, `verdict.context`/`inbox.context` is an `advise` explanation, a
  refusing stop gate is a `deny` on `agent.stop`. A WCP `Diagnostic` is a profile of the core
  diagnostic (core §6.2).
- Implementing the core does not require WCP; implementing WCP requires the core semantics
  at the adapter's hook points.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as in
RFC 2119. "Coordinator" means the per-repo sequencer (a Durable Object in Weft's
implementation) together with the gateway that exposes it.

---

## 1. Overview

Agents change code through tool calls. WCP turns each of those tool calls into an
**event** in one strictly ordered log per repository, validates it against everything
that entered the log after the agent's **base**, and returns **diagnostics** — positioned,
explained, severity-graded, each citing the event that caused it — straight back into
the agent's run. Humans watch the same log as a **feed**.

```
 harness (Claude Code, Codex, ...)                 humans (Hérmes iOS, web)
   │ native hooks                                      │ observe / human scope
   ▼                                                   ▼
 adapter ──HTTPS/WS (agent scope)──►  coordinator  ◄──HTTPS/WS──  observer client
   ▲   verdicts, diagnostics, inbox   (one log/repo)
   │                                       ▲
 analyzer (diff → reads/writes)            │ system scope: landing queue, revert workflow
```

Roles and token scopes:

| Role | Scope | Can |
|---|---|---|
| Agent adapter | `agent` | open a session, submit events, drain its inbox, heartbeat, ask gates |
| Observer | `observe` | list repos, read/stream events, read the combined feed |
| Human | `human` (implies `observe`) | approve, undo, pause/resume, message an agent |
| System | `system` | append `land`, `revert`, `release`, `checkpoint`, `message` (landing queue, workflows, claim expiry, Artifacts push events, rebase bounces) |

## 2. Transport

### 2.1 HTTPS

- All endpoints live under the binding prefix `/v1` on the coordinator origin
  (Weft: `https://weft-gateway.elier.ai/v1`; locally `http://localhost:8787/v1`).
- Bodies are UTF-8 JSON, `Content-Type: application/json`. Every request and response
  body is one WCP message whose `type` field names it (exception: `EventRecord` and the
  system endpoint, which carry no `type`).
- Requests MUST send `WCP-Version: 0.1`. Responses MUST carry the coordinator's
  `WCP-Version`. See §10.
- A request whose body fails schema validation MUST be answered `400 invalid_message`
  with `details.issues` = `[{path, message}]` (JSON Pointer paths, as produced by
  `validate()`).
- Rejecting an event is **not** an HTTP error: `POST .../events` returns `200` with a
  `Verdict` whose `verdict` is `"reject"`. HTTP errors are reserved for protocol errors
  (§11).
- `POST .../events` SHOULD carry `Idempotency-Key: <opaque, ≤128 chars>`. A coordinator
  MUST return the original `Verdict` (and append nothing) for a repeated key within the
  same session for at least 24 h. Hooks are retried by harnesses; without this, one tool
  call can become two events.
- Limits are advertised in `welcome.limits`: `max_diff_bytes` (default 1 MiB),
  `max_keys` (reads + writes per event, default 2000), `max_page` (default 500).
  Exceeding them is `413 payload_too_large`.

### 2.2 WebSocket

Three socket endpoints exist (§8.6, §9.4, §9.5). Frames are text frames, one JSON
message per frame.

- Authentication: send `Authorization: Bearer <token>` on the upgrade request. Clients
  that cannot set upgrade headers (browsers) MUST instead send
  `{"type":"auth","token":"..."}` as the first frame within 10 s; the coordinator closes
  with `4401` otherwise.
- Requests over a socket MAY carry a client-chosen `id`; the coordinator's reply to that
  frame MUST carry `re` = that `id`. Unsolicited pushes carry no `re`.
- The coordinator sends `{"type":"ping","head_seq":n}` at least every 30 s on observer
  streams; clients SHOULD treat 75 s of silence as a dead socket and reconnect with
  resume (§9.4).
- Protocol errors that end a socket use close code `4000 + HTTP status` of the error
  code (§11), e.g. `4401` unauthorized, `4410` session expired. The close reason is the
  error code string.

## 3. Authentication and authorization

- Tokens are opaque bearer strings issued out of band by the gateway operator (v0 has
  no issuance endpoint). A token carries: scopes (§1), the repos it may access (or `*`),
  and for `agent` tokens the bound agent id (and optionally a change id).
- Agent tokens are **repo-scoped**: one token per (repo, agent). A `hello` whose
  `agent.id` (or `change`) differs from the token binding MUST be refused with
  `403 forbidden`.
- Observer tokens are read-only and MAY list several repos; they are distinct from
  agent tokens and MUST NOT be accepted on agent or human endpoints.
- `human` tokens imply `observe`. Human actions are attributed to the token's principal
  (`actor: {type:"human", id}`), never to a client-supplied name.
- A request for a repo outside the token's list is `404 repo_not_found` (do not leak
  existence). A missing/invalid token is `401 unauthorized`; a valid token lacking the
  scope is `403 forbidden`.
- Tokens MUST NOT appear in URLs, event payloads, diagnostics or logs.

## 4. Data model

### 4.1 Symbol keys and writes

A **symbol key** is `path#qualified.name`: repo-relative POSIX path, `#`, then the
dotted declaration path (`src/auth/session.ts#SessionStore.get`). Pattern:
`^[^#\s]+#[^#\s]+$`. Keys are produced by the adapter's analyzer (`@weft/analyzer`),
never by the coordinator; the coordinator treats them as opaque strings compared for
equality.

A **write** is `{key, kind}` with `kind`:

| kind | meaning | contract change? |
|---|---|---|
| `signature` | declaration's signature/exported shape changed | yes |
| `deleted` | declaration removed (renames are `deleted` + `new`) | yes |
| `body` | only the implementation changed | no |
| `new` | declaration introduced | no (nobody can depend on it yet) |

**Reads** are keys the event's code references (calls, imports, types).

### 4.2 Events

A client submits an **EventDraft**; the coordinator appends an **EventRecord**.

EventDraft (`$defs/EventDraft`): `kind`, `base_seq` (required); `task`, `change`,
`files[]`, `reads[]`, `writes[]`, `diff` (unified diff), `intent` (why, free text),
`summary_hint` (≤140), `payload` (kind-specific, below), `tool` (`{name, call_id,
harness_event}` — provenance), `transcript` (`{uri, offset}`).

EventRecord adds: `seq`, `repo`, `status` (`accepted`|`rejected`), `ts` (RFC 3339 UTC,
ms), `actor` (`{type: agent|human|system, id, harness?}`), `agent`, `session`, `mode`
(`check`|`commit` for agent submissions), `summary` (§6.4), `diagnostics[]`, and
`has_diff` in list views (§9.3). `files`, `reads`, `writes`, `diagnostics` are always
present (possibly empty).

| kind | emitted by | payload (`$defs/…Payload`) | validated by §6? |
|---|---|---|---|
| `intent` | agent | — | no |
| `edit` | agent | — (`writes` required, non-empty) | R0–R3 |
| `checkpoint` | agent, system | `{sha, ref?}` (a push of the change's fork; the system appends it when the Artifacts `pushed` event arrives, attributed to the change) | R0 (agent only) |
| `claim` | agent | `{firm, source: explicit\|predicted, ttl_ms?}`; keys in `writes` | R0, R3 |
| `release` | agent, system | `{keys?, reason?}`; no keys = all of the change's claims | no |
| `negotiate.propose` | agent | `{to: {agent?\|change?}, keys[], terms: {kind, text}}` | refs (§7.4) |
| `negotiate.counter` | agent | `{reply_to, terms}` | refs |
| `negotiate.accept` | agent | `{reply_to}` | refs |
| `negotiate.reject` | agent | `{reply_to, reason?}` | refs |
| `negotiate.escalate` | agent | `{with: {agent?\|change?}, keys?[], reason}` — ask the coordinator to merge the two tasks (§7.6) | refs + conflict (§7.6) |
| `message` | agent, human, system | `{to, text, intent?: steer\|negotiate\|info}` (system: a workflow bouncing a rebase conflict / failed presubmit / revert to the change's agent) | refs |
| `control` | human, coordinator (`merge` only) | `{action: pause\|resume\|approve\|undo\|merge, target, reason?, cause?}`; `merge`: `target.changes = [lead, joining]`, `cause` = the escalate/accept that triggered a coordinator merge | refs |
| `land` | system | `{sha, op_id, trunk_ref?}` | R1 (trunk CAS) |
| `revert` | system | `{op_id, reverts_seq\|reverts_op_id, sha?, reason, requested_by?}` | no |
| `join`, `leave` | coordinator | `{harness, level}` | no |

Agents MUST NOT submit `land`, `revert`, `control`, `join`, `leave` (`403 forbidden`).
Event `task`/`change`, when present on a draft, MUST equal the session's
(`400 invalid_message` otherwise); the coordinator always stamps the session's values.

### 4.3 Diagnostics

`{severity, code, file, range?, symbol, message, caused_by_seq, caused_by_agent,
caused_by_task?, suggestion?, arbitration?}`. `range` is LSP-style, 0-based
`{start:{line,character}, end:{…}}` and is filled by adapters that can locate the
symbol in the agent's checkout; the coordinator is position-agnostic. `caused_by_*`
always names the log event (or for claim conflicts, the holder's most recent claiming
event) that produced the diagnostic — every squiggle is traceable.

| code | severity | raised for | by rule |
|---|---|---|---|
| `stale_overwrite` | error | writing a symbol that landed/reverted on trunk after your base | R1 |
| `stale_assumption` | error | reading a symbol whose signature changed / that was deleted after your base | R2 |
| `stale_read` | warning | reading a symbol whose body changed after your base | R2 |
| `claim_wait` | warning (error if the holder's claim is firm) | writing into an area a senior change holds; you wait | R3 / §7 |
| `claim_die` | error | wait-die: a junior change writing into a senior change's area | R3 / §7 |
| `claim_wounded` | error (pushed to holders) | wound-wait: a senior change took your area | §7 |
| `claim_contended` | info | the other side of an arbitration (holder notified / wounder informed) | §7 |
| `claim_predicted_overlap` | info | overlap with a planner-predicted claim, or a predicted claim overlapping real work | §7.5 |
| `contract_changed` | warning (pushed) | someone changed the signature of / deleted a symbol your change reads, writes or claims | §6.3 |
| `trunk_advanced` | info (pushed) | a landing/revert touched symbols your change reads, writes or claims; `requires_rebase` | §6.3 |
| `agent_paused` | error | a human paused this agent; edits/claims/checkpoints are refused | R0 |

Receivers MUST treat an unknown code by its `severity` (§10).

### 4.4 Inbox items

`{id, seq, kind: diagnostic|negotiation|message|control|trunk, diagnostic?, record?,
requires_rebase?}`. `id` is per-session, strictly increasing from 1; `seq` is the log
event that produced the item.

## 5. Sequencing

### 5.1 The log

- The coordinator owns exactly one log per repo. `seq` starts at 1, increases by 1 per
  appended record, and has no gaps. Order is assigned by the coordinator only — never by
  client clocks.
- `ts` is the coordinator's clock at append and MUST be non-decreasing in `seq` (clamp
  if the clock steps back).
- Both accepted and rejected records occupy a seq. **Only accepted records have
  effects**: rejected records never enter any `W` set (§6.1), never create claims and
  never notify other agents. They exist so that observers see blocked edits and so that
  diagnostics can be cited.
- Records are immutable. Undo is a new record (`revert`). Replaying the log from seq 1
  through the reference rules MUST reproduce every verdict (the reference test
  `replays deterministically` checks this property for the reference coordinator).

### 5.2 `base_seq` and `delivered_through`

`base_seq` is the agent's claim: "my submission accounts for every relevant log record
up to and including this seq."

- Every `welcome`, `verdict` and `inbox` response carries `delivered_through` = the
  coordinator's `head_seq` at response time. After that response, every inbox item for
  records ≤ `delivered_through` has been delivered (inbox items are pushed at append
  time, so this holds by construction).
- A submission with `base_seq > delivered_through` (of that session) MUST be refused
  with `409 base_ahead` (`details.delivered_through`). An agent cannot claim to account
  for events it was never sent.
- Adapters MUST set `base_seq` to the last `delivered_through` they received **and
  passed to the model** (L1+ — injected via the harness; L0 — trivially, since nothing
  is injected, an L0 adapter uses `delivered_through` and relies on humans).
- Landings are special: an agent's checkout contains a `land` only after it rebased. An
  adapter that received a `trunk` item (`requires_rebase: true`) for seq `L` MUST keep
  `base_seq < L` until its workspace has been rebased onto a trunk containing `L`.
  Otherwise R1 could not catch the overwrite.

### 5.3 Check and commit

`Submit.mode`:

- `check` — validate a **proposed** edit before the harness applies it (L2 adapters,
  pre-tool hook). Pure: an accepting check appends nothing (`seq: null`) and has no side
  effects. A rejecting check MUST be appended as a `rejected` record with `mode:"check"`
  (the blocked edit is a feed-worthy fact) and its errors become open errors (§6.5).
- `commit` — record an edit that **happened** (post-tool hook / file watcher). Appended
  as `accepted` or `rejected`.

A check that passed does not reserve anything: another event may land between check
and commit, so the commit can still be rejected. In that case the edit exists in the
agent's workspace but not in the log; its errors stay open and the L3 gate (§8.4) keeps
the agent from finishing until it reworks.

### 5.4 Inbox delivery

Inbox delivery is at-least-once. Items stay in the session's inbox until acknowledged:
`inbox.drain {ack: n}` or `submit.inbox_ack = n` removes every item with `id ≤ n`; each
`verdict` and `inbox` response returns all remaining items. Adapters SHOULD ack the
highest id they injected into the model.

## 6. Validation (normative)

### 6.1 Definitions

For an incoming event E from session S (agent `a`, change `c`) with base `b`:

- **W** = accepted records with `seq > b`, `change ≠ c`, and `kind ∈ {edit, land, revert}`,
  minus the `edit` records of `c`'s alternatives (§7.7).
- **committed** records are `land` and `revert`; edits are **in flight**.
- A change's **writes** accumulate across its accepted edits per key with the net kind:
  `new` stays `new` (unless later `deleted`), `deleted` and `signature` dominate `body`,
  and `deleted` then re-declared counts as `signature` (`mergeWriteKind`). A `land`
  draft without `writes` lands exactly this map.
- **Active claims** on key k: claims with `expires_at > now`, held by a change other than
  `c` and not an alternative of `c` (§7.7), not shared with `c` (§7.4).
- **Seniority** (§7.1) orders changes.

### 6.2 Rules

Rules apply in this order; diagnostics are emitted in rule order, then in the order the
keys appear in E (`writes` for R1/R3, `reads` for R2).

- **R0 paused.** If S is paused (§9.6) and `E.kind ∈ {edit, claim, checkpoint}`: emit one
  `agent_paused` error caused by the pause `control` record; skip R1–R3.
- **R1 stale overwrite** (`edit`): for each write key k, if some committed record in W
  writes k, emit `stale_overwrite` (error) caused by the latest such record. Keys hit by
  R1 are skipped by R3.
- **R2 stale assumption / stale read** (`edit`): for each distinct read key k, take the
  records in W writing k. If any wrote k as `signature` or `deleted`, emit
  `stale_assumption` (error) caused by the latest of those. Else, if any wrote it as
  `body`, emit `stale_read` (warning) caused by the latest. `new` writes are ignored.
  Committed and in-flight writers are treated alike: an accepted signature change is a
  fact of the log, and the call site must be checked against it now.
- **R3 claim overlap** (`edit`, `claim`): for each write key k with active claims, apply
  arbitration (§7). Predicted claims never arbitrate (§7.5).
- `land` drafts (system) are checked with R1 only, against committed records in W: this
  is the trunk compare-and-swap; a rejected land MUST be retried after rebase. Under `conflicts: continue` the owner of the blocking change is also told (§8.4).
- Other kinds produce no diagnostics.

**Verdict:** `reject` iff at least one diagnostic for E has severity `error`; else
`accept`. Warnings and infos never reject.

### 6.3 Effects of an accepted record

Applied atomically with the append, in this order:

1. The change's `birth` is set to this seq if unset (excluding `join`/`leave`). Reads and
   writes of `edit`/`intent` are added to the change.
2. The submitting session's open errors for every key E reads or writes are cleared
   (§6.5).
3. Arbitration effects (§7.3): wounds revoke holders' claims and push `claim_wounded`;
   wait/die push `claim_contended` (info) to the holder.
4. Claims: each `edit` write key becomes (or refreshes) a **soft** claim of `c`
   (`expires_at = now + claim_ttl_ms`); `claim` events create explicit or predicted
   claims (`firm` from payload, TTL from `ttl_ms` or the default); `release` removes the
   listed (or all) claims of `c` and clears matching open errors; `land` removes all
   claims of the change and clears its sessions' open errors.
5. Routing: `negotiate.*` and `message` go to the addressee's sessions (§7.4, §7.6);
   `control` to the target agent's sessions (`merge`: every session of the merged group).
6. Broadcast, for `edit`, `land`, `revert`, to every other live, unlanded change whose
   reads, writes or active claims include a written key:
   - `land`/`revert`: one `trunk` item (`requires_rebase: true`) carrying a
     `trunk_advanced` info diagnostic;
   - any of the three, per write of kind `signature`/`deleted`: a `contract_changed`
     warning.

### 6.4 Human summary

Every record MUST carry `summary`: one line, ≤140 characters, readable without the
diff — what changed and why. Coordinators MUST generate it at append time; the reference
template is `summarize()` (`packages/protocol/src/summary.ts`), e.g.

- `claude-a changed signature of refreshToken in src/auth/session.ts — add a retry budget`
- `Blocked: codex-b edited fetchWithAuth in src/api/client.ts — retry 401s once`
- `codex-b → claude-a: proposes overload on refreshToken`
- `john paused codex-b` · `reverted #31: error spike after landing`

Template: `[Blocked: ]<who> <what>[ — <why>]`, `<why>` = `summary_hint` if given, else the
first line of `intent`; clipped to 140 with `…`. A coordinator MAY substitute a
model-written summary but MUST keep the length bound, the `Blocked:` prefix for
rejected records, and MUST NOT include secrets from the diff.

### 6.5 Open errors

Each session keeps a set of **open errors** keyed by symbol key: errors from its
rejected records (except `agent_paused`) and `claim_wounded` pushes. An entry is
cleared when the same session's change has an accepted event that reads or writes the
key, releases it, lands, or when a negotiated `transfer`/`share` on the key is accepted
(§7.4). Open errors drive the L3 gates (§8.4).

## 7. Arbitration (normative)

### 7.1 Seniority

Change X is **senior** to Y iff, comparing in order: higher task `priority` (from
`hello.task.priority`, default 0); then lower `birth` seq (a change with no accepted
event yet is youngest); then lexicographically smaller change id. Seniority is total
and stable, so every pair of conflicting changes resolves the same way every time — no
mutual retreat, no livelock.

### 7.2 Outcomes

For write key k in R3, let H be the most senior holder among the active non-predicted
claims on k, R the requester.

| policy (repo) | R senior to H | R junior to H |
|---|---|---|
| `wound-wait` (default) | **wound**: R proceeds (info `claim_contended` to R); every non-predicted holder of k is wounded | **wait**: R gets `claim_wait` — warning, or error if H's claim is firm |
| `wait-die` | **wait**: R gets `claim_wait` — warning, or error if H's claim is firm | **die**: R gets `claim_die` (error) |

Asymmetry guarantee: for one conflict exactly one party receives a warning/error; the
other receives at most an info. If R loses, H's inbox gets only `claim_contended`
(info) — and only if E was accepted. If R wins (wound), R gets only info and each
wounded holder gets `claim_wounded` (error).

`arbitration` on the diagnostic records `{policy, outcome, winner, loser, options}`;
`options` lists what the loser may do: `retreat` (rework without the area), `wait`
(until the winner lands or releases; not offered on `die`), `negotiate` (§7.4),
`escalate` (`negotiate.escalate`: the coordinator, or a human per repo policy, merges the
two tasks — §7.6).

### 7.3 Effects

- wound: the wounded holders' claims on k are removed; each wounded change's sessions
  get a `claim_wounded` error inbox item (and it is added to their open errors).
- wait (warning) on an accepted edit: both changes now hold soft claims on k; the senior
  one keeps winning future arbitrations.
- A rejected event has no arbitration effects.

### 7.4 Negotiation

- `negotiate.propose` is addressed by `payload.to` (`change` preferred, else `agent`);
  the target MUST be known to the repo (`422 invalid_reference`).
- `counter`, `accept`, `reject` MUST reference via `reply_to` an accepted `propose` or
  `counter` addressed to the replying session — a propose's addressee is `to`; a
  counter's addressee is the author of the record it replies to. Anything else is
  `422 invalid_reference`.
- The thread's **root** is the original propose; its `keys` scope the agreement. Terms
  of the accepted record (the propose or the latest counter) take effect on `accept`,
  directed by the root: its author is the **asker**, the other party the **giver**.
  - `transfer`: the giver's claims on the keys move to the asker.
  - `share`: asker and giver may both write the keys without arbitrating against each
    other (claims on those keys become mutually shared).
  - `overload`, `sequence`, `merge_tasks`, `other`: no coordinator effect; the
    agreement is recorded for both agents and for humans. (`overload` is the demo case:
    the owner keeps a compatible signature, after which the asker's R2 errors clear
    naturally on its next accepted edit.)
  - On `transfer`/`share`, both parties' open errors on the keys are cleared.
- Every negotiation record is delivered to its addressee's inbox (`kind:"negotiation"`).

### 7.5 Claims

- Sources: `edit` (implicit, soft), `explicit` (`claim` with `source:"explicit"`, may be
  `firm`), `predicted` (planner, never firm).
- TTL: `claim.ttl_ms` or `welcome.claim_ttl_ms` (default 30 min). Any accepted event or
  heartbeat from the change extends its non-predicted claims to `now + claim_ttl_ms`.
- Expiry: the coordinator MUST release expired claims by appending a `release` record
  (`actor.type:"system"`, `reason:"expired"`, one record per change) — claims never
  vanish silently. (Weft: DO alarm.)
- Predicted claims never cause arbitration in either direction: an overlap with a
  predicted claim, or a predicted claim overlapping real work, yields
  `claim_predicted_overlap` (info) only.

### 7.6 Escalation and merged tasks

The fourth loser option (`escalate`, §7.2) is a protocol action, not only a feed entry.

- `negotiate.escalate {with, keys?, reason}` names the other change (`with.change`, or
  `with.agent` = that agent's newest unlanded change outside the submitter's group). It is
  `422 invalid_reference` when the target is unknown, already in the submitter's group, either
  side has landed, or the two **do not conflict**: no open error of the submitting session is
  caused by a record of the target's group, and no key read or written by the submitter's
  group is written or claimed (non-predicted, unexpired) by the target's group.
- The record is delivered to the target change's sessions (`kind:"negotiation"`).
- Repo policy `escalation` (`welcome.policy.escalation`, default `auto`):
  - `auto`: the coordinator merges the two tasks at once by appending a `control merge`
    record (actor `{type:"system", id:"coordinator"}`, `cause` = the escalate's seq,
    `reason` = its reason).
  - `human`: nothing else happens; a human resolves it with the `merge` action (§9.6).
- Accepting `merge_tasks` terms (§7.4) has the same effect as an `auto` escalation (`cause` =
  the accept).
- **Merge effects** (`control merge`, `target.changes = [lead, joining]`, lead = the senior
  of the two groups' leads, §7.1): every change whose group lead is `joining` joins `lead`'s
  group. Within a group: W (§6.1) excludes all members' records (no R1/R2 between members),
  active claims of members never arbitrate against each other (R3), and a member's seniority
  is its lead's (§7.1). Open errors of members' sessions caused by records of other members
  are cleared. Every session of the group receives a `kind:"control"` inbox item with the
  record. Contract/trunk broadcasts (§6.3) still reach members, and each member still lands
  on its own (a landing workflow SHOULD land a group together).

### 7.7 Alternatives (best-of-N candidates)

Two distinct changes whose `task` is the same (and set) are **alternatives**: competing
candidates for one task, of which at most one lands (the platform's selection step). They
never coordinate with each other while in flight:

- W (§6.1) excludes the `edit` records of `c`'s alternatives, so R1/R2 never fire between
  candidates of one task (a candidate's signature change is not a stale assumption for its
  sibling, which may well choose a different signature).
- Claims of alternatives are not active claims for each other (no R3 arbitration, no
  `claim_wait`/`claim_wounded` between siblings).
- `contract_changed` broadcasts (§6.3) for an `edit` skip the editor's alternatives.
- `land` and `revert` records of an alternative are trunk like any other: they count in W
  for the remaining siblings and broadcast `trunk_advanced`/`contract_changed` to them.
- A `land` releases the claims of the landed change's alternatives too: they lost the
  selection, so their claims must not hold other tasks back until the TTL.

Alternatives are still distinct changes for everything else: seniority, negotiation, merge.
A merged group (§7.6) whose members carry the lead's task makes the lead's alternatives
alternatives of every member too.

## 8. Agent sessions and capability levels

### 8.1 Capability levels

Levels, the declaration object and the honesty rule are defined by the core (hooks-core-v0
§3); this section states what the coordinator relies on at each level.

| Level | Name | Adapter can | Coordinator relies on |
|---|---|---|---|
| L0 | observe | report edits after the fact (file watcher, async hook) | nothing — diagnostics reach humans only |
| L1 | inject | put model-visible text into the run after a tool call | diagnostics reach the model (immediately or at the next safe point) |
| L2 | block | deny a tool call before it runs, with a model-visible reason | `check` before every edit |
| L3 | gate | refuse the agent's stop (and/or intercept `git commit`) | open errors keep the agent working (default `hold`; under `conflicts: continue`, another agent's conflict does not hold the stop, §8.4) |

`hello.capabilities` = `{level, observe: sync|async, inject: immediate|delayed|false,
deny_edit, refuse_stop, commit_gate: native|tool_interception|false}`. Consistency
(enforced by the schema): L≥1 ⇒ `inject ≠ false`; L≥2 ⇒ `deny_edit = true` and
`observe = "sync"`; L3 ⇒ `refuse_stop = true`. A hook that runs asynchronously can never
provide L2/L3 for that hook point. Adapters MUST declare the level they actually
achieve on the installed harness version and SHOULD fail closed (declare lower) when a
required output field is rejected.

### 8.2 Session lifecycle

| Step | Endpoint | Message |
|---|---|---|
| open | `POST /v1/repos/{repo}/sessions` | `Hello` → `Welcome` (201). Appends `join`. `resume_session` reattaches to a live session (same agent) keeping its inbox. |
| submit | `POST /v1/repos/{repo}/sessions/{session}/events` | `Submit` → `Verdict` |
| drain | `POST /v1/repos/{repo}/sessions/{session}/inbox` | `InboxDrain` → `InboxBatch` |
| heartbeat | `POST /v1/repos/{repo}/sessions/{session}/heartbeat` | `Heartbeat` → `HeartbeatAck` |
| gate | `POST /v1/repos/{repo}/sessions/{session}/gate` | `Gate` → `GateResult` |
| close | `DELETE /v1/repos/{repo}/sessions/{session}` | optional `Bye` body → 204. Appends `leave`. |

- `hello.protocol` is `wcp/<major>.<minor>`; a different major is `400
  unsupported_version` with `details.supported`.
- The change id defaults to `<agent>/<task id|adhoc>`; adapters SHOULD pass the
  commit's `Change-Id` trailer value.
- Sessions expire after `session_ttl_ms` (default 5 min) without any request; the
  coordinator appends `leave` (system actor) and later calls get `410 session_expired`.
  Adapters SHOULD heartbeat every `heartbeat_interval_ms` (default 30 s) while the
  harness is alive, and re-`hello` with `resume_session` after a restart.
- A **new** session (not `resume_session`) starts with one `kind:"negotiation"` inbox item per
  negotiation its change still owes (§8.4), so an agent restarted after a proposal was sent
  to it still sees the proposal (or the agreement it has to fulfil).

### 8.3 What adapters do at each hook point

Core event names (hooks-core-v0 §4.1) in brackets; the decision the adapter returns follows
the arrow.

1. Session start [`session.start`] → `hello`; inject `welcome` + any inbox `context` →
   `advise` (L1).
2. Before an edit tool runs [`tool.pre`, kind `edit`/`write`/`delete`] (L2) → derive
   reads/writes from the proposed content (analyzer on before/after text), `submit`
   `mode:"check"`. On `reject` → `deny` with `verdict.context` as the explanation. On
   `accept` with warnings → `allow` (and inject the warnings at step 3) or `advise` where the
   host can carry pre-tool context.
3. After an edit tool ran [`tool.post`] → derive the real diff (`git diff` of touched files),
   submit `mode:"commit"`, inject `verdict.context` → `advise` (L1). Ack the inbox ids injected.
4. On user prompt / turn start [`prompt.submit`] → `drain` and inject → `advise` (L1).
5. Before stop [`agent.stop`] (L3) → `gate {gate:"stop"}`; if `allow` is false → `deny` with
   `reason`. Before a shell `git commit` [`tool.pre`, kind `shell`] (`commit_gate`) →
   `gate {gate:"commit"}` likewise.
6. Session end [`session.end`] → `bye`.

Coordinator unreachable: Weft adapters are fail-open (core §7.2, `on_failure: "open"`): they
answer `allow` (or `advise` that checks are offline) and never block a harness on Weft.

`verdict.context` / `inbox.context` is the deterministic rendering from
`renderContext()`:
`[weft error] stale_assumption src/api/client.ts:42:11: <message> (caused by claude-a ·
task T-1 · event #12). Suggestion: … Options: retreat | wait | negotiate | escalate.`
Adapters SHOULD inject it verbatim so squiggles look the same in every harness.

### 8.4 Gates

`gate.result.allow` is false iff the session has open errors (§6.5), or — for
`gate:"stop"` only — negotiations are **due**.

**Repo policy `conflicts`** (default `hold`, the behaviour above). It is a field of the repo's
config, set when the repo is created (`CoordinatorInit.conflicts`, validated by the gateway
registry as `hold` or `continue`). An absent field means `hold`, so existing configs are unchanged.
It is not read from the environment. It is recorded in the repo's config, so a journal replayed
with the same init reproduces every verdict exactly. With `continue`, open errors caused by
**another agent's change** (`caused_by_agent` differs from the session's agent) do not hold a
`gate:"stop"`: the agent may stop and finish its other work with them open, and the owner of the
causing change receives a `warning` diagnostic (never an error, so the owner is not blocked). A
rejected landing notifies the owner of the change that blocked it the same way. `gate:"commit"`
refuses on every open error in both modes, so a conflicting symbol cannot be committed while it
is open (see `ownership.ts`). Under `continue`, the diagnostics' suggestions say to keep working on
other tasks instead of rebasing or adapting to the other agent's change; under `hold` the
suggestions are unchanged from today. `reason` renders the blocking errors and dues, and
`gate.result.negotiations` lists the dues `{seq, due, record, keys}`:

- `due:"reply"`: an accepted `negotiate.propose`/`negotiate.counter` addressed to the session
  (§7.4) has no accepted `accept`/`reject`/`counter` replying to it;
- `due:"fulfil"`: an accepted `negotiate.accept` of `overload` terms whose giver is the
  session's change, with no accepted `edit` by that change writing one of the root's `keys`
  after the accepted propose/counter (the owner promised to keep the old signature working;
  making the overload first and accepting afterwards also fulfils it).

The commit gate ignores dues (an owner may commit before it answers). Exception: a paused
session (§9.6) is always allowed to stop. Harness runaway
guards (e.g. Copilot ends the turn after 8 consecutive stop blocks; Cursor `loop_limit`)
may override a refusal; the open errors then remain visible to humans in the feed.

### 8.5 Per-harness mapping

The host-level mapping (native event names and output fields per harness, with examples) is
now normative in the core (hooks-core-v0 §10). This table is the Weft adapters' view: what
each adapter does on its harness. From `docs/research/hooks.md` (official docs) plus local
probes (2026-10-03). Wire-level conformance of each adapter's hook command against the core
fixtures: `docs/standardization/reports/`.

| Harness | L0 observe | L1 inject | L2 deny edit | L3 gate | commit_gate | Verified locally |
|---|---|---|---|---|---|---|
| Claude Code | `PostToolUse` (`tool_input`, `tool_response`) | `PostToolUse` `hookSpecificOutput.additionalContext` | `PreToolUse` `permissionDecision:"deny"` + `permissionDecisionReason` | `Stop` `decision:"block"` + `reason` (`stop_hook_active` loop guard) | tool_interception (`PreToolUse` on Bash `git commit`) | **L0–L3 verified** (2.1.289) |
| OpenAI Codex | `PostToolUse`; edits arrive as `apply_patch` with the patch in `tool_input.command` | `PostToolUse` `additionalContext` | `PreToolUse` `permissionDecision:"deny"` (or legacy `decision:"block"`, or exit 2) | `Stop` `decision:"block"` → continuation prompt | tool_interception | L0 verified; L1–L3 documented (re-probe in B5) |
| Gemini CLI | `AfterTool` | `AfterTool` context / `BeforeAgent` | `BeforeTool` deny + reason | `AfterAgent` reject completion | tool_interception | documented only (fixture-only) |
| Cursor | `postToolUse`, `afterFileEdit` | `postToolUse` `additional_context` | `preToolUse` `permission:"deny"` | `stop` `followup_message` (bounded by `loop_limit`) | tool_interception | documented only |
| GitHub Copilot CLI | `postToolUse` | `postToolUse` `additionalContext` | `preToolUse` `permissionDecision:"deny"` + required reason | `agentStop` `decision:"block"` (8-block guard) | tool_interception | documented only |
| Cursor CLI (`@weft/adapter-cursor`) | `postToolUse`, `afterFileEdit` (dedup + before-text from edit records) | `postToolUse` `additional_context` | `preToolUse` `permission:"deny"` + `agent_message` | `stop` `followup_message` (`loop_limit` 5) | tool_interception | documented only (CLI login expired; fixture tests) |
| OpenCode (`@weft/adapter-opencode`, plugin) | `tool.execute.after` | text appended to the tool output; welcome via `experimental.chat.system.transform` | `throw` in `tool.execute.before` | `session.idle` → `client.session.prompt(reason)` (long-lived process only) | tool_interception | **L0–L3 verified** (1.18.31) |
| File watcher (`@weft/adapter-watcher`) | `fs.watch` + snapshot diff | — | — | — | `native` (git's own pre-commit hook) | **verified** (L0 by construction) |

No reviewed harness documents a native atomic commit hook. `commit_gate:"native"` means the
gate is git's own `pre-commit` hook rather than interception of the agent's shell tool; only
the L0 file watcher declares it, because that hook is the one gate it has (hook-based adapters
install the same git hook but declare their tool interception). `--no-verify` bypasses it. Asynchronous hook modes (Claude/Codex/Gemini `async: true`, Copilot
notifications) give L0 or delayed L1 only. Every L2 adapter must map the denial reason
into the harness's model-visible field; a deny without reason is non-conforming.

### 8.6 Agent WebSocket

`GET /v1/repos/{repo}/sessions/{session}/ws` (scope `agent`). The coordinator pushes an
`InboxBatch` frame whenever the session's inbox gains items. Clients MAY send `submit`,
`inbox.drain`, `heartbeat`, `gate` frames with an `id`; replies carry `re`. An open
agent socket counts as liveness (no heartbeat needed). Hook-based adapters normally use
HTTP only; the socket serves long-lived adapters and delayed-L1 injection.

## 9. Observer and human API

### 9.1 Endpoints

| Method + path | Scope | Returns |
|---|---|---|
| `GET /v1/repos` | observe | `RepoList` |
| `GET /v1/repos/{repo}/events` | observe | `EventPage` |
| `GET /v1/repos/{repo}/events/{seq}` | observe | `EventRecord` (full detail) |
| `GET /v1/repos/{repo}/stream?after={seq}` (WS) | observe | `StreamFrame`s |
| `GET /v1/feed` | observe | `FeedPage` |
| `GET /v1/feed/stream?after={cursor}` (WS, SHOULD) | observe | `StreamFrame`s across repos |
| `POST /v1/repos/{repo}/actions` | human | `HumanAction` → `ActionResult` |
| `POST /v1/repos/{repo}/system/events` | system | `EventDraft` → `EventRecord` |

### 9.2 `GET /v1/repos`

Repos visible to the token with live counts: `head_seq`, `active_agents` (agents with a
live session), `active_changes`, `open_conflicts` (total open errors across sessions),
`last_event_at`, `policy`.

### 9.3 Paged events

`GET /v1/repos/{repo}/events?after=&before=&tail=&limit=&include=diff&kind=&agent=&task=&change=&status=`

- Default: records with `seq > after` (default 0), ascending, at most `limit` (default
  100, max `max_page`).
- `tail=1`: the newest `limit` records (what a phone shows on open). `before=n`: the
  `limit` records immediately preceding seq n (scroll-back). Results are always
  ascending.
- `next_after` = the highest seq **examined** (so filtered paging never stalls);
  `has_more` = `next_after < head_seq` in `after` mode.
- List views omit `diff` and set `has_diff: true` when one exists; `include=diff`
  includes it. Everything else, including `summary`, `diagnostics`, `intent`, `reads`,
  `writes`, `transcript`, is always present.
- Filters (`kind`, `agent`, `task`, `change`, `status`; comma-separated) are applied
  server-side. A client implementing "only conflicts" uses `status=rejected` plus records
  whose `diagnostics` are non-empty (client-side).

`GET /v1/repos/{repo}/events/{seq}` returns the complete record: `diff`, `reads`,
`writes`, `diagnostics`, `intent`, `payload` (negotiation thread links via
`reply_to`), `tool`, `transcript` pointer. Unknown seq: `404 not_found`.

### 9.4 Stream with resume

`GET /v1/repos/{repo}/stream?after={seq}` upgrades to WebSocket. The coordinator MUST:

1. send every record with `seq > after` in order as `{"type":"event","event":…}`
   (list-view form), then
2. send `{"type":"replay.done","head_seq":n}`, then
3. send each new record as it is appended, and `ping` frames when idle.

Resume semantics are those of SSE `Last-Event-ID`: a client tracks the highest `seq` it
processed and reconnects with `after=` that value; it MUST de-duplicate by `seq`
(replay and live may overlap by design). Mobile clients drop sockets on background, so
reconnect-with-resume is the normal path, not an error path. A coordinator MAY cap a
single replay and instead close with `4413`; the client then pages via §9.3 and
reconnects.

### 9.5 Combined feed

`GET /v1/feed?after={cursor}&limit=&repos=a,b` merges all repos the token can see (or
the listed subset) into one change log ordered by `(ts, repo, seq)`. `tail=1` returns
the newest `limit` records overall with a cursor at every repo's head.

The **cursor** is a per-repo high-water mark vector so that resume is exact while repos
advance at different rates: `v0.` + base64url(JSON `{repo: seq}` with sorted keys)
(`encodeCursor`/`decodeCursor`). Clients MUST treat it as opaque and pass the last one
received. Repos absent from the cursor start at 0.

### 9.6 Human actions

`POST /v1/repos/{repo}/actions` with one of:

| action | body | appended record | effect |
|---|---|---|---|
| `approve` | `{change, task?, note?}` | `control {action:"approve", target:{change}}` | marks the candidate approved (landing workflows wait for it) |
| `undo` | `{seq \| op_id, reason}` — target MUST be a `land` | `control {action:"undo", target:{seq, op_id}}` | revert workflow performs it and appends `revert` with `requested_by` |
| `pause` / `resume` | `{agent, reason?}` | `control {action, target:{agent}}` | paused sessions get R0 errors on edits/claims/checkpoints; may stop freely |
| `message` | `{to, text, intent?: steer\|negotiate\|info}` | `message` | delivered to the target agent's inbox (steer = editor-free nudge) |
| `merge` | `{changes: [a, b], reason?}` | `control {action:"merge", target:{changes:[lead, joining]}}` (group leads, senior first) | merges the two tasks (§7.6); `422` if unknown, already merged or landed |

Unknown targets are `422 invalid_reference`. Every action is a log record with
`actor:{type:"human", id}` and a summary, so the feed shows who touched what.

## 10. Versioning and extensibility

- Protocol version `wcp/MAJOR.MINOR`, currently `wcp/0.1`. The HTTP binding prefix
  (`/v1`) changes only with a breaking transport change.
- Minor versions only add: optional fields, event kinds, diagnostic codes, payload
  fields, endpoints. Receivers MUST ignore unknown object fields (the schema never sets
  `additionalProperties:false`), MUST display unknown event kinds generically using
  `summary`, and MUST treat unknown diagnostic codes by `severity`.
- Major versions may change anything; a coordinator MAY serve several majors and
  advertises them in `unsupported_version.details.supported`.
- Vendor extensions use field names prefixed `x_`.
- While MAJOR is 0, breaking changes are allowed between minors but MUST be listed in a
  changelog section of this file.

## 11. Errors

Body: `{"type":"error","error":{"code","message","retryable","details?"}}`.

| code | HTTP | WS close | retryable | when |
|---|---|---|---|---|
| `invalid_message` | 400 | 4400 | no | schema failure, task/change mismatch |
| `unsupported_version` | 400 | 4400 | no | `hello.protocol` major not served |
| `unauthorized` | 401 | 4401 | no | missing/invalid token |
| `forbidden` | 403 | 4403 | no | scope missing; kind not allowed for the role; token binding mismatch |
| `repo_not_found` | 404 | 4404 | no | repo unknown or not visible to the token |
| `not_found` | 404 | 4404 | no | seq / resource unknown |
| `base_ahead` | 409 | 4409 | no (fix base) | `base_seq > delivered_through` |
| `session_expired` | 410 | 4410 | no (re-hello) | unknown/expired session |
| `payload_too_large` | 413 | 4413 | no | limits (§2.1); replay cap (§9.4) |
| `invalid_reference` | 422 | 4422 | no | bad `reply_to`, unknown target, bad undo target |
| `rate_limited` | 429 | 4429 | yes (`Retry-After`) | throttling |
| `internal` | 500 | 4500 | yes | coordinator bug |
| `unavailable` | 503 | 4503 | yes | coordinator overloaded / migrating |

`ERROR_STATUS` and `closeCode()` in `packages/protocol/src/errors.ts` are normative
copies of this table.

## 12. Conformance

An implementation conforms to WCP v0.1 if:

1. every message it emits validates against `wcp-v0.schema.json` and every message
   fixture in `fixtures/messages/valid` is accepted / every one in `invalid` is rejected
   (at the listed JSON Pointer);
2. driven through `runScenario()` (`ConformanceTarget`: `hello`, `submit`, `drain`,
   `gate`, `heartbeat`, `bye`, `action`, `system`, `tick`, `events`, `event`), it
   passes all `fixtures/scenarios/*.json`. Scenarios use a deterministic clock: each
   step advances 1 ms from `start`, `advance` steps add more; `tick` runs expiry (claims,
   sessions) and returns appended records.

Hook-level conformance (an adapter's hook command at its native wire, levels L0–L3) is
tested by the core's suite, not here: `packages/conformance` (hooks-core-v0 §11), which uses
this protocol's reference coordinator as its oracle.

Scenario coverage today: accept + observe/paging (`accept-and-observe`), R1
(`stale-overwrite`), R2 error + L2 check + gates (`signature-read-error`), R2 warning
(`body-read-warning`), wound-wait asymmetry + firm claims + multi-holder wound
(`arbitration-wound-wait`), wait-die (`arbitration-wait-die`), negotiation incl.
addressee checks, counter and transfer (`negotiation`), overload dues in the stop gate +
redelivery (`negotiation-overload-dues`), escalation and merged groups (`escalation-merge`,
`escalation-human`, `merge-by-agreement`), inbox redelivery/ack + base
rule + check logging (`inbox-and-base`), human actions (`human-actions`), claim TTL and
session expiry (`claim-ttl-and-session-expiry`), trunk notification + predicted claims
(`trunk-advanced-and-predicted`). The reference coordinator passes all of them and its
log replays deterministically.

## 13. Security considerations

- Diffs and intents can contain secrets the agent read. Coordinators SHOULD run a
  secret scanner on `diff` at append and redact matches in observer views; summaries
  MUST NOT quote diff content beyond symbol names.
- Observer tokens grant read access to code diffs; issue them per device, scope them to
  repos, and make them revocable.
- Human actions are powerful (undo lands a revert on trunk). Gateways SHOULD require a
  recent interactive login (Cloudflare Access) for `human` tokens.
- Rate-limit `check` submissions per session; they are cheap to send and expensive to
  evaluate on large W sets.

---

## Appendix A — the demo collision on the wire

```text
#1 join claude-a  #2 join codex-b
```

1. codex-b edits `fetchWithAuth`, which calls `refreshToken`:
   `submit {mode:"commit", event:{kind:"edit", base_seq:2, reads:["src/auth/session.ts#refreshToken"], writes:[{key:"src/api/client.ts#fetchWithAuth", kind:"body"}]}}`
   → `verdict {verdict:"accept", seq:3}`.
2. claude-a changes the signature of `refreshToken`:
   `submit {mode:"commit", event:{kind:"edit", base_seq:1, writes:[{key:"src/auth/session.ts#refreshToken", kind:"signature"}]}}`
   → `verdict {verdict:"accept", seq:4}`; codex-b's inbox gains
   `{id:1, seq:4, kind:"diagnostic", diagnostic:{severity:"warning", code:"contract_changed", …}}`.
3. codex-b's next pre-edit check, still on base 3:
   `submit {mode:"check", event:{kind:"edit", base_seq:3, reads:["…#refreshToken"], writes:[…]}}`
   → `verdict {verdict:"reject", mode:"check", seq:5, diagnostics:[{severity:"error", code:"stale_assumption", symbol:"src/auth/session.ts#refreshToken", caused_by_seq:4, caused_by_agent:"claude-a"}], inbox:[…contract_changed…], context:"[weft error] stale_assumption …"}`.
   The Claude Code / Codex adapter denies the tool call with `context` as the reason;
   the model reads it and re-plans. The feed shows
   `#5 Blocked: codex-b edited fetchWithAuth in src/api/client.ts`.
4. codex-b proposes an overload (`negotiate.propose`, seq 5→6…), claude-a accepts,
   restores a compatible overload; codex-b drains (base advances past 4) and its edit is
   accepted; its stop gate opens.

The full executable version is `fixtures/scenarios/signature-read-error.json` and
`negotiation.json`.

## Appendix B — refinements relative to docs/design.md §3–§5

Proposed for `docs/design.md` (rule 7 of agent-rules):

1. **Rejected records are logged** (with seq, `status:"rejected"`) but have no effects.
   Design §3 implied only accepted events get a seq; logging rejections makes conflicts
   visible in the feed ("only conflicts" filter) and citable.
2. **check vs commit.** Pre-edit validation (L2) is a pure `check` submission; the
   post-edit `commit` is what enters the log. Rejecting checks are logged.
3. **`base_seq ≤ delivered_through`** is enforced, and landings advance an agent's base
   only after rebase. This gives "since the agent's base" a precise meaning.
4. **In-flight overlaps are handled through claims**, not through W: every accepted edit
   creates a soft claim; R3 arbitrates claims. R1 errors only on committed writers, which
   matches principle 5 ("errors block only on committed facts or firm claims").
   R2 keeps design §4 literally (signature change ⇒ error even when in flight).
5. **Arbitration is fully specified** (seniority = priority, then birth seq; wound-wait
   default, wait-die selectable; multi-holder wound; predicted claims never arbitrate).
6. **New event kinds**: `message`, `control` (human actions), `join`/`leave` (presence),
   `negotiate.counter`; new diagnostic codes listed in §4.3.
7. Capability declaration adds the delivery-mode fields recommended by
   `docs/research/hooks.md` (`observe`, `inject`, `commit_gate`).

## Changelog

- 0.1 (2026-10-03): first draft.
- 0.1 additions (2026-10-04, B11; additive, no version bump): `negotiate.escalate` and merged
  task groups (§7.6), `welcome.policy.escalation`, `control merge` (human action and
  coordinator-appended), `control.cause`, negotiation dues in the stop gate
  (`gate.result.negotiations`, §8.4) and their redelivery to new sessions (§8.2). Scenarios
  `negotiation-overload-dues`, `escalation-merge`, `escalation-human`, `merge-by-agreement`.
- 0.1 addition (2026-10-04, M2; additive): alternatives (§7.7) — changes of the same task
  (best-of-N candidates) are exempt from in-flight R1/R2, claim arbitration and
  `contract_changed` between each other. Scenario `alternatives-best-of-n`.
- 0.1 editorial (2026-10-09): hook-level semantics split out into [Agent Hooks Core
  v0.1](hooks-core-v0.md); this document is now its coordination extension. §8.1/§8.3/§8.5
  reference the core (event names, decisions, host mappings); no wire or behaviour change.
