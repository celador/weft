# Agent Hooks Core — version 0.1 (draft)

Status: implementation draft for discussion (2026-10-09). Not a ratified or published standard.
Editor: Weft project. License: MIT.

This document defines a **minimal, transport-agnostic interoperability layer for coding-agent
hooks**: how a host (an agent runtime such as Claude Code, Codex, Cursor, Gemini CLI, OpenCode)
tells a hook what is happening, how the hook answers, and how both sides state what they can
actually do. It standardizes meaning and envelopes, not a plugin runtime or a server.

The [Weft Coordination Protocol](wcp-v0.md) (WCP) is a **coordination extension** built on this
core: it adds an ordered per-repository event log, symbol-level validation and arbitration
between agents. Nothing in this document requires WCP, a coordinator, a network, or a
particular vendor.

| Artifact | Path |
|---|---|
| Capability declaration type (shared with WCP) | `packages/protocol/src/types.ts` (`Capabilities`) and `schema/wcp-v0.schema.json` (`$defs/Capabilities`) |
| Core envelopes (events, decisions, diagnostics) | `packages/conformance/src/core.ts` |
| Host dialect codecs (native ⇄ core) | `packages/conformance/src/dialects.ts` |
| Conformance fixtures | `packages/conformance/fixtures/core/*.json` |
| Conformance runner (CLI) | `packages/conformance` (`wcp-hook-conformance`) |
| Reports for the Weft adapters | `docs/standardization/reports/` |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as in RFC 2119.

---

## 1. Problem and scope

Every major coding-agent runtime now exposes lifecycle and tool hooks, and the hook models
have converged in substance: a hook can observe a tool call, add text the model will read,
deny a tool call before it runs, and refuse to let the agent finish. They have not converged
on the wire: event names, payload shapes, output fields, timeout and failure behaviour, and
asynchronous modes all differ ([research matrix](../research/hooks.md)). A plugin that
"checks edits" is enforceable in one runtime and advisory in another, and nobody can tell
which without reading both runtimes' source.

Agent Plugins 1.0 standardizes how plugins are *packaged*; it deliberately leaves hooks out
because they "do not yet have consistent semantics or security models across clients". This
core is a proposal for exactly those semantics, at the smallest useful size:

**In scope:** capability declaration (§3), normalized lifecycle events (§4), the decision
envelope (§5), the diagnostic model (§6), timeout and failure policy (§7), a stdio binding for
command hooks (§8), security and privacy (§9), host mappings (§10), conformance (§11).

**Out of scope:** plugin packaging and discovery (Agent Plugins), tool invocation (MCP),
agent-to-agent messaging (A2A), permission UX, sandboxing, and anything a hook does with the
events (policy engines, coordination, audit) — those are extensions (§12).

## 2. Model

```
 host (agent runtime)                         hook (plugin side)
 ─────────────────────                        ──────────────────
 lifecycle point reached ── event ─────────►  inspects, may consult its own backend
 applies the answer      ◄─ decision ───────  allow | advise | deny  (+ explanation, diagnostics)
```

- **Host**: the agent runtime that owns the model loop and the tools.
- **Hook**: code the host invokes at a lifecycle point. It may be a command (§8), an
  in-process plugin function, or a remote endpoint; the semantics are the same.
- **Adapter**: a hook that translates a host's native hook wire to these semantics (e.g.
  `@weft/adapter-cursor`). A host that implements the core natively needs no adapter.
- **Binding**: a concrete wire for events and decisions. This document defines one binding
  (stdio, §8). In-process and HTTP bindings carry the same JSON objects.

One event produces exactly one decision. Events of one session are delivered in order; a host
MAY run hooks for different sessions, or for independent parallel tool calls of one session,
concurrently, and hooks MUST tolerate that (§7.4).

## 3. Capability declaration

### 3.1 Levels

Capabilities form a ladder. Each level includes the ones below it.

