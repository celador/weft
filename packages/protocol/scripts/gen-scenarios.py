"""Regenerate fixtures/scenarios/*.json (behavioural conformance scenarios, spec §12).

Run: python3 scripts/gen-scenarios.py

Each scenario is a list of protocol operations with partial expectations (see
src/conformance.ts for the matcher: partial objects, exact array length, "$any",
"$absent", {"$len": n}, {"$contains": [...]}). The expectations are hand-derived from the
normative rules in docs/protocol/wcp-v0.md, not snapshotted from an implementation.
"""
import json, os, sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "scenarios")
START = "2026-10-05T14:00:00.000Z"

X = "src/auth/session.ts#refreshToken"
Y = "src/api/client.ts#fetchWithAuth"
Z = "src/auth/session.ts#SessionStore.get"

L3 = {"level": 3, "observe": "sync", "inject": "immediate", "deny_edit": True, "refuse_stop": True, "commit_gate": "tool_interception"}


def hello(agent, harness, task, change, priority=None):
    t = {"id": task}
    if priority is not None:
        t["priority"] = priority
    return {"type": "hello", "protocol": "wcp/0.1", "agent": {"id": agent, "harness": harness}, "capabilities": L3, "task": t, "change": change}


A = lambda: hello("claude-a", "claude-code", "T-1", "I-a")
B = lambda: hello("codex-b", "codex", "T-2", "I-b")
C = lambda: hello("gemini-c", "gemini-cli", "T-3", "I-c", priority=5)


def step_hello(as_, h, session, seq):
    return {"op": "hello", "as": as_, "hello": h, "expect": {"type": "welcome", "session": session, "head_seq": seq, "delivered_through": seq}}


def edit(base, writes, reads=None, intent=None, mode="commit", diff=None, ack=None):
    ev = {"kind": "edit", "base_seq": base, "writes": [{"key": k, "kind": kd} for k, kd in writes]}
    if reads:
        ev["reads"] = reads
    if intent:
        ev["intent"] = intent
    if diff:
        ev["diff"] = diff
    s = {"type": "submit", "mode": mode, "event": ev}
    if ack is not None:
        s["inbox_ack"] = ack
    return s


def submit(kind, base, payload=None, writes=None, mode="commit"):
    ev = {"kind": kind, "base_seq": base}
    if payload is not None:
        ev["payload"] = payload
    if writes:
        ev["writes"] = [{"key": k, "kind": kd} for k, kd in writes]
    return {"type": "submit", "mode": mode, "event": ev}


def diag(severity, code, symbol, seq, agent, **kw):
    d = {"severity": severity, "code": code, "symbol": symbol, "caused_by_seq": seq, "caused_by_agent": agent}
    d.update(kw)
    return d


def err(code):
    return {"type": "error", "error": {"code": code}}


scenarios = []

# ------------------------------------------------------------------ 1
scenarios.append({
    "name": "accept-and-observe",
    "description": "A clean edit is accepted, sequenced, summarized and visible to observers; a passing check appends nothing.",
    "covers": ["5.1", "5.3", "6.4", "9.3"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "body")], intent="retry 401 once", diff="--- a\n+++ b\n"),
         "expect": {"verdict": "accept", "mode": "commit", "seq": 2, "head_seq": 2, "diagnostics": [], "inbox": [], "delivered_through": 2,
                    "summary": "claude-a edited refreshToken in src/auth/session.ts — retry 401 once"}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "body")], mode="check"),
         "expect": {"verdict": "accept", "mode": "check", "seq": None, "head_seq": 2}},
        {"op": "events", "after": 0,
         "expect": {"type": "events", "repo": "demo", "head_seq": 2, "next_after": 2, "has_more": False, "events": [
             {"seq": 1, "kind": "join", "status": "accepted", "actor": {"type": "agent", "id": "claude-a"}, "summary": "claude-a joined (claude-code, L3)"},
             {"seq": 2, "kind": "edit", "status": "accepted", "has_diff": True, "diff": "$absent", "files": ["src/auth/session.ts"],
              "task": "T-1", "change": "I-a", "base_seq": 1, "mode": "commit"}]}},
        {"op": "events", "after": 0, "limit": 1, "expect": {"next_after": 1, "has_more": True, "events": {"$len": 1}}},
        {"op": "events", "tail": True, "limit": 1, "expect": {"next_after": 2, "has_more": False, "events": [{"seq": 2}]}},
        {"op": "events", "before": 2, "limit": 5, "expect": {"events": [{"seq": 1}]}},
        {"op": "event", "seq": 2, "expect": {"seq": 2, "diff": "--- a\n+++ b\n", "intent": "retry 401 once"}},
        {"op": "event", "seq": 3, "expect": err("not_found")},
    ],
})

# ------------------------------------------------------------------ 2
scenarios.append({
    "name": "stale-overwrite",
    "description": "R1: writing a symbol that landed on trunk after the writer's base is an error; rebasing (higher base) clears it and the stop gate opens.",
    "covers": ["6.2 R1", "6.5", "8.4"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"verdict": "accept", "seq": 3}},
        {"op": "system", "draft": {"kind": "land", "base_seq": 3, "change": "I-a", "payload": {"sha": "9e1b77a0", "op_id": "op_1"}},
         "expect": {"seq": 4, "kind": "land", "status": "accepted", "agent": "claude-a", "writes": [{"key": X, "kind": "signature"}],
                    "summary": "claude-a landed I-a (1 symbol)"}},
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")], intent="tweak refresh"),
         "expect": {"verdict": "reject", "seq": 5, "summary": "Blocked: codex-b edited refreshToken in src/auth/session.ts — tweak refresh",
                    "diagnostics": [diag("error", "stale_overwrite", X, 4, "claude-a", caused_by_task="T-1", file="src/auth/session.ts")]}},
        {"op": "event", "seq": 5, "expect": {"status": "rejected", "mode": "commit"}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": [{"code": "stale_overwrite"}]}},
        {"op": "submit", "as": "B", "submit": edit(5, [(X, "body")]), "expect": {"verdict": "accept", "seq": 6, "diagnostics": []}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True, "open_errors": []}},
    ],
})

# ------------------------------------------------------------------ 3
scenarios.append({
    "name": "signature-read-error",
    "description": "R2: B calls X; A changes X's signature. B is told (contract_changed warning) and B's next edit based before the change is rejected at check time (L2 deny) with stale_assumption; after draining (higher base) the same edit is accepted.",
    "covers": ["6.2 R2", "6.3", "5.2", "8.3", "8.4"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"verdict": "accept", "seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"verdict": "accept", "seq": 4, "diagnostics": []}},
        {"op": "submit", "as": "B", "submit": edit(3, [(Y, "body")], reads=[X], mode="check"),
         "expect": {"verdict": "reject", "mode": "check", "seq": 5, "head_seq": 5,
                    "diagnostics": [diag("error", "stale_assumption", X, 4, "claude-a", caused_by_task="T-1")],
                    "inbox": [{"id": 1, "seq": 4, "kind": "diagnostic", "diagnostic": diag("warning", "contract_changed", X, 4, "claude-a")}],
                    "context": "$any"}},
        {"op": "event", "seq": 5, "expect": {"status": "rejected", "mode": "check", "kind": "edit"}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": [{"code": "stale_assumption", "symbol": X}]}},
        {"op": "drain", "as": "B", "ack": "last", "expect": {"items": [], "delivered_through": 5, "open_errors": {"$len": 1}, "paused": False}},
        {"op": "submit", "as": "B", "submit": edit(5, [(Y, "body")], reads=[X]), "expect": {"verdict": "accept", "seq": 6, "diagnostics": []}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True}},
    ],
})

# ------------------------------------------------------------------ 4
scenarios.append({
    "name": "body-read-warning",
    "description": "R2: a body-only change to a symbol the submitter reads yields a warning, never a rejection, and no contract_changed broadcast.",
    "covers": ["6.2 R2", "6.3"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"verdict": "accept", "seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "body")]), "expect": {"verdict": "accept", "seq": 4}},
        {"op": "submit", "as": "B", "submit": edit(3, [(Y, "body")], reads=[X]),
         "expect": {"verdict": "accept", "seq": 5, "inbox": [], "diagnostics": [diag("warning", "stale_read", X, 4, "claude-a")]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True}},
    ],
})

