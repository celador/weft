"""Regenerate fixtures/messages/{valid,invalid}/*.json (message-shape conformance fixtures).

Run: python3 scripts/gen-message-fixtures.py
"""
import json, os, copy

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "messages")

caps_l3 = {"level": 3, "observe": "sync", "inject": "immediate", "deny_edit": True, "refuse_stop": True, "commit_gate": "tool_interception"}
caps_l0 = {"level": 0, "observe": "async", "inject": False, "deny_edit": False, "refuse_stop": False, "commit_gate": False}

diff = "diff --git a/src/auth/session.ts b/src/auth/session.ts\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -10,3 +10,3 @@\n-export async function refreshToken(token: string) {\n+export async function refreshToken(token: string, opts: RefreshOpts) {\n"

diag_err = {
    "severity": "error", "code": "stale_assumption", "file": "src/api/client.ts",
    "range": {"start": {"line": 41, "character": 10}, "end": {"line": 41, "character": 22}},
    "symbol": "src/auth/session.ts#refreshToken",
    "message": "You use src/auth/session.ts#refreshToken, whose signature changed in #12 by claude-a after your base #9.",
    "caused_by_seq": 12, "caused_by_agent": "claude-a", "caused_by_task": "T-1",
    "suggestion": "Read the new src/auth/session.ts#refreshToken (event #12) and update this call site, or negotiate with claude-a."
}
diag_wait = {
    "severity": "warning", "code": "claim_wait", "file": "src/auth/session.ts", "symbol": "src/auth/session.ts#refreshToken",
    "message": "src/auth/session.ts#refreshToken is being edited by claude-a (claude-a/T-1), which has precedence.",
    "caused_by_seq": 12, "caused_by_agent": "claude-a", "caused_by_task": "T-1",
    "arbitration": {"policy": "wound-wait", "outcome": "wait", "winner": {"agent": "claude-a", "change": "I4f2a"}, "loser": {"agent": "codex-b", "change": "I9c01"}, "options": ["retreat", "wait", "negotiate", "escalate"]}
}

record_edit = {
    "seq": 12, "repo": "weft-demo", "status": "accepted", "kind": "edit", "ts": "2026-10-05T14:03:11.204Z",
    "actor": {"type": "agent", "id": "claude-a", "harness": "claude-code"},
    "agent": "claude-a", "task": "T-1", "change": "I4f2a", "session": "s1", "base_seq": 9, "mode": "commit",
    "files": ["src/auth/session.ts"], "reads": ["src/auth/session.ts#RefreshOpts"],
    "writes": [{"key": "src/auth/session.ts#refreshToken", "kind": "signature"}],
    "diff": diff, "intent": "add a retry budget to token refresh",
    "summary": "claude-a changed signature of refreshToken in src/auth/session.ts — add a retry budget to token refresh",
    "diagnostics": [],
    "tool": {"name": "Edit", "call_id": "toolu_01", "harness_event": "PostToolUse"},
    "transcript": {"uri": "r2://weft-transcripts/I4f2a/claude-a.jsonl", "offset": 1824}
}
record_list = {k: v for k, v in record_edit.items() if k != "diff"}
record_list["has_diff"] = True

record_reject = {
    "seq": 13, "repo": "weft-demo", "status": "rejected", "kind": "edit", "ts": "2026-10-05T14:03:12.001Z",
    "actor": {"type": "agent", "id": "codex-b", "harness": "codex"},
    "agent": "codex-b", "task": "T-2", "change": "I9c01", "session": "s2", "base_seq": 9, "mode": "check",
    "files": ["src/api/client.ts"], "reads": ["src/auth/session.ts#refreshToken"],
    "writes": [{"key": "src/api/client.ts#fetchWithAuth", "kind": "body"}],
    "summary": "Blocked: codex-b edited fetchWithAuth in src/api/client.ts — retry 401s once",
    "intent": "retry 401s once", "diagnostics": [diag_err]
}