| Level | Name | The hook can | Host requirement |
|---|---|---|---|
| L0 | observe | see events (at least `tool.post` for edits) | deliver events; asynchronous delivery allowed |
| L1 | inject | put model-visible text into the run (`advise`) | deliver the explanation to the model, immediately or at the next safe point |
| L2 | block | deny a tool call before it runs, with a model-visible reason | synchronous `tool.pre`; the tool MUST NOT run on `deny`; the explanation MUST reach the model |
| L3 | gate | refuse the agent's completion (`agent.stop` → `deny`) | synchronous `agent.stop`; on `deny` the agent continues with the explanation as input |

A **commit gate** is declared separately because no reviewed host has a native atomic commit
hook: `"tool_interception"` (deny a shell tool call that runs `git commit`), `"native"` (git's
own `pre-commit` hook, bypassable with `--no-verify`), or `false`.

### 3.2 The declaration object

```json
{ "level": 2, "observe": "sync", "inject": "immediate", "deny_edit": true, "refuse_stop": false,
  "commit_gate": "tool_interception", "on_failure": "open" }
```

| Field | Type | Meaning |
|---|---|---|
| `level` | `0`–`3` | highest level delivered (§3.1) |
| `observe` | `"sync"` \| `"async"` | whether the host waits for the hook |
| `inject` | `"immediate"` \| `"delayed"` \| `false` | when advise text reaches the model |
| `deny_edit` | boolean | `tool.pre` deny is enforced for edit tools |
| `refuse_stop` | boolean | `agent.stop` deny is enforced |
| `commit_gate` | `"native"` \| `"tool_interception"` \| `false` | §3.1 |
| `on_failure` | `"open"` \| `"closed"` \| `"host"` | optional, §7.2; absent means `"open"` |

The first six fields are, field for field, WCP's `hello.capabilities` (`Capabilities` in
`packages/protocol/src/types.ts`); a WCP session's hello therefore *is* a core capability
declaration. `on_failure` is new in the core; WCP 0.1 messages do not carry it and receivers
ignore unknown fields.

Consistency rules (enforced by the WCP schema, normative here):

- `level ≥ 1` ⇒ `inject ≠ false`.
- `level ≥ 2` ⇒ `deny_edit = true` and `observe = "sync"`.
- `level = 3` ⇒ `refuse_stop = true`.
- A hook point delivered asynchronously can never provide L2 or L3 for that point.

### 3.3 Declare what you deliver

A hook (or adapter) MUST declare the level it actually achieves **on the installed host
version and in its current configuration**. Declaring a level above the one it delivers is
non-conformant; declaring below is allowed (e.g. pending live verification). In particular an
adapter configured to be advisory-only MUST NOT declare L2 or L3. When a host rejects an
output field the hook depends on, the hook SHOULD fail closed in its *declaration* (declare
lower) rather than silently lose enforcement.

Where the declaration travels is binding-specific: a WCP adapter sends it in `hello`; a
packaged plugin MAY carry it in its manifest (Appendix A); a conformance report records both
the declared and the verified level (§11).

## 4. Normalized lifecycle events

### 4.1 Event names

| Core event | When | Decisions that matter |
|---|---|---|
| `session.start` | a session starts or resumes | `advise` (welcome/context) |
| `prompt.submit` | a user prompt is about to start a turn | `advise`; `deny` MAY block the prompt |
| `tool.pre` | before a tool call runs | `allow`, `advise`, `deny` (L2) |
| `tool.post` | after a tool call ran | `advise` (L1); a `deny` here is treated as `advise` |
| `agent.stop` | the agent is about to end its turn/task | `deny` refuses completion (L3) |
| `session.end` | the session ends | none (informational; hosts MAY not wait) |

Hosts MAY offer more events; hooks MUST answer events they do not understand with `allow`.

### 4.2 Event envelope