# ------------------------------------------------------------------ 5
scenarios.append({
    "name": "arbitration-wound-wait",
    "description": "§7 asymmetry under wound-wait: the junior writer gets the diagnostic (warning on a soft claim, error on a firm one) and the holder only an info; a higher-priority writer wounds every holder.",
    "covers": ["6.2 R3", "7.1", "7.2", "7.3", "8.4"],
    "policy": "wound-wait",
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        step_hello("C", C(), "s3", 3),
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "body")]), "expect": {"verdict": "accept", "seq": 4, "diagnostics": []}},
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")]),
         "expect": {"verdict": "accept", "seq": 5, "diagnostics": [diag("warning", "claim_wait", X, 4, "claude-a", arbitration={
             "policy": "wound-wait", "outcome": "wait", "winner": {"agent": "claude-a", "change": "I-a"}, "loser": {"agent": "codex-b", "change": "I-b"}})]}},
        {"op": "drain", "as": "A", "expect": {"items": [{"id": 1, "seq": 5, "kind": "diagnostic", "diagnostic": diag("info", "claim_contended", X, 5, "codex-b")}], "open_errors": []}},
        {"op": "submit", "as": "A", "submit": submit("claim", 5, {"firm": True, "source": "explicit"}, writes=[(Z, "body")]),
         "expect": {"verdict": "accept", "seq": 6, "summary": "claude-a firmly claimed SessionStore.get"}},
        {"op": "submit", "as": "B", "submit": edit(5, [(Z, "body")]),
         "expect": {"verdict": "reject", "seq": 7, "diagnostics": [diag("error", "claim_wait", Z, 6, "claude-a")]}},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"items": [], "open_errors": []}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False}},
        {"op": "submit", "as": "C", "submit": edit(3, [(X, "signature")]),
         "expect": {"verdict": "accept", "seq": 8, "diagnostics": [diag("info", "claim_contended", X, 4, "claude-a", arbitration={
             "outcome": "wound", "winner": {"agent": "gemini-c", "change": "I-c"}, "loser": {"agent": "claude-a", "change": "I-a"}})]}},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"items": [
            {"seq": 8, "diagnostic": diag("error", "claim_wounded", X, 8, "gemini-c", caused_by_task="T-3", arbitration={"outcome": "wound", "loser": {"change": "I-a"}})},
            {"seq": 8, "diagnostic": diag("warning", "contract_changed", X, 8, "gemini-c")}],
            "open_errors": [{"code": "claim_wounded"}]}},
        {"op": "drain", "as": "B", "expect": {"items": [
            {"seq": 8, "diagnostic": {"code": "claim_wounded", "arbitration": {"loser": {"change": "I-b"}}}},
            {"seq": 8, "diagnostic": {"code": "contract_changed"}}]}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": False, "open_errors": [{"code": "claim_wounded", "symbol": X}]}},
        {"op": "submit", "as": "A", "submit": submit("release", 8, {"keys": [X], "reason": "abandoned"}),
         "expect": {"verdict": "accept", "seq": 9, "summary": "claude-a released refreshToken (abandoned)"}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": True}},
    ],
})

# ------------------------------------------------------------------ 6
scenarios.append({
    "name": "arbitration-wait-die",
    "description": "§7 under wait-die: a junior writer dies (error) even on a soft claim; a senior (higher-priority) writer waits (warning) and the holder keeps the area.",
    "covers": ["7.1", "7.2"],
    "policy": "wait-die",
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        step_hello("C", C(), "s3", 3),
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "body")]), "expect": {"verdict": "accept", "seq": 4}},
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")]),
         "expect": {"verdict": "reject", "seq": 5, "diagnostics": [diag("error", "claim_die", X, 4, "claude-a", arbitration={
             "policy": "wait-die", "outcome": "die", "winner": {"change": "I-a"}, "loser": {"change": "I-b"}, "options": ["retreat", "negotiate", "escalate"]})]}},
        {"op": "submit", "as": "C", "submit": edit(3, [(X, "body")]),
         "expect": {"verdict": "accept", "seq": 6, "diagnostics": [diag("warning", "claim_wait", X, 4, "claude-a", arbitration={
             "outcome": "wait", "winner": {"change": "I-a"}, "loser": {"change": "I-c"}})]}},
        {"op": "drain", "as": "A", "expect": {"items": [{"seq": 6, "diagnostic": diag("info", "claim_contended", X, 6, "gemini-c")}], "open_errors": []}},
    ],
})

# ------------------------------------------------------------------ 7
scenarios.append({
    "name": "negotiation",
    "description": "§7.4: propose/accept round-trip delivered through inboxes; only the addressee may reply; an accepted transfer moves the claim so the proposer edits without arbitration.",
    "covers": ["7.4", "6.3", "11"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"seq": 4}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.propose", 3, {"to": {"agent": "claude-a"}, "keys": [X],
            "terms": {"kind": "overload", "text": "Keep refreshToken(token) as an overload."}}),
         "expect": {"verdict": "accept", "seq": 5, "summary": "codex-b → claude-a: proposes overload on refreshToken",
                    "inbox": [{"id": 1, "seq": 4, "diagnostic": {"code": "contract_changed"}}]}},
        {"op": "drain", "as": "A", "expect": {"items": [{"id": 1, "seq": 5, "kind": "negotiation", "record": {"kind": "negotiate.propose", "agent": "codex-b"}}]}},
        step_hello("C", C(), "s3", 6),
        {"op": "submit", "as": "C", "submit": submit("negotiate.accept", 6, {"reply_to": 5}), "expect": err("invalid_reference")},
        {"op": "submit", "as": "A", "submit": submit("negotiate.accept", 5, {"reply_to": 4}), "expect": err("invalid_reference")},
        {"op": "submit", "as": "A", "submit": submit("negotiate.accept", 5, {"reply_to": 5}),
         "expect": {"verdict": "accept", "seq": 7, "summary": "claude-a accepted #5"}},
        {"op": "drain", "as": "B", "ack": "last", "expect": {"items": [{"seq": 7, "kind": "negotiation", "record": {"kind": "negotiate.accept", "payload": {"reply_to": 5}}}]}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.propose", 7, {"to": {"change": "I-a"}, "keys": [X],
            "terms": {"kind": "transfer", "text": "Hand refreshToken to me; I'll own the migration."}}), "expect": {"seq": 8}},
        {"op": "submit", "as": "A", "submit": submit("negotiate.counter", 8, {"reply_to": 8,
            "terms": {"kind": "transfer", "text": "Fine, after my checkpoint."}}), "expect": err("base_ahead")},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"items": [{"seq": 8, "kind": "negotiation"}], "delivered_through": 8}},
        {"op": "submit", "as": "A", "submit": submit("negotiate.counter", 8, {"reply_to": 8,
            "terms": {"kind": "transfer", "text": "Fine, after my checkpoint."}}), "expect": {"verdict": "accept", "seq": 9, "summary": "claude-a countered #8"}},
        {"op": "drain", "as": "B", "ack": "last", "expect": {"items": [{"seq": 9, "record": {"kind": "negotiate.counter"}}]}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.accept", 9, {"reply_to": 9}), "expect": {"verdict": "accept", "seq": 10}},
        {"op": "submit", "as": "B", "submit": edit(10, [(X, "body")]), "expect": {"verdict": "accept", "seq": 11, "diagnostics": []}},
    ],
})