valid = {
  "hello-claude-code-l3": ("Hello", {"type": "hello", "protocol": "wcp/0.1",
      "agent": {"id": "claude-a", "harness": "claude-code", "harness_version": "2.1.289", "model": "claude-opus-5", "adapter": "@weft/adapter-claude-code@0.1.0"},
      "capabilities": caps_l3, "task": {"id": "T-1", "title": "Retry budget for token refresh", "priority": 1}, "change": "I4f2a"}),
  "hello-watcher-l0": ("Hello", {"type": "hello", "protocol": "wcp/0.1", "agent": {"id": "watch-1", "harness": "watcher"}, "capabilities": caps_l0}),
  "hello-codex-l1-delayed": ("Hello", {"type": "hello", "protocol": "wcp/0.1", "agent": {"id": "codex-b", "harness": "codex"},
      "capabilities": {"level": 1, "observe": "async", "inject": "delayed", "deny_edit": False, "refuse_stop": False, "commit_gate": False}, "task": {"id": "T-2"}}),
  "welcome": ("Welcome", {"type": "welcome", "protocol": "wcp/0.1", "session": "s1", "repo": "weft-demo", "head_seq": 9, "delivered_through": 9,
      "heartbeat_interval_ms": 30000, "session_ttl_ms": 300000, "claim_ttl_ms": 1800000, "policy": {"arbitration": "wound-wait"},
      "limits": {"max_diff_bytes": 1048576, "max_keys": 2000, "max_page": 500}}),
  "submit-edit-commit": ("Submit", {"type": "submit", "mode": "commit", "inbox_ack": 3, "event": {
      "kind": "edit", "base_seq": 9, "task": "T-1", "change": "I4f2a", "files": ["src/auth/session.ts"],
      "reads": ["src/auth/session.ts#RefreshOpts"], "writes": [{"key": "src/auth/session.ts#refreshToken", "kind": "signature"}],
      "diff": diff, "intent": "add a retry budget to token refresh", "tool": {"name": "Edit", "call_id": "toolu_01", "harness_event": "PostToolUse"}}}),
  "submit-edit-check": ("Submit", {"type": "submit", "mode": "check", "event": {
      "kind": "edit", "base_seq": 9, "reads": ["src/auth/session.ts#refreshToken"], "writes": [{"key": "src/api/client.ts#fetchWithAuth", "kind": "body"}],
      "tool": {"name": "apply_patch", "harness_event": "PreToolUse"}}}),
  "submit-intent": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "intent", "base_seq": 0, "intent": "Add retry budget; touch session.ts refreshToken only", "reads": ["src/auth/session.ts#refreshToken"]}}),
  "submit-claim-firm": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "claim", "base_seq": 9,
      "writes": [{"key": "src/auth/session.ts#refreshToken", "kind": "signature"}], "payload": {"firm": True, "source": "explicit", "ttl_ms": 600000}}}),
  "submit-release-all": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "release", "base_seq": 14, "payload": {"reason": "abandoned"}}}),
  "submit-checkpoint": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "checkpoint", "base_seq": 14, "payload": {"sha": "3f9a2c1d", "ref": "refs/heads/weft/I4f2a"}}}),
  "submit-negotiate-propose": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "negotiate.propose", "base_seq": 13,
      "payload": {"to": {"agent": "claude-a"}, "keys": ["src/auth/session.ts#refreshToken"], "terms": {"kind": "overload", "text": "Keep refreshToken(token) as an overload that forwards with default opts."}}}}),
  "submit-negotiate-counter": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "negotiate.counter", "base_seq": 15,
      "payload": {"reply_to": 15, "terms": {"kind": "sequence", "text": "I land first (ETA 10 min); then switch your call site."}}}}),
  "submit-negotiate-accept": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "negotiate.accept", "base_seq": 15, "payload": {"reply_to": 15}}}),
  "submit-negotiate-reject": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "negotiate.reject", "base_seq": 15, "payload": {"reply_to": 15, "reason": "overload breaks the public API contract"}}}),
  "verdict-accept-with-warning": ("Verdict", {"type": "verdict", "verdict": "accept", "mode": "commit", "seq": 14, "head_seq": 14,
      "diagnostics": [diag_wait], "summary": "codex-b edited refreshToken in src/auth/session.ts", "inbox": [], "delivered_through": 14,
      "context": "[weft warning] claim_wait src/auth/session.ts#refreshToken: ..."}),
  "verdict-check-reject": ("Verdict", {"type": "verdict", "verdict": "reject", "mode": "check", "seq": 13, "head_seq": 13, "diagnostics": [diag_err],
      "inbox": [{"id": 4, "seq": 12, "kind": "diagnostic", "diagnostic": dict(diag_err, severity="warning", code="contract_changed")}], "delivered_through": 13}),
  "verdict-check-accept": ("Verdict", {"type": "verdict", "verdict": "accept", "mode": "check", "seq": None, "head_seq": 12, "diagnostics": [], "inbox": [], "delivered_through": 12}),
  "inbox-drain": ("InboxDrain", {"type": "inbox.drain", "ack": 4}),
  "inbox-batch": ("InboxBatch", {"type": "inbox", "items": [
      {"id": 5, "seq": 15, "kind": "negotiation", "record": dict(record_list, seq=15, kind="negotiate.propose", writes=[], reads=[], files=[], has_diff=False,
          summary="codex-b → claude-a: proposes overload on refreshToken",
          payload={"to": {"agent": "claude-a"}, "keys": ["src/auth/session.ts#refreshToken"], "terms": {"kind": "overload", "text": "Keep the old signature as an overload."}})},
      {"id": 6, "seq": 20, "kind": "trunk", "requires_rebase": True}],
      "head_seq": 20, "delivered_through": 20, "open_errors": [diag_err], "paused": False}),
  "heartbeat": ("Heartbeat", {"type": "heartbeat"}),
  "heartbeat-ack": ("HeartbeatAck", {"type": "heartbeat.ack", "head_seq": 20, "inbox_pending": 0, "session_expires_at": "2026-10-05T14:08:12.000Z"}),
  "gate-stop": ("Gate", {"type": "gate", "gate": "stop"}),
  "gate-result-refuse": ("GateResult", {"type": "gate.result", "gate": "stop", "allow": False, "reason": "1 open Weft error(s) must be resolved first", "open_errors": [diag_err]}),
  "bye": ("Bye", {"type": "bye", "reason": "task complete"}),
  "repos": ("RepoList", {"type": "repos", "repos": [{"repo": "weft-demo", "head_seq": 20, "active_agents": 3, "active_changes": 3, "open_conflicts": 1,
      "last_event_at": "2026-10-05T14:03:12.001Z", "policy": {"arbitration": "wound-wait"}}]}),
  "events-page": ("EventPage", {"type": "events", "repo": "weft-demo", "events": [record_list, record_reject], "head_seq": 20, "next_after": 13, "has_more": True}),
  "event-detail": ("EventRecord", record_edit),
  "feed-page": ("FeedPage", {"type": "feed", "events": [record_list], "cursor": "v0.eyJ3ZWZ0LWRlbW8iOjEyfQ", "has_more": False}),
  # §6.6: an accepted check of a symbol reverted lately carries an info note (it never blocks).
  "verdict-check-previously-reverted": ("Verdict", {"type": "verdict", "verdict": "accept", "mode": "check", "seq": None, "head_seq": 21,
      "diagnostics": [{"severity": "info", "code": "previously_reverted", "file": "src/x.ts", "symbol": "src/x.ts#f",
                       "message": "previously reverted 3d ago: error spike after landing (by john, #17)", "caused_by_seq": 17, "caused_by_agent": "john"}],
      "inbox": [], "delivered_through": 21,
      "context": "[weft info] previously_reverted src/x.ts#f: previously reverted 3d ago: error spike after landing (by john, #17) (caused by john · event #17)."}),
  # §9.7: GET /v1/repos/{repo}/history?keys=src/x.ts#f
  "history-page": ("HistoryPage", {"type": "history", "repo": "weft-demo", "keys": ["src/x.ts#f"], "since": "2026-07-07T14:00:00.000Z", "head_seq": 21, "has_more": False, "entries": [
      {"seq": 19, "ts": "2026-10-05T14:09:00.000Z", "kind": "negotiation", "keys": ["src/x.ts#f"], "actor": {"type": "agent", "id": "codex-b", "harness": "codex"},
       "agent": "codex-b", "change": "I-b", "outcome": "accepted", "terms": {"kind": "overload", "text": "keep f(a) working"}, "reply_to": 18, "with": "claude-a"},
      {"seq": 17, "ts": "2026-10-05T14:05:00.000Z", "kind": "revert", "keys": ["src/x.ts#f"], "actor": {"type": "system", "id": "revert-workflow"},
       "agent": "claude-a", "change": "I-a", "task": "T-1", "reason": "error spike after landing", "requested_by": {"type": "human", "id": "john"},
       "reverts_seq": 15, "reverts_op_id": "op_1", "op_id": "op_2", "evidence": "at f (src/x.ts:3:7)"},
      {"seq": 12, "ts": "2026-10-05T14:03:11.204Z", "kind": "rejected", "keys": ["src/x.ts#f"], "actor": {"type": "agent", "id": "codex-b", "harness": "codex"},
       "agent": "codex-b", "change": "I-b", "event_kind": "edit", "mode": "check",
       "causes": [{"severity": "error", "code": "claim_wait", "file": "src/x.ts", "symbol": "src/x.ts#f", "message": "src/x.ts#f is firmly claimed by claude-a (I-a), which has precedence.", "caused_by_seq": 11, "caused_by_agent": "claude-a"}]}]}),
  "stream-event": ("StreamFrame", {"type": "event", "event": record_reject}),
  "stream-replay-done": ("StreamFrame", {"type": "replay.done", "head_seq": 20}),
  "stream-ping": ("StreamFrame", {"type": "ping", "head_seq": 20}),
  "action-approve": ("HumanAction", {"type": "action", "action": "approve", "change": "I4f2a", "note": "screenshots look right"}),
  "action-undo": ("HumanAction", {"type": "action", "action": "undo", "seq": 31, "reason": "error spike after landing"}),
  "action-pause": ("HumanAction", {"type": "action", "action": "pause", "agent": "codex-b", "reason": "wrong approach"}),
  "action-message": ("HumanAction", {"type": "action", "action": "message", "to": {"agent": "codex-b"}, "text": "Use the overload, don't touch session.ts", "intent": "steer"}),
  "action-result": ("ActionResult", {"type": "action.result", "seq": 21, "record": {
      "seq": 21, "repo": "weft-demo", "status": "accepted", "kind": "control", "ts": "2026-10-05T14:05:00.000Z",
      "actor": {"type": "human", "id": "john"}, "base_seq": 20, "files": [], "reads": [], "writes": [],
      "summary": "john paused codex-b", "diagnostics": [], "payload": {"action": "pause", "target": {"agent": "codex-b"}, "reason": "wrong approach"}}}),
  "record-land": ("EventRecord", {"seq": 31, "repo": "weft-demo", "status": "accepted", "kind": "land", "ts": "2026-10-05T15:00:00.000Z",
      "actor": {"type": "system", "id": "landing-queue"}, "agent": "claude-a", "task": "T-1", "change": "I4f2a", "base_seq": 30, "files": ["src/auth/session.ts"],
      "reads": [], "writes": [{"key": "src/auth/session.ts#refreshToken", "kind": "signature"}], "summary": "claude-a landed I4f2a (1 symbol)",
      "diagnostics": [], "payload": {"sha": "9e1b77a0c4", "op_id": "op_000031", "trunk_ref": "refs/heads/main"}}),
  "record-revert": ("EventRecord", {"seq": 40, "repo": "weft-demo", "status": "accepted", "kind": "revert", "ts": "2026-10-05T15:20:00.000Z",
      "actor": {"type": "system", "id": "revert-workflow"}, "agent": "claude-a", "change": "I4f2a", "base_seq": 39, "files": ["src/auth/session.ts"], "reads": [],
      "writes": [{"key": "src/auth/session.ts#refreshToken", "kind": "signature"}], "summary": "reverted #31: error spike after landing", "diagnostics": [],
      "payload": {"op_id": "op_000040", "reverts_seq": 31, "reason": "error spike after landing", "requested_by": {"type": "human", "id": "john"}}}),
  "error-base-ahead": ("WcpError", {"type": "error", "error": {"code": "base_ahead", "message": "base_seq 30 > delivered_through 20", "retryable": False, "details": {"delivered_through": 20}}}),
  "unknown-fields-ignored": ("Hello", {"type": "hello", "protocol": "wcp/0.2", "x_future": {"anything": 1}, "agent": {"id": "a", "harness": "cursor", "x": 1}, "capabilities": dict(caps_l3, x_new_cap=True)}),
}