```json
{
  "hooks": "0.1",
  "event": "tool.pre",
  "id": "evt-7f3a",
  "session": "ses_42",
  "cwd": "/work/checkout",
  "harness": { "name": "codex", "version": "0.154.0" },
  "tool": { "kind": "edit", "name": "apply_patch", "call_id": "call_9",
            "path": "src/cart.ts", "old_text": "  return `${items.length} items`;",
            "new_text": "  return `${items.length} items, total ${calcTotal(items)}`;" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `hooks` | yes | core version, `"0.1"` |
| `event` | yes | §4.1 |
| `id` | yes | unique per invocation; the decision echoes it as `reply_to` |
| `session` | yes | stable for the life of one host session; resumed sessions SHOULD keep it |
| `cwd` | yes | absolute workspace path the tools act on |
| `harness` | no | host name and version (informative) |
| `tool` | `tool.*` | §4.3 |
| `prompt` | `prompt.submit` | the prompt text (untrusted, §9) |
| `stop` | `agent.stop` | `{ "repeat": n }` — consecutive refusals of this stop so far (loop guards, §5.4) |
| `reason` | `session.end` | why the session ended |

### 4.3 Tools

Hosts name tools differently (`Edit`, `apply_patch`, `replace`, `edit_file`, `edit`). The core
normalizes each call to a **kind** and, where the host's payload allows, to explicit fields:

| `kind` | Fields | Meaning |
|---|---|---|
| `edit` | `path`, `old_text`, `new_text` | replace exact text in one file |
| `write` | `path`, `content` | create or overwrite a whole file |
| `delete` | `path` | remove a file |
| `shell` | `command` | run a command line |
| `read` | `path` | read-only access |
| `other` | — | anything else (MCP tools, web, sub-agents) |

- `call_id` is REQUIRED on `tool.*` and MUST pair a `tool.pre` with its `tool.post`. Hosts that
  have no call id (Gemini CLI) MUST let the adapter derive a stable one.
- `name` carries the native tool name; hooks MUST NOT depend on it for core semantics.
- `output` (on `tool.post`) is what the model will see as the tool result. It is untrusted.
- Edit fields are **derived** by the host or adapter from tool-specific input (a Codex
  `apply_patch` body, an OpenCode `{filePath, oldString, newString}`); no reviewed host
  guarantees a normalized diff. Fields that cannot be derived MUST be omitted, never guessed.
  A hook that needs the post-edit truth SHOULD read the workspace at `tool.post`.
- A multi-file tool call (an `apply_patch` touching three files) MAY be presented as one
  event per file with call ids `call_9#0`, `call_9#1`, … ; the host applies the most
  restrictive of their decisions (§5.3).

## 5. Decision envelope

### 5.1 Shape

```json
{ "hooks": "0.1", "decision": "deny", "reply_to": "evt-7f3a",
  "explanation": "[weft error] stale_assumption src/cart.ts:4:42: You use src/pricing.ts#calcTotal, whose signature changed in event #3 by claude-a after your base. Options: retreat | wait | negotiate | escalate.",
  "diagnostics": [ { "severity": "error", "code": "stale_assumption", "message": "…",
                     "source": "weft", "resource": { "path": "src/cart.ts", "symbol": "src/pricing.ts#calcTotal" },
                     "caused_by": { "ref": "wcp:demo#3", "actor": "claude-a" } } ] }
```

| Field | Required | Meaning |
|---|---|---|
| `hooks` | yes | `"0.1"` |
| `decision` | yes | `allow` \| `advise` \| `deny` |
| `explanation` | for `advise` and `deny` | model-visible text: the context for `advise`, the reason for `deny` |
| `diagnostics` | no | structured findings (§6) |
| `reply_to` | SHOULD | the event `id` |

### 5.2 Meanings

- **`allow`** — proceed; nothing for the model. An empty answer in a native dialect means `allow`.
- **`advise`** — proceed, and the host MUST deliver `explanation` to the model (L1): with the
  tool result for `tool.post`, as added context for `session.start`/`prompt.submit`, and for an
  allowed `tool.pre` either alongside the call or at the next `tool.post` (hosts without a
  pre-tool context field: Cursor, Gemini CLI, OpenCode).
- **`deny`** — do not proceed. On `tool.pre` the tool MUST NOT run and the explanation MUST
  reach the model as the tool's result or error, so the model can repair the call (L2). On
  `agent.stop` the agent MUST continue and receive the explanation as its next input (L3). On
  `prompt.submit` the host MAY refuse the prompt. On `tool.post` the tool already ran, so a
  `deny` MUST be treated as `advise`.

A `deny` or `advise` without an explanation is non-conformant: a model that is stopped
without a reason cannot recover.

### 5.3 Several hooks on one event