# ------------------------------------------------------------------ 8
scenarios.append({
    "name": "inbox-and-base",
    "description": "§5.2: base_seq may not exceed what was delivered; inbox items are redelivered until acked; a rejecting check is logged, an accepting check is not.",
    "covers": ["5.2", "5.4", "8.3", "11"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(99, [(Y, "body")]),
         "expect": {"type": "error", "error": {"code": "base_ahead", "retryable": False, "details": {"delivered_through": 2}}}},
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"seq": 4}},
        {"op": "drain", "as": "B", "expect": {"items": [{"id": 1, "seq": 4}], "delivered_through": 4}},
        {"op": "drain", "as": "B", "expect": {"items": [{"id": 1, "seq": 4}]}},
        {"op": "drain", "as": "B", "ack": 1, "expect": {"items": []}},
        {"op": "submit", "as": "B", "submit": edit(4, [(Y, "body")], reads=[X], mode="check"), "expect": {"verdict": "accept", "seq": None}},
        {"op": "submit", "as": "B", "submit": edit(3, [(Y, "body")], reads=[X], mode="check"), "expect": {"verdict": "reject", "seq": 5}},
        {"op": "events", "after": 4, "expect": {"events": [{"seq": 5, "status": "rejected", "mode": "check"}]}},
        {"op": "submit", "as": "B", "submit": {"type": "submit", "mode": "commit", "event": {"kind": "land", "base_seq": 5, "payload": {"sha": "abcdef12", "op_id": "op_9"}}}, "expect": err("forbidden")},
        {"op": "submit", "as": "B", "submit": {"type": "submit", "mode": "commit", "event": {"kind": "edit", "base_seq": 5}}, "expect": err("invalid_message")},
    ],
})

# ------------------------------------------------------------------ 9
scenarios.append({
    "name": "human-actions",
    "description": "§9.6: pause blocks edits (agent_paused) but lets the agent stop; message and resume reach the inbox; approve/undo are logged as control events; bad targets are invalid_reference.",
    "covers": ["9.6", "8.4", "6.4"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")]), "expect": {"seq": 3}},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "pause", "agent": "codex-b", "reason": "wrong approach"},
         "expect": {"type": "action.result", "seq": 4, "record": {"kind": "control", "actor": {"type": "human", "id": "john"}, "summary": "john paused codex-b"}}},
        {"op": "submit", "as": "B", "submit": edit(3, [(Y, "body")], mode="check"),
         "expect": {"verdict": "reject", "seq": 5, "diagnostics": [{"severity": "error", "code": "agent_paused", "caused_by_seq": 4, "caused_by_agent": "john"}],
                    "inbox": [{"id": 1, "seq": 4, "kind": "control"}]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True}},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "message", "to": {"agent": "codex-b"}, "text": "Use the overload", "intent": "steer"},
         "expect": {"seq": 6, "record": {"kind": "message", "summary": "john → codex-b: Use the overload"}}},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "resume", "agent": "codex-b"}, "expect": {"seq": 7}},
        {"op": "drain", "as": "B", "ack": "last", "expect": {"paused": False, "items": [{"seq": 6, "kind": "message"}, {"seq": 7, "kind": "control"}]}},
        {"op": "submit", "as": "B", "submit": edit(7, [(Y, "body")]), "expect": {"verdict": "accept", "seq": 8}},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "approve", "change": "I-b"},
         "expect": {"seq": 9, "record": {"summary": "john approved I-b", "payload": {"action": "approve", "target": {"change": "I-b"}}}}},
        {"op": "system", "draft": {"kind": "land", "base_seq": 9, "change": "I-b", "payload": {"sha": "abcdef12", "op_id": "op_7"}}, "expect": {"seq": 10, "status": "accepted"}},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "undo", "seq": 3, "reason": "x"}, "expect": err("invalid_reference")},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "pause", "agent": "nobody"}, "expect": err("invalid_reference")},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "undo", "op_id": "op_7", "reason": "error spike"},
         "expect": {"seq": 11, "record": {"summary": "john requested undo of #10", "payload": {"target": {"seq": 10, "op_id": "op_7"}}}}},
        {"op": "system", "actor": {"type": "system", "id": "revert-workflow"},
         "draft": {"kind": "revert", "base_seq": 11, "change": "I-b", "writes": [{"key": Y, "kind": "body"}],
                   "payload": {"op_id": "op_8", "reverts_seq": 10, "reason": "error spike", "requested_by": {"type": "human", "id": "john"}}},
         "expect": {"seq": 12, "kind": "revert", "summary": "reverted #10: error spike"}},
    ],
})

# ------------------------------------------------------------------ 10
scenarios.append({
    "name": "claim-ttl-and-session-expiry",
    "description": "§7.5/§8.2: an expired claim is released by a system release event, unblocking others; idle sessions expire (leave) and further calls fail with session_expired.",
    "covers": ["7.5", "8.2", "11"],
    "claim_ttl_ms": 60000,
    "session_ttl_ms": 300000,
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "A", "submit": submit("claim", 1, {"firm": True, "source": "explicit", "ttl_ms": 1000}, writes=[(X, "signature")]), "expect": {"seq": 3}},
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")]), "expect": {"verdict": "reject", "seq": 4, "diagnostics": [{"code": "claim_wait", "severity": "error"}]}},
        {"op": "advance", "ms": 2000},
        {"op": "tick", "expect": [{"seq": 5, "kind": "release", "actor": {"type": "system"}, "agent": "claude-a", "change": "I-a",
                                   "payload": {"keys": [X], "reason": "expired"}, "summary": "claude-a released refreshToken (expired)"}]},
        {"op": "submit", "as": "B", "submit": edit(4, [(X, "body")]), "expect": {"verdict": "accept", "seq": 6, "diagnostics": []}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True}},
        {"op": "heartbeat", "as": "A", "expect": {"type": "heartbeat.ack", "head_seq": 6}},
        {"op": "advance", "ms": 400000},
        {"op": "tick", "expect": [
            {"seq": 7, "kind": "release", "change": "I-b", "payload": {"reason": "expired"}},
            {"seq": 8, "kind": "leave", "agent": "claude-a"},
            {"seq": 9, "kind": "leave", "agent": "codex-b"}]},
        {"op": "submit", "as": "B", "submit": edit(6, [(Y, "body")]), "expect": err("session_expired")},
    ],
})

# ------------------------------------------------------------------ 11
scenarios.append({
    "name": "trunk-advanced-and-predicted",
    "description": "§6.3: a landing notifies every live change that reads/writes/claims a landed symbol (requires_rebase); predicted claims never arbitrate, they only inform.",
    "covers": ["6.3", "7.5"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "body")]), "expect": {"seq": 4}},
        {"op": "system", "draft": {"kind": "land", "base_seq": 4, "change": "I-a", "payload": {"sha": "0badc0de", "op_id": "op_1"}},
         "expect": {"seq": 5, "status": "accepted", "writes": [{"key": X, "kind": "body"}]}},
        {"op": "drain", "as": "B", "expect": {"items": [{"id": 1, "seq": 5, "kind": "trunk", "requires_rebase": True,
            "diagnostic": diag("info", "trunk_advanced", X, 5, "claude-a")}]}},
        step_hello("C", C(), "s3", 6),
        {"op": "submit", "as": "C", "submit": submit("claim", 6, {"firm": False, "source": "predicted"}, writes=[(Y, "body")]),
         "expect": {"verdict": "accept", "seq": 7, "summary": "gemini-c is predicted to touch fetchWithAuth",
                    "diagnostics": [diag("info", "claim_predicted_overlap", Y, 3, "codex-b")]}},
        {"op": "submit", "as": "B", "submit": edit(5, [(Y, "body")]), "expect": {"verdict": "accept", "seq": 8,
            "diagnostics": [diag("info", "claim_predicted_overlap", Y, 7, "gemini-c")]}},
    ],
})