invalid = {
  "hello-l2-async": ("Hello", {"type": "hello", "protocol": "wcp/0.1", "agent": {"id": "a", "harness": "codex"}, "capabilities": dict(caps_l3, level=2, observe="async")}, "/capabilities/observe"),
  "hello-l3-no-stop": ("Hello", {"type": "hello", "protocol": "wcp/0.1", "agent": {"id": "a", "harness": "codex"}, "capabilities": dict(caps_l3, refuse_stop=False)}, "/capabilities/refuse_stop"),
  "hello-l1-no-inject": ("Hello", {"type": "hello", "protocol": "wcp/0.1", "agent": {"id": "a", "harness": "x"}, "capabilities": dict(caps_l0, level=1)}, "/capabilities/inject"),
  "hello-bad-protocol": ("Hello", {"type": "hello", "protocol": "wcp-1", "agent": {"id": "a", "harness": "x"}, "capabilities": caps_l0}, "/protocol"),
  "edit-without-writes": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "edit", "base_seq": 1}}, "/event/writes"),
  "edit-empty-writes": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "edit", "base_seq": 1, "writes": []}}, "/event/writes"),
  "edit-bad-symbol-key": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "edit", "base_seq": 1, "writes": [{"key": "src/a.ts", "kind": "body"}]}}, "/event/writes/0/key"),
  "edit-bad-write-kind": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "edit", "base_seq": 1, "writes": [{"key": "src/a.ts#f", "kind": "rename"}]}}, "/event/writes/0/kind"),
  "negative-base-seq": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "intent", "base_seq": -1}}, "/event/base_seq"),
  "unknown-kind": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "rename", "base_seq": 1}}, "/event/kind"),
  "bad-mode": ("Submit", {"type": "submit", "mode": "dry-run", "event": {"kind": "intent", "base_seq": 1}}, "/mode"),
  "claim-missing-payload": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "claim", "base_seq": 1, "writes": [{"key": "a.ts#f", "kind": "body"}]}}, "/event/payload"),
  "claim-bad-source": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "claim", "base_seq": 1, "writes": [{"key": "a.ts#f", "kind": "body"}], "payload": {"firm": True, "source": "planner"}}}, "/event/payload/source"),
  "propose-empty-keys": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "negotiate.propose", "base_seq": 1, "payload": {"to": {"agent": "a"}, "keys": [], "terms": {"kind": "share", "text": "x"}}}}, "/event/payload/keys"),
  "propose-empty-target": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "negotiate.propose", "base_seq": 1, "payload": {"to": {}, "keys": ["a.ts#f"], "terms": {"kind": "share", "text": "x"}}}}, "/event/payload/to/agent"),
  "accept-missing-reply-to": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "negotiate.accept", "base_seq": 1, "payload": {}}}, "/event/payload/reply_to"),
  "checkpoint-bad-sha": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "checkpoint", "base_seq": 1, "payload": {"sha": "HEAD"}}}, "/event/payload/sha"),
  "summary-hint-too-long": ("Submit", {"type": "submit", "mode": "commit", "event": {"kind": "intent", "base_seq": 1, "summary_hint": "x" * 141}}, "/event/summary_hint"),
  "verdict-seq-zero": ("Verdict", {"type": "verdict", "verdict": "accept", "mode": "commit", "seq": 0, "head_seq": 0, "diagnostics": [], "inbox": [], "delivered_through": 0}, "/seq"),
  "record-missing-summary": ("EventRecord", {k: v for k, v in record_edit.items() if k != "summary"}, "/summary"),
  "record-summary-too-long": ("EventRecord", dict(record_edit, summary="y" * 141), "/summary"),
  "record-bad-ts": ("EventRecord", dict(record_edit, ts="2026-10-05 14:03"), "/ts"),
  "record-bad-repo": ("EventRecord", dict(record_edit, repo="Weft Demo"), "/repo"),
  "diagnostic-missing-cause": ("Diagnostic", {k: v for k, v in diag_err.items() if k != "caused_by_seq"}, "/caused_by_seq"),
  "diagnostic-bad-severity": ("Diagnostic", dict(diag_err, severity="fatal"), "/severity"),
  "diagnostic-unknown-code": ("Diagnostic", dict(diag_err, code="merge_conflict"), "/code"),
  "action-undo-no-target": ("HumanAction", {"type": "action", "action": "undo", "reason": "bad"}, "/seq"),
  "action-message-no-text": ("HumanAction", {"type": "action", "action": "message", "to": {"agent": "a"}}, "/text"),
  "action-unknown": ("HumanAction", {"type": "action", "action": "merge", "change": "I1"}, "/action"),
  "stream-unknown-frame": ("StreamFrame", {"type": "event"}, "/event"),
  "error-unknown-code": ("WcpError", {"type": "error", "error": {"code": "teapot", "message": "x", "retryable": False}}, "/error/code"),
  "revert-no-target": ("EventRecord", dict(record_edit, kind="revert", payload={"op_id": "op_1", "reason": "x"}), "/payload/reverts_seq"),
  "history-entry-bad-kind": ("HistoryPage", {"type": "history", "repo": "weft-demo", "keys": ["src/x.ts#f"], "since": "2026-07-07T14:00:00.000Z", "head_seq": 1, "has_more": False,
      "entries": [{"seq": 1, "ts": "2026-10-05T14:00:00.000Z", "kind": "land", "keys": ["src/x.ts#f"], "actor": {"type": "system", "id": "c"}}]}, "/entries/0/kind"),
  "history-entry-no-keys": ("HistoryPage", {"type": "history", "repo": "weft-demo", "keys": ["src/x.ts#f"], "since": "2026-07-07T14:00:00.000Z", "head_seq": 1, "has_more": False,
      "entries": [{"seq": 1, "ts": "2026-10-05T14:00:00.000Z", "kind": "revert", "keys": [], "actor": {"type": "system", "id": "c"}}]}, "/entries/0/keys"),
}

for d in ("valid", "invalid"):
    for f in os.listdir(f"{root}/{d}"):
        os.remove(f"{root}/{d}/{f}")
for name, (schema, value) in valid.items():
    with open(f"{root}/valid/{name}.json", "w") as fh:
        json.dump({"schema": schema, "value": value}, fh, indent=2, ensure_ascii=False); fh.write("\n")
for name, (schema, value, path) in invalid.items():
    with open(f"{root}/invalid/{name}.json", "w") as fh:
        json.dump({"schema": schema, "expect_issue_path": path, "value": value}, fh, indent=2, ensure_ascii=False); fh.write("\n")
print(len(valid), len(invalid))