When several hooks answer one event the host combines them: `deny` if any denies, else
`advise` if any advises, else `allow`; explanations are concatenated in hook order. A host
MAY run the hooks concurrently; ordering of side effects across hooks is not defined.

### 5.4 Gates and loop guards

A refused `agent.stop` starts another model turn, so a hook that never relents can loop.
Hosts SHOULD bound consecutive refusals (Cursor `loop_limit`, Copilot's 8-block guard) and
MUST tell the hook how many there were (`stop.repeat`, native `stop_hook_active` or
`loop_count`). Hooks SHOULD stop refusing after a bounded number of identical refusals and
leave the problem visible to humans instead. When a host overrides a refusal, the failure is
the host's to report, not silently the hook's.

## 6. Diagnostics

### 6.1 Shape

| Field | Required | Meaning |
|---|---|---|
| `severity` | yes | `error` \| `warning` \| `info` |
| `code` | yes | stable machine code, namespaced by `source` |
| `message` | yes | one human/model-readable sentence |
| `source` | SHOULD | who produced it (`weft`, `policy-x`) |
| `resource` | no | `{ path?, symbol?, range? }`; `range` is LSP-style, 0-based |
| `caused_by` | SHOULD when a cause exists | `{ ref, actor? }` — an opaque reference to the event or record that caused it, and who made it |
| `suggestion` | no | how to fix it |

Rules: a decision's verdict follows from its diagnostics — a hook that returns an `error`
diagnostic on `tool.pre` SHOULD deny (or advise, if it is advisory, §3.3); warnings and infos
never deny. Receivers MUST treat unknown codes by their `severity`. The `explanation` SHOULD be
a deterministic rendering of the diagnostics so the same finding reads the same in every host.

### 6.2 WCP's Diagnostic is a profile of this shape

| Core | WCP `Diagnostic` |
|---|---|
| `severity` | `severity` |
| `code` | `code` (`stale_assumption`, `claim_wait`, … — wcp-v0 §4.3) |
| `message`, `suggestion` | `message`, `suggestion` |
| `source` | implicit `"weft"` |
| `resource.path` / `.symbol` / `.range` | `file` / `symbol` / `range` |
| `caused_by.ref` / `.actor` | `caused_by_seq` (log seq) / `caused_by_agent` (+ `caused_by_task`) |
| — | `arbitration` (extension field) |

`renderContext()` in `packages/protocol/src/context.ts` is WCP's deterministic rendering.

## 7. Timeouts and failure

### 7.1 Budgets

Every invocation has a host budget (defaults: Claude Code and Codex command hooks 600 s,
Codex `SessionEnd` 1 s, Gemini CLI 60 s, Cursor 30 s, Copilot 30 s). A hook MUST answer within
the host budget and SHOULD keep its own, much smaller budget for anything it calls (Weft
adapters: 8 s per coordinator call, p50 under 150 ms per hook in the conformance reports).
Hooks on `tool.pre` and `agent.stop` add latency to every tool call and every turn; they
SHOULD do expensive work after answering, or at `tool.post`.

### 7.2 Failure policy

When the hook cannot reach a decision (its backend is down, it timed out internally, it
crashed), the result is defined by its declared `on_failure`:

- `"open"` (default) — answer `allow` (MAY `advise` that checks are offline). Enforcement is
  lost, the agent keeps working. Weft adapters are fail-open.
- `"closed"` — answer `deny` with an explanation on `tool.pre` and `agent.stop`. Enforcement
  is kept, the agent stops making progress.
- `"host"` — answer nothing usable and let the host's own failure handling decide.

A hook MUST produce **valid output for its binding** in every case: some hosts treat invalid
output from a permission hook as a block (Cursor), others as allow, so malformed output
silently turns into a policy nobody chose.

### 7.3 Robustness

A hook MUST NOT crash the host on malformed or unexpected input, MUST answer unknown events
and unknown tools with `allow`, and MUST NOT write anything but its answer to stdout (§8).

### 7.4 Retries, duplicates, concurrency

Hosts retry hooks and run matching hooks concurrently. A hook with side effects SHOULD key
them by (`session`, `call_id`, `event`) so that a retried `tool.post` does not record an
edit twice (WCP: `Idempotency-Key`, wcp-v0 §2.1), and SHOULD serialize per-session state.

## 8. Stdio binding (command hooks)

The binding every reviewed command-hook host already uses, with core envelopes:

- The host starts the command once per event with `cwd` = the workspace, writes the event
  (§4.2) as one JSON object to stdin and closes it.
- The command writes one decision (§5.1) as one JSON object to stdout and exits 0. Anything
  for humans goes to stderr.
- Exit status other than 0 or missing/invalid stdout is a hook failure (§7.2).
- The host kills the command at its budget (§7.1) and treats that as a failure.

```sh
$ echo '{"hooks":"0.1","event":"agent.stop","id":"e9","session":"s1","cwd":"/w","stop":{"repeat":0}}' | my-hook
{"hooks":"0.1","decision":"deny","reply_to":"e9","explanation":"1 open error: src/cart.ts uses calcTotal's old signature (event #3)."}
```

`wcp-hook-conformance bridge --dialect <host> -- <native hook>` wraps any native hook of a
known host into this binding; the core-binding report in `docs/standardization/reports/` is
produced through it.

## 9. Security and privacy

- **Least context.** Hosts SHOULD send only the fields in §4; hooks MUST NOT require
  credentials, environment dumps or full transcripts to function. Transcript access, where a
  host offers it, is by reference and opt-in.
- **No implicit secrets.** Tokens a hook uses for its own backend MUST NOT appear in events,
  decisions, diagnostics, explanations or logs. Explanations SHOULD quote identifiers
  (paths, symbols, event references), not file contents beyond what the model already saw.
- **Untrusted input.** `tool.output`, `prompt`, file contents and anything another principal
  wrote (another agent's intent text, a reviewer's comment) are untrusted. A hook that
  forwards such text into an `explanation` is injecting it into a model: it SHOULD delimit and
  label it, and SHOULD prefer structured diagnostics to free text.
- **Explanations are prompts.** Whatever a hook returns as `explanation` is read by a model
  with the agent's tool permissions. Hosts SHOULD show users which hook produced injected text.
- **Retention.** A hook that records events (audit, coordination) MUST document what it keeps
  (diffs, prompts, outputs), for how long, who can read it, and how secrets are redacted
  (WCP coordinators SHOULD scan diffs and redact matches in observer views, wcp-v0 §13).
- **Enforcement is advisory against a hostile agent.** L2/L3 constrain a cooperative agent's
  tool path; they are not a sandbox. Commits made outside the tool path, `--no-verify`, and
  tools the host does not route through hooks bypass them.

## 10. Host mappings

How each host spells the core today. "Verified" = exercised live against the harness;
"documented" = from official docs only. Every row is exercised at the wire by the conformance
reports (§11), which is a different claim from live verification.

### 10.1 Events and decisions

| Core | Claude Code | OpenAI Codex | Cursor | Gemini CLI | OpenCode (plugin) | GitHub Copilot |
|---|---|---|---|---|---|---|
| `session.start` | `SessionStart` → `additionalContext` | `SessionStart` | `sessionStart` → `additional_context` | `SessionStart` → `additionalContext` | `experimental.chat.system.transform` | `sessionStart` |
| `prompt.submit` | `UserPromptSubmit` | `UserPromptSubmit` | `beforeSubmitPrompt` | `BeforeAgent` | — | `userPromptSubmitted` |
| `tool.pre` deny | `PreToolUse` `permissionDecision:"deny"` + `permissionDecisionReason` (or exit 2 + stderr) | `PreToolUse` same fields (legacy `decision:"block"`) | `preToolUse` `permission:"deny"` + `agent_message` | `BeforeTool` `decision:"deny"` + `reason` | `throw new Error(reason)` in `tool.execute.before` | `preToolUse` `permissionDecision:"deny"` + required reason |
| `tool.post` advise | `PostToolUse` `additionalContext` | `PostToolUse` `additionalContext` | `postToolUse` `additional_context` | `AfterTool` `additionalContext` | append to `output.output` in `tool.execute.after` | `postToolUse` `additionalContext` |
| `agent.stop` deny | `Stop` `decision:"block"` + `reason` (`stop_hook_active`) | `Stop` `decision:"block"` → continuation prompt | `stop` `followup_message` (`loop_limit`) | `AfterAgent` `decision:"deny"` + `reason` | `session.idle` → `client.session.prompt(reason)` (long-lived process only) | `agentStop` `decision:"block"` (8-block guard) |
| `session.end` | `SessionEnd` | `SessionEnd` (1 s budget) | `sessionEnd` | `SessionEnd` (not awaited) | `session.deleted` | `sessionEnd` |
| edit tools | `Edit`, `MultiEdit`, `Write` | `apply_patch` (patch text in `tool_input.command`) | undocumented names; detect by argument shape | `replace`, `write_file` | `edit`, `write`, `multiedit`, `apply_patch` | tool-specific `toolArgs` |
| live status | L0–L3 verified (2.1.289) | L0–L2 verified (M2 runs) | documented | documented | L0–L3 verified (1.18.31) | documented |

Sources: [docs/research/hooks.md](../research/hooks.md) (official documentation, probes) and
`demo/evidence/m2-report.md`.

### 10.2 One deny, six wires

The same core decision — deny the edit, explanation *E* — in each host's native output:

```jsonc
// Claude Code / Codex: PreToolUse stdout
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "E" } }
// Cursor: preToolUse stdout (a permission hook must always answer a permission)
{ "permission": "deny", "agent_message": "E", "user_message": "E (first line)" }
// Gemini CLI: BeforeTool stdout
{ "decision": "deny", "reason": "E" }
// OpenCode: tool.execute.before (in-process plugin)
throw new Error("E")
// GitHub Copilot: preToolUse stdout (documented)
{ "permissionDecision": "deny", "permissionDecisionReason": "E" }
// Core stdio binding (§8)
{ "hooks": "0.1", "decision": "deny", "explanation": "E" }
```

And the same `advise` after a tool ran:

```jsonc
// Claude Code / Codex          { "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "E" } }
// Cursor                       { "additional_context": "E" }
// Gemini CLI                   { "hookSpecificOutput": { "hookEventName": "AfterTool", "additionalContext": "E" } }
// OpenCode                     output.output += "\n" + "E"
// Core                         { "hooks": "0.1", "decision": "advise", "explanation": "E" }
```

### 10.3 Inputs: one edit, five spellings

| Host | Native `tool.pre` input for "replace A with B in src/cart.ts" |
|---|---|
| Claude Code | `{"hook_event_name":"PreToolUse","session_id":…,"cwd":…,"tool_name":"Edit","tool_input":{"file_path":"/w/src/cart.ts","old_string":"A","new_string":"B"},"tool_use_id":…}` |
| Codex | `{"hook_event_name":"PreToolUse",…,"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: src/cart.ts\n@@\n-A\n+B\n*** End Patch"}}` |
| Cursor | `{"hook_event_name":"preToolUse","conversation_id":…,"workspace_roots":["/w"],"tool_name":"edit_file","tool_input":{"file_path":…,"old_string":"A","new_string":"B"}}` |
| Gemini CLI | `{"hook_event_name":"BeforeTool","session_id":…,"cwd":…,"tool_name":"replace","tool_input":{"file_path":…,"old_string":"A","new_string":"B","expected_replacements":1}}` |
| OpenCode | `tool.execute.before({tool:"edit", sessionID, callID}, {args:{filePath, oldString:"A", newString:"B", replaceAll:false}})` |

The executable form of these tables is `packages/conformance/src/dialects.ts`.

## 11. Conformance

### 11.1 What is tested

A hook is tested **as a black box at its native wire**: the runner (`wcp-hook-conformance`)
starts the hook command once per event, in a fresh git workspace, speaking the host dialect
the hook was written for (`core`, `claude-code`, `codex`, `cursor`, `gemini`, `opencode`). An
oracle supplies the ground truth: a local WCP reference coordinator that the hook's setup
command points it at, plus a scripted peer agent whose change makes the right answers known
in advance (another agent changes `calcTotal`'s signature; an edit that calls the old
signature must be denied). Hooks that are not WCP adapters can be tested the same way by
implementing their policy against the oracle's protocol, or by contributing fixtures with
their own oracle; the levels and checks do not depend on WCP.

| Fixture | Level | Checks |
|---|---|---|
| `L0.session-start` | L0 | `session.start` answered; the hook declared its capabilities |
| `L0.observe-edit` | L0 | a harmless edit is not blocked and is recorded as observed |
| `L0.ignore-non-edit` | L0 | a read is allowed and records nothing |
| `L1.inject-after-tool` | L1 | a peer's signature change to a symbol the agent uses reaches the model as `advise` (with the symbol and the cause) at the next tool call |
| `L2.deny-stale-edit` | L2 | the stale edit is denied before it runs, with an explanation naming the problem; the file is untouched; the denial is recorded |
| `L2.deny-after-late-join` | L2 | a peer's signature change is accepted (unlanded) and the peer's session ends before the agent's session starts; the agent's checkout lacks the change; its edit calling the changed symbol is still denied |
| `L2.allow-after-adapting` | L2 | after the deny, the corrected edit is allowed and recorded |
| `L3.refuse-stop-while-open` | L3 | `agent.stop` is denied (with an explanation) while the error is open and allowed once it is fixed |
| `X.commit-gate` | optional | a shell `git commit` is denied while an error is open |
| `F.coordinator-unreachable` | failure | backend down: every event still answered in time with valid output; the failure policy is observed |
| `F.malformed-input` | failure | garbage on stdin: exits in time, empty or JSON output |

Every invocation is also checked against its dialect's wire rules (deny without a reason,
invalid JSON, missing `permission` on a Cursor `preToolUse`, …) and the host budget.