# ------------------------------------------------------------------ 12
scenarios.append({
    "name": "negotiation-overload-dues",
    "description": "§7.4/§8.4: the loser of an R2 conflict proposes an overload; the owner's stop gate is refused until it replies, then until it makes the agreed edit; a new session of the owner's change gets the open agreement redelivered; after the overload the proposer's old-API edit is accepted.",
    "covers": ["7.4", "8.4", "8.2"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"verdict": "accept", "seq": 4}},
        {"op": "submit", "as": "B", "submit": edit(3, [(Y, "body")], reads=[X], mode="check"),
         "expect": {"verdict": "reject", "seq": 5, "diagnostics": [diag("error", "stale_assumption", X, 4, "claude-a")]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": [{"code": "stale_assumption"}], "negotiations": "$absent"}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.propose", 5, {"to": {"change": "I-a"}, "keys": [X],
            "terms": {"kind": "overload", "text": "Keep refreshToken(token) working as an overload."}}),
         "expect": {"verdict": "accept", "seq": 6, "summary": "codex-b → I-a: proposes overload on refreshToken"}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": False, "open_errors": [], "reason": "$any",
            "negotiations": [{"seq": 6, "due": "reply", "keys": [X], "record": {"kind": "negotiate.propose", "agent": "codex-b"}}]}},
        {"op": "gate", "as": "A", "gate": "commit", "expect": {"allow": True, "negotiations": "$absent"}},
        {"op": "submit", "as": "A", "submit": submit("negotiate.accept", 4, {"reply_to": 6}),
         "expect": {"verdict": "accept", "seq": 7, "summary": "claude-a accepted #6"}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": False, "open_errors": [],
            "negotiations": [{"seq": 7, "due": "fulfil", "keys": [X], "record": {"kind": "negotiate.accept"}}]}},
        step_hello("A2", A(), "s3", 8),
        {"op": "drain", "as": "A2", "expect": {"items": [{"id": 1, "seq": 7, "kind": "negotiation", "record": {"kind": "negotiate.accept", "payload": {"reply_to": 6}}}]}},
        {"op": "submit", "as": "A", "submit": edit(4, [(X, "signature")], intent="restore refreshToken(token) as an overload"),
         "expect": {"verdict": "accept", "seq": 9, "diagnostics": []}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": True, "negotiations": "$absent"}},
        {"op": "drain", "as": "B", "ack": "last", "expect": {"items": [
            {"seq": 7, "kind": "negotiation", "record": {"kind": "negotiate.accept"}},
            {"seq": 9, "diagnostic": {"code": "contract_changed"}}], "delivered_through": 9}},
        {"op": "submit", "as": "B", "submit": edit(9, [(Y, "body")], reads=[X]), "expect": {"verdict": "accept", "seq": 10, "diagnostics": []}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True}},
    ],
})

# ------------------------------------------------------------------ 13
scenarios.append({
    "name": "escalation-merge",
    "description": "§7.6 (escalation auto): the loser of an arbitration escalates; the coordinator merges the two tasks with a system control record (senior lead first), forgives the cross-task errors and stops arbitrating between them; a higher-priority change still wounds the whole group; repeat or conflict-free escalations are refused.",
    "covers": ["7.6", "7.1", "7.2", "6.5"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        step_hello("C", C(), "s3", 3),
        {"op": "submit", "as": "A", "submit": submit("claim", 1, {"firm": True, "source": "explicit"}, writes=[(Y, "body")]), "expect": {"verdict": "accept", "seq": 4}},
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")]),
         "expect": {"verdict": "reject", "seq": 5, "diagnostics": [diag("error", "claim_wait", Y, 4, "claude-a", arbitration={
             "outcome": "wait", "winner": {"change": "I-a"}, "loser": {"change": "I-b"}, "options": ["retreat", "wait", "negotiate", "escalate"]})]}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.escalate", 5, {"with": {"agent": "claude-a"}, "keys": [Y], "reason": "T-2 needs fetchWithAuth too"}),
         "expect": {"verdict": "accept", "seq": 6, "head_seq": 7,
                    "summary": "codex-b escalated conflict with claude-a to the coordinator (merge tasks) — T-2 needs fetchWithAuth too",
                    "inbox": [{"id": 1, "seq": 7, "kind": "control", "record": {"kind": "control", "actor": {"type": "system", "id": "coordinator"},
                        "payload": {"action": "merge", "target": {"changes": ["I-a", "I-b"]}, "cause": 6, "reason": "T-2 needs fetchWithAuth too"}}}]}},
        {"op": "event", "seq": 7, "expect": {"kind": "control", "status": "accepted", "summary": "coordinator merged the tasks of I-a + I-b"}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True, "open_errors": []}},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"items": [
            {"seq": 6, "kind": "negotiation", "record": {"kind": "negotiate.escalate", "agent": "codex-b"}},
            {"seq": 7, "kind": "control", "record": {"payload": {"action": "merge"}}}]}},
        {"op": "submit", "as": "B", "submit": edit(7, [(Y, "body")]), "expect": {"verdict": "accept", "seq": 8, "diagnostics": []}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.escalate", 8, {"with": {"change": "I-a"}, "reason": "again"}), "expect": err("invalid_reference")},
        {"op": "submit", "as": "C", "submit": submit("negotiate.escalate", 3, {"with": {"agent": "claude-a"}, "reason": "no conflict"}), "expect": err("invalid_reference")},
        {"op": "submit", "as": "C", "submit": edit(3, [(Y, "body")]),
         "expect": {"verdict": "accept", "seq": 9, "diagnostics": [diag("info", "claim_contended", Y, 4, "claude-a", arbitration={"outcome": "wound", "winner": {"change": "I-c"}})]}},
        {"op": "drain", "as": "B", "expect": {"items": [{"seq": 7, "kind": "control"}, {"seq": 9, "diagnostic": {"code": "claim_wounded"}}]}},
    ],
})

# ------------------------------------------------------------------ 14
scenarios.append({
    "name": "escalation-human",
    "description": "§7.6 (escalation human): an escalation is recorded and delivered but does not merge; a human merge action does (senior lead first), after which the R2 error between the two changes is forgiven and no longer raised.",
    "covers": ["7.6", "9.6"],
    "escalation": "human",
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"seq": 4}},
        {"op": "submit", "as": "B", "submit": edit(3, [(Y, "body")], reads=[X], mode="check"), "expect": {"verdict": "reject", "seq": 5}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.escalate", 5, {"with": {"change": "I-a"}, "reason": "one feature, two cards"}),
         "expect": {"verdict": "accept", "seq": 6, "head_seq": 6, "inbox": [{"id": 1, "seq": 4, "diagnostic": {"code": "contract_changed"}}]}},
        {"op": "drain", "as": "A", "expect": {"items": [{"seq": 6, "kind": "negotiation", "record": {"kind": "negotiate.escalate"}}]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": [{"code": "stale_assumption"}]}},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "merge", "changes": ["I-a", "I-b"], "reason": "same feature"},
         "expect": {"seq": 7, "record": {"kind": "control", "actor": {"type": "human", "id": "john"},
            "payload": {"action": "merge", "target": {"changes": ["I-b", "I-a"]}, "reason": "same feature"}, "summary": "john merged the tasks of I-b + I-a"}}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True, "open_errors": []}},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "merge", "changes": ["I-b", "I-a"]}, "expect": err("invalid_reference")},
        {"op": "action", "human": "john", "action": {"type": "action", "action": "merge", "changes": ["I-b", "I-zzz"]}, "expect": err("invalid_reference")},
        {"op": "submit", "as": "B", "submit": edit(5, [(Y, "body")], reads=[X]), "expect": {"verdict": "accept", "seq": 8, "diagnostics": []}},
    ],
})

# ------------------------------------------------------------------ 15
scenarios.append({
    "name": "merge-by-agreement",
    "description": "§7.4/§7.6: accepting merge_tasks terms makes the coordinator merge the two tasks (control record citing the accept).",
    "covers": ["7.4", "7.6"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"seq": 4}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.propose", 3, {"to": {"agent": "claude-a"}, "keys": [X],
            "terms": {"kind": "merge_tasks", "text": "Let's do T-1 and T-2 as one task."}}), "expect": {"verdict": "accept", "seq": 5}},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"items": [{"seq": 5, "kind": "negotiation"}], "delivered_through": 5}},
        {"op": "submit", "as": "A", "submit": submit("negotiate.accept", 5, {"reply_to": 5}),
         "expect": {"verdict": "accept", "seq": 6, "head_seq": 7,
                    "inbox": [{"seq": 5, "kind": "negotiation"},
                              {"seq": 7, "kind": "control", "record": {"payload": {"action": "merge", "target": {"changes": ["I-b", "I-a"]}, "cause": 6}}}]}},
        {"op": "drain", "as": "B", "ack": "last", "expect": {"items": [{"seq": 6, "kind": "negotiation"}, {"seq": 7, "kind": "control"}]}},
    ],
})

# ------------------------------------------------------------------ 16
scenarios.append({
    "name": "overload-before-accept",
    "description": "§8.4: an owner that makes the requested overload edit first and accepts afterwards owes nothing; an edit before the proposal does not count.",
    "covers": ["8.4", "7.4"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"seq": 4}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.propose", 3, {"to": {"agent": "claude-a"}, "keys": [X],
            "terms": {"kind": "overload", "text": "keep refreshToken(token)"}}), "expect": {"seq": 5}},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"delivered_through": 5}},
        {"op": "submit", "as": "A", "submit": edit(5, [(X, "signature")]), "expect": {"verdict": "accept", "seq": 6}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": False, "negotiations": [{"seq": 5, "due": "reply"}]}},
        {"op": "submit", "as": "A", "submit": submit("negotiate.accept", 6, {"reply_to": 5}), "expect": {"verdict": "accept", "seq": 7}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": True, "negotiations": "$absent"}},
    ],
})

# ------------------------------------------------------------------ R2a suggestion per conflicts mode
P_CALC = "shop/pricing.py#calc_total"
P_QUOTE = "shop/pricing.py#Pricer.quote"


def reads_amendment_text(cont):
    """codex-b's reads amendment uses calc_total, whose signature claude-a changed after codex-b's base.

    The contract_changed warning on the verdict (§6.2 R2a) and the one pushed for a later signature
    change of an amended key (§6.3) say to adapt under hold, and to keep editing other tasks instead
    under continue (§8.4). Warnings never gate, and the owner is not told about them in either mode.
    """
    if cont:
        amended = (f"Keep editing your other tasks instead of adapting your call sites to claude-a's new {P_CALC} (event #4); "
                   f"do not adopt their partial work. claude-a owns the change; negotiate with claude-a if you need the old contract.")
        pushed = ("Keep editing your other tasks instead of adapting your call sites to claude-a's change; do not adopt their partial work. "
                  "claude-a owns the change; negotiate with claude-a if you need the old contract.")
    else:
        amended = f"Re-read {P_CALC} (event #4) and adapt your call sites, or negotiate with claude-a."
        pushed = f"Re-read {P_QUOTE} and adapt your call sites before your next edit, or negotiate (e.g. keep the old signature as an overload)."
    return [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        # B's edit read the re-export; A then changes the real declaration, which B is not told about.
        {"op": "submit", "as": "B", "submit": edit(2, [("shop/cart.py#Cart.total", "body")], reads=["shop/__init__.py#calc_total"]),
         "expect": {"verdict": "accept", "seq": 3, "diagnostics": []}},
        {"op": "submit", "as": "A", "submit": edit(1, [(P_CALC, "signature")]), "expect": {"verdict": "accept", "seq": 4, "diagnostics": []}},
        {"op": "submit", "as": "B", "submit": {"type": "submit", "mode": "commit", "event": {
            "kind": "intent", "base_seq": 3, "reads": [P_CALC, P_QUOTE], "intent": "lsp reads amendment for #3"}},
         "expect": {"verdict": "accept", "seq": 5, "diagnostics": [diag("warning", "contract_changed", P_CALC, 4, "claude-a",
             caused_by_task="T-1", file="shop/pricing.py",
             message=f"claude-a changed the signature of {P_CALC} (#4) after your base #3, and your change uses it.",
             suggestion=amended)]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True, "open_errors": []}},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"items": [], "open_errors": []}},
        {"op": "submit", "as": "A", "submit": edit(5, [(P_QUOTE, "signature")]), "expect": {"verdict": "accept", "seq": 6, "diagnostics": []}},
        {"op": "drain", "as": "B", "ack": "last", "expect": {"items": [{"seq": 6, "kind": "diagnostic", "diagnostic": diag(
            "warning", "contract_changed", P_QUOTE, 6, "claude-a", suggestion=pushed)}], "open_errors": []}},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"items": [], "open_errors": []}},
    ]


scenarios.append({
    "name": "reads-amendment-suggestion-hold",
    "description": "§6.2 R2a under the default conflicts mode (hold): the contract_changed warning on a reads amendment, and the one pushed for a later signature change of an amended key, tell the agent to re-read the symbol and adapt its call sites (or negotiate).",
    "covers": ["6.2 R2a", "6.3", "8.4"],
    "steps": reads_amendment_text(cont=False),
})

scenarios.append({
    "name": "reads-amendment-suggestion-continue",
    "description": "§6.2 R2a under conflicts: continue (§8.4): the same two contract_changed warnings tell the agent to keep editing its other tasks instead of adapting its call sites to the other agent's change; neither gates, and the owner is not told about warnings.",
    "covers": ["6.2 R2a", "6.3", "8.4"],
    "conflicts": "continue",
    "steps": reads_amendment_text(cont=True),
})

# ------------------------------------------------------------------ L1 claim leases
# Defaults are pinned here on purpose: these scenarios run with no `claims` field, so they
# fail if the default lease (2 min) or firm limit (10 min) ever changes silently.
DEFAULT_CLAIMS = {"lease_ms": 120000, "firm_max_ms": 600000}


def release_rec(seq, agent, change, keys, reason):
    return {"seq": seq, "kind": "release", "status": "accepted", "actor": {"type": "system"}, "agent": agent, "change": change,
            "payload": {"keys": keys, "reason": reason}}


scenarios.append({
    "name": "lease-soft-claim",
    "description": "§7.5: a soft claim is a lease of lease_ms (default 2 min) renewed by heartbeats; when its agent dies (no more heartbeats) the claim is released within lease_ms, not after the old 30-minute TTL.",
    "covers": ["7.5", "8.2"],
    "steps": [
        {"op": "hello", "as": "A", "hello": A(), "expect": {"type": "welcome", "session": "s1", "head_seq": 1, "claim_ttl_ms": 120000,
                                                             "policy": {"arbitration": "wound-wait", "claims": DEFAULT_CLAIMS}}},
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "body")]), "expect": {"verdict": "accept", "seq": 3}},
        {"op": "heartbeat", "as": "A", "expect": {"type": "heartbeat.ack"}},
        {"op": "advance", "ms": 60000},
        {"op": "heartbeat", "as": "A", "expect": {"type": "heartbeat.ack"}},
        {"op": "advance", "ms": 60000},
        # The first lease (from #3) has run out, but the heartbeat renewed it.
        {"op": "tick", "expect": []},
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")], mode="check"),
         "expect": {"verdict": "accept", "seq": None, "diagnostics": [diag("warning", "claim_wait", X, 3, "claude-a")]}},
        # claude-a dies here: no more heartbeats. Its lease ends 120 s after its last one.
        {"op": "advance", "ms": 59990},
        {"op": "tick", "expect": []},
        {"op": "advance", "ms": 10},
        {"op": "tick", "expect": [{**release_rec(4, "claude-a", "I-a", [X], "expired"), "summary": "claude-a released refreshToken (expired)"}]},
        {"op": "submit", "as": "B", "submit": edit(3, [(X, "body")], mode="check"), "expect": {"verdict": "accept", "seq": None, "diagnostics": []}},
    ],
})