### 11.2 Result

**Verified level** = the highest *N* such that every required fixture of levels 0..*N*
passes. A hook conforms to Agent Hooks Core 0.1 at level *N* if its verified level is at
least *N*, its declared level is at most its verified level (§3.3), and it has no wire
failures. Reports record declared and verified levels, the observed failure policy and hook
latency.

```sh
pnpm --filter @weft/hook-conformance build
node packages/conformance/bin/wcp-hook-conformance.mjs run --dialect cursor \
  --setup 'node /abs/weft-cursor.mjs install --url {url} --repo {repo} --agent {agent} --task {task}' \
  --env WEFT_TOKEN=conformance-token --md report.md -- node /abs/weft-cursor.mjs hook
```

### 11.3 Limits

A wire-level pass shows the hook answers correctly *given* the host's documented input; it
does not show that a given host version calls the hook, honours the answer, or routes every
edit-capable tool through it. Live verification per host remains separate evidence (§10.1).

## 12. Extensions

- **Coordination (WCP).** [wcp-v0.md](wcp-v0.md) layers a per-repository ordered event log,
  symbol-level validation (stale overwrite / stale assumption / stale read), claim
  arbitration, negotiation between agents and a human observer API on top of this core. Its
  adapters are core hooks whose decisions come from a coordinator's verdicts (wcp-v0 §8.3).
- **Vendor fields** use an `x_` prefix in core envelopes; receivers MUST ignore unknown fields.
- **New events and tool kinds** are added in minor versions; hooks answer unknown ones `allow`.

## 13. Versioning

`hooks` carries `MAJOR.MINOR`, currently `"0.1"`. Minor versions only add optional fields,
events, tool kinds and codes. While MAJOR is 0, breaking changes are allowed between minors and
are listed in the changelog below.

## Appendix A — relation to Agent Plugins 1.0

Agent Plugins 1.0 packages Skills and MCP configuration and leaves hooks to client-namespaced
directories (`com.example.client/hooks/`). A future portable hooks component could be as small
as: a command (or module) implementing the stdio binding (§8), the events it subscribes to,
and its capability declaration (§3.2). Hosts then map those to native hooks (§10) and can
refuse a plugin whose required level they cannot deliver. This document does not propose
changes to the package format.

## Changelog

- 0.1 (2026-10-09): first draft, split out of WCP v0.1 §8 (capability levels, hook-point
  mapping) and generalized: normalized events, decision envelope, diagnostic model, failure
  policy, stdio binding, conformance fixtures and runner.