scenarios.append({
    "name": "lease-firm-hard-limit",
    "description": "§7.5: a firm claim has a hard deadline min(ttl_ms, firm_max_ms) from its claim event; heartbeats and the holder's own edits do not extend it; only a new explicit claim event does.",
    "covers": ["7.5", "6.3"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        # Asks for an hour; the repo caps firm holds at 10 minutes.
        {"op": "submit", "as": "A", "submit": submit("claim", 1, {"firm": True, "source": "explicit", "ttl_ms": 3600000}, writes=[(X, "signature")]),
         "expect": {"verdict": "accept", "seq": 3}},
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")]),
         "expect": {"verdict": "reject", "seq": 4, "diagnostics": [diag("error", "claim_wait", X, 3, "claude-a")]}},
        {"op": "advance", "ms": 200000},
        {"op": "heartbeat", "as": "A", "expect": {"type": "heartbeat.ack"}},
        {"op": "heartbeat", "as": "B"},
        {"op": "submit", "as": "A", "submit": edit(3, [(X, "body")]), "expect": {"verdict": "accept", "seq": 5}},
        {"op": "advance", "ms": 200000},
        {"op": "heartbeat", "as": "A", "expect": {"type": "heartbeat.ack"}},
        {"op": "heartbeat", "as": "B"},
        {"op": "advance", "ms": 199980},
        {"op": "tick", "expect": []},
        {"op": "heartbeat", "as": "A", "expect": {"type": "heartbeat.ack"}},
        {"op": "heartbeat", "as": "B"},
        {"op": "advance", "ms": 7},
        # 600 000 ms after the claim event: released although claude-a is alive and heartbeating.
        {"op": "tick", "expect": [release_rec(6, "claude-a", "I-a", [X], "expired")]},
        {"op": "submit", "as": "B", "submit": edit(4, [(X, "body")]), "expect": {"verdict": "accept", "seq": 7, "diagnostics": []}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True}},
        # Re-asserting a firm claim in the log is the only way to extend it.
        {"op": "submit", "as": "A", "submit": submit("claim", 5, {"firm": True, "source": "explicit", "ttl_ms": 1000}, writes=[(Y, "body")]),
         "expect": {"verdict": "accept", "seq": 8}},
        {"op": "advance", "ms": 500},
        {"op": "submit", "as": "A", "submit": submit("claim", 8, {"firm": True, "source": "explicit", "ttl_ms": 1000}, writes=[(Y, "body")]),
         "expect": {"verdict": "accept", "seq": 9}},
        {"op": "advance", "ms": 700},
        {"op": "tick", "expect": []},
        {"op": "advance", "ms": 400},
        {"op": "tick", "expect": [release_rec(10, "claude-a", "I-a", [Y], "expired")]},
    ],
})

scenarios.append({
    "name": "release-on-exit",
    "description": "§7.5/§8.2: when a change's last live session ends (bye or expiry) its claims are released at once by a system release record; another live session of the same change keeps them.",
    "covers": ["7.5", "8.2"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "body")]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": submit("claim", 3, {"firm": True, "source": "explicit"}, writes=[(Z, "body")]), "expect": {"seq": 4}},
        step_hello("A2", A(), "s3", 5),
        {"op": "bye", "as": "A"},
        # s3 of the same change is still live: nothing released.
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")], mode="check"),
         "expect": {"verdict": "accept", "seq": None, "diagnostics": [diag("warning", "claim_wait", X, 3, "claude-a")]}},
        {"op": "bye", "as": "A2"},
        {"op": "events", "after": 5, "expect": {"events": [
            {"seq": 6, "kind": "leave", "agent": "claude-a", "session": "s1"},
            {"seq": 7, "kind": "leave", "agent": "claude-a", "session": "s3"},
            {**release_rec(8, "claude-a", "I-a", [X, Z], "session_ended"), "summary": "claude-a released refreshToken, SessionStore.get (session ended)"}]}},
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")], mode="check"), "expect": {"verdict": "accept", "seq": None, "diagnostics": []}},
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")]), "expect": {"verdict": "accept", "seq": 9}},
        {"op": "submit", "as": "B", "submit": submit("claim", 9, {"firm": True, "source": "explicit"}, writes=[(Y, "body")]), "expect": {"seq": 10}},
        {"op": "advance", "ms": 400000},
        # The soft lease ran out first (expired); the firm claim outlived the session (session expired).
        {"op": "tick", "expect": [
            release_rec(11, "codex-b", "I-b", [X], "expired"),
            {"seq": 12, "kind": "leave", "agent": "codex-b", "actor": {"type": "system"}},
            release_rec(13, "codex-b", "I-b", [Y], "session_expired")]},
        {"op": "submit", "as": "B", "submit": edit(10, [(Y, "body")]), "expect": err("session_expired")},
    ],
})


def intent_reads(base, reads):
    return {"type": "submit", "mode": "commit", "event": {"kind": "intent", "base_seq": base, "reads": reads, "intent": "look at it again"}}


def release(base, keys=None):
    return submit("release", base, {"keys": keys} if keys is not None else {})


scenarios.append({
    "name": "open-errors-persist",
    "description": "§6.5 (audit of 'can an agent clear its open errors by release, bye or reconnect'): open errors belong to the change; release (all or by key), an intent or claim naming the key, bye + hello and session expiry + hello leave them open (and a new session gets them redelivered). Only an accepted edit, or a release of an error whose edit never reached the workspace (check) or of a wound (push), clears one.",
    "covers": ["6.5", "8.2", "8.4", "7.5"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")], reads=[X]), "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(1, [(X, "signature")]), "expect": {"verdict": "accept", "seq": 4}},
        # A commit-mode rejection: the edit is in codex-b's workspace but not in the log.
        {"op": "submit", "as": "B", "submit": edit(3, [(Y, "body")], reads=[X]),
         "expect": {"verdict": "reject", "seq": 5, "diagnostics": [diag("error", "stale_assumption", X, 4, "claude-a")]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": [{"code": "stale_assumption", "symbol": X}]}},
        # Attempt 1: release everything.
        {"op": "submit", "as": "B", "submit": release(5), "expect": {"verdict": "accept", "seq": 6, "summary": "codex-b released all claims"}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": {"$len": 1}}},
        # Attempt 2: release the key itself.
        {"op": "submit", "as": "B", "submit": release(6, [X]), "expect": {"verdict": "accept", "seq": 7}},
        {"op": "gate", "as": "B", "gate": "commit", "expect": {"allow": False, "open_errors": {"$len": 1}}},
        # Attempt 3: an intent that reads the key.
        {"op": "submit", "as": "B", "submit": intent_reads(7, [X]), "expect": {"verdict": "accept", "seq": 8}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": {"$len": 1}}},
        # Attempt 4: a claim on the key (codex-b is senior, so it even wounds claude-a).
        {"op": "submit", "as": "B", "submit": submit("claim", 8, {"firm": False, "source": "explicit"}, writes=[(X, "signature")]),
         "expect": {"verdict": "accept", "seq": 9, "diagnostics": [diag("info", "claim_contended", X, 4, "claude-a")]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": {"$len": 1}}},
        # Attempt 5: bye, then a fresh hello of the same change.
        {"op": "bye", "as": "B"},
        step_hello("B", B(), "s3", 12),
        {"op": "drain", "as": "B", "expect": {"items": [{"id": 1, "seq": 5, "kind": "diagnostic", "diagnostic": diag("error", "stale_assumption", X, 4, "claude-a")}],
                                              "open_errors": [{"code": "stale_assumption", "symbol": X}]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False}},
        # Attempt 6: let the session expire, then hello again.
        {"op": "advance", "ms": 400000},
        {"op": "tick", "expect": [{"seq": 13, "kind": "leave", "agent": "claude-a"}, {"seq": 14, "kind": "leave", "agent": "codex-b"}]},
        step_hello("B", B(), "s4", 15),
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False, "open_errors": [{"code": "stale_assumption", "symbol": X}]}},
        # The real fix: redo the edit against the current log.
        {"op": "submit", "as": "B", "submit": edit(15, [(Y, "body")], reads=[X]), "expect": {"verdict": "accept", "seq": 16, "diagnostics": []}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True, "open_errors": []}},
        # claude-a was wounded at #9 (push): its new session gets the error redelivered; a release of the key is its retreat.
        step_hello("A", A(), "s5", 17),
        {"op": "drain", "as": "A", "expect": {"items": [{"id": 1, "seq": 9, "kind": "diagnostic", "diagnostic": diag("error", "claim_wounded", X, 9, "codex-b")}]}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": False}},
        {"op": "submit", "as": "A", "submit": release(17, [X]), "expect": {"verdict": "accept", "seq": 18}},
        {"op": "gate", "as": "A", "gate": "stop", "expect": {"allow": True}},
        {"op": "submit", "as": "A", "submit": edit(18, [(X, "signature")]), "expect": {"verdict": "accept", "seq": 19}},
        # A check-mode rejection: the edit was denied, never applied; releasing the key is a valid retreat.
        {"op": "submit", "as": "B", "submit": edit(16, [(Y, "body")], reads=[X], mode="check"),
         "expect": {"verdict": "reject", "seq": 20, "diagnostics": [diag("error", "stale_assumption", X, 19, "claude-a")]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False}},
        {"op": "submit", "as": "B", "submit": release(16, [X]), "expect": {"verdict": "accept", "seq": 21}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": True}},
    ],
})

scenarios.append({
    "name": "claims-legacy-and-migration",
    "description": "§7.5: a repo created before the claims policy keeps the old rules (30-min renewable TTL, ttl_ms as given, no release on exit) until the operator applies the policy with one journaled operation; from then on leases, the firm limit and release on exit apply, while claims made before keep their expiry.",
    "covers": ["7.5", "5.1"],
    "claims": None,
    "steps": [
        {"op": "hello", "as": "A", "hello": A(), "expect": {"type": "welcome", "session": "s1", "claim_ttl_ms": 1800000,
                                                             "policy": {"arbitration": "wound-wait", "claims": "$absent"}}},
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "A", "submit": submit("claim", 1, {"firm": True, "source": "explicit", "ttl_ms": 3600000}, writes=[(X, "signature")]),
         "expect": {"seq": 3}},
        {"op": "submit", "as": "A", "submit": edit(3, [(Y, "body")]), "expect": {"seq": 4}},
        {"op": "bye", "as": "A"},
        # Legacy: leaving releases nothing; the soft claim on Y still holds for 30 minutes.
        {"op": "submit", "as": "B", "submit": edit(2, [(Y, "body")]),
         "expect": {"verdict": "accept", "seq": 6, "diagnostics": [diag("warning", "claim_wait", Y, 4, "claude-a")]}},
        {"op": "advance", "ms": 1800000},
        {"op": "tick", "expect": [
            release_rec(7, "claude-a", "I-a", [Y], "expired"),
            release_rec(8, "codex-b", "I-b", [Y], "expired"),
            {"seq": 9, "kind": "leave", "agent": "codex-b"}]},
        {"op": "policy", "policy": {"claims": DEFAULT_CLAIMS}, "expect": {"arbitration": "wound-wait", "claims": DEFAULT_CLAIMS}},
        {"op": "hello", "as": "B", "hello": B(), "expect": {"type": "welcome", "session": "s3", "head_seq": 10, "claim_ttl_ms": 120000,
                                                             "policy": {"claims": DEFAULT_CLAIMS}}},
        {"op": "submit", "as": "B", "submit": edit(10, [(Z, "body")]), "expect": {"seq": 11}},
        {"op": "bye", "as": "B"},
        {"op": "events", "after": 11, "expect": {"events": [{"seq": 12, "kind": "leave"}, release_rec(13, "codex-b", "I-b", [Z], "session_ended")]}},
        # The firm claim from before the policy keeps its one-hour expiry.
        {"op": "advance", "ms": 1700000},
        {"op": "tick", "expect": []},
        {"op": "advance", "ms": 100000},
        {"op": "tick", "expect": [release_rec(14, "claude-a", "I-a", [X], "expired")]},
    ],
})

# ------------------------------------------------------------------ firm vs soft explicit claims
def firm_vs_soft(block):
    """claude-a (senior) claims X soft and Z firm; codex-b (junior) then edits and claims both.

    The firm flag alone decides the outcome under advise; under block a soft hold also
    denies edits, but a claim is never refused by the mode, only by a firm holder.
    """
    soft_edit = {"verdict": "reject", "seq": 5, "diagnostics": [diag("error", "claim_wait", X, 3, "claude-a")]} if block else {
        "verdict": "accept", "seq": 5, "diagnostics": [diag("warning", "claim_wait", X, 3, "claude-a", arbitration={
            "policy": "wound-wait", "outcome": "wait", "winner": {"agent": "claude-a", "change": "I-a"}, "loser": {"agent": "codex-b", "change": "I-b"}})]}
    # An accepted junior event tells the holder (info); a rejected one tells it nothing.
    holder_items = [] if block else [{"seq": 5, "kind": "diagnostic", "diagnostic": diag("info", "claim_contended", X, 5, "codex-b")}]
    return [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "A", "submit": submit("claim", 1, {"firm": False, "source": "explicit"}, writes=[(X, "body")]),
         "expect": {"verdict": "accept", "seq": 3, "diagnostics": [], "summary": "claude-a claimed refreshToken"}},
        {"op": "submit", "as": "A", "submit": submit("claim", 3, {"firm": True, "source": "explicit"}, writes=[(Z, "body")]),
         "expect": {"verdict": "accept", "seq": 4, "diagnostics": [], "summary": "claude-a firmly claimed SessionStore.get"}},
        # Soft hold: a warning under advise (the edit lands), an error under block.
        {"op": "submit", "as": "B", "submit": edit(2, [(X, "body")]), "expect": soft_edit},
        # Firm hold: an error in either mode; the edit is rejected.
        {"op": "submit", "as": "B", "submit": edit(2, [(Z, "body")]),
         "expect": {"verdict": "reject", "seq": 6, "diagnostics": [diag("error", "claim_wait", Z, 4, "claude-a", arbitration={"outcome": "wait"})]}},
        {"op": "drain", "as": "A", "ack": "last", "expect": {"items": holder_items, "open_errors": []}},
        # A claim is only ever refused by a firm holder, never by the enforcement mode.
        {"op": "submit", "as": "B", "submit": submit("claim", 2, {"firm": False, "source": "explicit"}, writes=[(X, "body")]),
         "expect": {"verdict": "accept", "seq": 7, "diagnostics": [diag("warning", "claim_wait", X, 3, "claude-a")]}},
        {"op": "submit", "as": "B", "submit": submit("claim", 2, {"firm": True, "source": "explicit"}, writes=[(Z, "body")]),
         "expect": {"verdict": "reject", "seq": 8, "diagnostics": [diag("error", "claim_wait", Z, 4, "claude-a")]}},
        {"op": "gate", "as": "B", "gate": "stop", "expect": {"allow": False}},
    ]


scenarios.append({
    "name": "claim-firm-vs-soft",
    "description": "§7.2/§7.5 under advise (the default): an overlapping edit by a junior agent is only warned on a soft explicit claim (firm:false) and lands, but is rejected with an error on a firm claim (firm:true).",
    "covers": ["6.2 R3", "7.2", "7.5"],
    "steps": firm_vs_soft(block=False),
})

scenarios.append({
    "name": "claim-firm-vs-soft-block",
    "description": "§7.2/§7.5 under enforcement block: edits into a soft hold are rejected too; claims are refused only by a firm holder, never by the mode.",
    "covers": ["6.2 R3", "7.2", "7.5"],
    "enforcement": "block",
    "steps": firm_vs_soft(block=True),
})

# ------------------------------------------------------------------ revert history (§6.6, §9.7)
F = "src/x.ts#f"
G = "src/x.ts#g"
H = "src/other.ts#h"
DAY = 86400000
REVERT_REASON = "error spike after landing: TypeError: Cannot read properties of undefined (reading 'id')\n    at f (src/x.ts:3:7)\n    at main (src/main.ts:10:3)"
REVERT_LINE = "error spike after landing: TypeError: Cannot read properties of undefined (reading 'id')"


def note(days):
    return {"severity": "info", "code": "previously_reverted", "file": "src/x.ts", "symbol": F,
            "message": f"previously reverted {days}d ago: {REVERT_LINE} (by john, #4)", "caused_by_seq": 4, "caused_by_agent": "john"}


REVERT_ENTRY = {"seq": 4, "kind": "revert", "keys": [F], "actor": {"type": "system", "id": "revert-workflow"},
                "agent": "claude-a", "change": "I-a", "task": "T-1", "reason": REVERT_LINE,
                "requested_by": {"type": "human", "id": "john"}, "reverts_seq": 3, "reverts_op_id": "op_1", "op_id": "op_2",
                "evidence": "at f (src/x.ts:3:7)"}

scenarios.append({
    "name": "revert-history",
    "description": "§6.6/§9.7: A's change to f lands and is reverted with a reason. Days later B (a new session) edits f: its check carries one info note `previously reverted <n>d ago: <reason> (by <actor>, #<seq>)`, never again in that session, again in a new session, and not after 30 days. The record stores no note. The history read derives f from the revert (revert -> land op -> change -> accepted edits) and filters by key, file and window.",
    "covers": ["6.6", "9.7"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        {"op": "submit", "as": "A", "submit": edit(1, [(F, "body")]), "expect": {"verdict": "accept", "seq": 2, "diagnostics": []}},
        {"op": "system", "draft": {"kind": "land", "base_seq": 2, "change": "I-a", "payload": {"sha": "1a2b3c4d", "op_id": "op_1"}},
         "expect": {"seq": 3, "kind": "land", "status": "accepted", "writes": [{"key": F, "kind": "body"}]}},
        # The revert names the op it undoes, not keys.
        {"op": "system", "actor": {"type": "system", "id": "revert-workflow"},
         "draft": {"kind": "revert", "base_seq": 3, "change": "I-a",
                   "payload": {"op_id": "op_2", "reverts_seq": 3, "reverts_op_id": "op_1", "sha": "5e6f7a8b", "reason": REVERT_REASON, "requested_by": {"type": "human", "id": "john"}}},
         "expect": {"seq": 4, "kind": "revert", "status": "accepted", "writes": []}},
        {"op": "bye", "as": "A"},
        {"op": "advance", "ms": 3 * DAY},
        step_hello("B", B(), "s2", 6),
        # B's pre-edit check: accepted, with the note (info: it never blocks).
        {"op": "submit", "as": "B", "submit": edit(6, [(F, "body")], mode="check"),
         "expect": {"verdict": "accept", "mode": "check", "seq": None, "diagnostics": [note(3)]}},
        # Once per key per session: the commit of the same edit carries nothing.
        {"op": "submit", "as": "B", "submit": edit(6, [(F, "body")]), "expect": {"verdict": "accept", "seq": 7, "diagnostics": []}},
        {"op": "event", "seq": 7, "expect": {"seq": 7, "status": "accepted", "diagnostics": []}},
        # Another symbol of the same file was never reverted.
        {"op": "submit", "as": "B", "submit": edit(7, [(G, "body")], mode="check"), "expect": {"verdict": "accept", "diagnostics": []}},
        {"op": "history", "keys": [F],
         "expect": {"type": "history", "repo": "demo", "keys": [F], "since": "2026-07-10T14:00:00.012Z", "head_seq": 7, "has_more": False, "entries": [REVERT_ENTRY]}},
        {"op": "history", "keys": [H], "expect": {"type": "history", "keys": [H], "entries": [], "has_more": False}},
        {"op": "history", "keys": ["src/x.ts#*"], "expect": {"entries": [{"seq": 4, "kind": "revert", "keys": [F]}]}},
        {"op": "history", "keys": ["src/x.ts"], "expect": {"entries": [{"seq": 4, "kind": "revert", "keys": [F]}]}},
        {"op": "history", "keys": [F], "since": "2026-10-06T00:00:00.000Z", "expect": {"since": "2026-10-06T00:00:00.000Z", "entries": []}},
        {"op": "history", "keys": ["src/x.ts f"], "expect": err("invalid_message")},
        # A new session of B is told again.
        {"op": "bye", "as": "B"},
        {"op": "hello", "as": "B", "hello": B(), "expect": {"type": "welcome", "session": "s3"}},
        {"op": "submit", "as": "B", "submit": edit(10, [(F, "body")], mode="check"), "expect": {"verdict": "accept", "diagnostics": [note(3)]}},
        # After 30 days no note; the history read (90 days by default) still has it.
        {"op": "bye", "as": "B"},
        {"op": "advance", "ms": 28 * DAY},
        {"op": "hello", "as": "B", "hello": B(), "expect": {"type": "welcome", "session": "s4"}},
        {"op": "submit", "as": "B", "submit": edit(12, [(F, "body")], mode="check"), "expect": {"verdict": "accept", "diagnostics": []}},
        {"op": "history", "keys": [F], "expect": {"entries": [{"seq": 4, "kind": "revert"}]}},
    ],
})

scenarios.append({
    "name": "history-refused-and-negotiated",
    "description": "§9.7: the history of a key also lists refused edits with their diagnostic cause and finished negotiations (accepted, rejected, escalated) with their terms, newest first; limit pages it.",
    "covers": ["9.7", "7.4", "7.6"],
    "steps": [
        step_hello("A", A(), "s1", 1),
        step_hello("B", B(), "s2", 2),
        {"op": "submit", "as": "A", "submit": submit("claim", 1, {"firm": True, "source": "explicit"}, writes=[(F, "body")]), "expect": {"seq": 3}},
        {"op": "submit", "as": "B", "submit": edit(2, [(F, "body")]), "expect": {"verdict": "reject", "seq": 4, "diagnostics": [{"code": "claim_wait", "severity": "error"}]}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.propose", 4, {"to": {"agent": "claude-a"}, "keys": [F], "terms": {"kind": "share", "text": "let me fix f too"}}), "expect": {"seq": 5}},
        {"op": "submit", "as": "A", "submit": submit("negotiate.reject", 3, {"reply_to": 5, "reason": "mid-refactor"}), "expect": {"seq": 6}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.propose", 5, {"to": {"agent": "claude-a"}, "keys": [F], "terms": {"kind": "overload", "text": "keep f(a) working"}}), "expect": {"seq": 7}},
        {"op": "submit", "as": "A", "submit": submit("negotiate.counter", 6, {"reply_to": 7, "terms": {"kind": "sequence", "text": "after I land"}}), "expect": {"seq": 8}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.accept", 7, {"reply_to": 8}), "expect": {"seq": 9}},
        {"op": "history", "keys": [F], "expect": {"has_more": False, "entries": [
            {"seq": 9, "kind": "negotiation", "keys": [F], "agent": "codex-b", "outcome": "accepted", "terms": {"kind": "sequence", "text": "after I land"}, "reply_to": 8, "with": "claude-a"},
            {"seq": 6, "kind": "negotiation", "keys": [F], "agent": "claude-a", "outcome": "rejected", "terms": {"kind": "share", "text": "let me fix f too"}, "reply_to": 5, "reason": "mid-refactor", "with": "codex-b"},
            {"seq": 4, "kind": "rejected", "keys": [F], "agent": "codex-b", "event_kind": "edit", "mode": "commit",
             "causes": [{"severity": "error", "code": "claim_wait", "symbol": F, "caused_by_seq": 3, "caused_by_agent": "claude-a"}]}]}},
        {"op": "history", "keys": [F], "limit": 1, "expect": {"has_more": True, "entries": [{"seq": 9}]}},
        {"op": "submit", "as": "B", "submit": submit("negotiate.escalate", 9, {"with": {"agent": "claude-a"}, "keys": [F], "reason": "stuck on f"}), "expect": {"seq": 10}},
        {"op": "history", "keys": [F], "limit": 2, "expect": {"has_more": True, "entries": [
            {"seq": 10, "kind": "negotiation", "outcome": "escalated", "reason": "stuck on f", "with": "claude-a", "agent": "codex-b"}, {"seq": 9}]}},
        # Nothing here was reverted: no note on B's next edit of f.
        {"op": "submit", "as": "B", "submit": edit(11, [(F, "body")], mode="check"), "expect": {"diagnostics": {"$len": 0}}},
    ],
})

os.makedirs(OUT, exist_ok=True)
# Only (re)write the generated scenarios; hand-written ones (alternatives-best-of-n.json)
# live in the same directory and must survive a regeneration. Names on the command line limit the
# run to those scenarios (python3 scripts/gen-scenarios.py reads-amendment-suggestion-continue).
only = set(sys.argv[1:])
unknown = only - {sc["name"] for sc in scenarios}
if unknown:
    sys.exit(f"unknown scenario(s): {', '.join(sorted(unknown))}")
for sc in [s for s in scenarios if not only or s["name"] in only]:
    sc = {"name": sc["name"], "description": sc["description"], "covers": sc["covers"], "repo": "demo", "start": START,
          **{k: v for k, v in sc.items() if k not in ("name", "description", "covers")}}
    with open(os.path.join(OUT, f"{sc['name']}.json"), "w") as fh:
        json.dump(sc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
print(len(scenarios), "scenarios")
