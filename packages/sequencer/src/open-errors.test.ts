// Audit: can an agent clear or bypass its OPEN errors (spec §6.5) — and so open its stop /
// commit gate (§8.4) — with `release`, `bye`, a new `hello`, a session expiry, or another
// accepted event that merely names the key? Each vector is one independent test, run
// against both the reference coordinator and the SqlCoordinator the Durable Object uses.

import { describe, expect, it } from "vitest";
import { ReferenceCoordinator, type GateResult, type Hello, type InboxBatch, type Submit, type Verdict, type Welcome } from "@weft/protocol";
import { SqlCoordinator } from "./coordinator";
import { JournaledCoordinator } from "./journal";
import { nodeSql } from "./node-sqlite";

const X = "src/auth/session.ts#refreshToken";
const Y = "src/api/client.ts#fetchWithAuth";
const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (agent: string, change: string, priority = 0): Hello => ({
  type: "hello",
  protocol: "wcp/0.1",
  agent: { id: agent, harness: "claude-code" },
  capabilities: caps,
  task: { id: `T-${agent}`, priority },
  change,
});
const edit = (base: number, writes: Array<[string, "body" | "signature"]>, reads: string[] = [], mode: "check" | "commit" = "commit"): Submit => ({
  type: "submit",
  mode,
  event: { kind: "edit", base_seq: base, writes: writes.map(([key, kind]) => ({ key, kind })), reads },
});
const ev = (kind: "release" | "intent" | "claim", base: number, extra: Record<string, unknown> = {}): Submit => ({
  type: "submit",
  mode: "commit",
  event: { kind, base_seq: base, ...extra } as Submit["event"],
});

/** The operations every vector needs, over either coordinator. */
type Coord = {
  hello(h: Hello): Welcome;
  submit(s: string, m: Submit): Verdict;
  gate(s: string, g: "stop" | "commit"): GateResult;
  drain(s: string): InboxBatch;
  bye(s: string): void;
  tick(): unknown;
  advance(ms: number): void;
};

function makeRef(claims?: null): Coord {
  let t = Date.parse("2026-10-09T12:00:00.000Z");
  const c = new ReferenceCoordinator({ repo: "r", now: () => t, ...(claims === null ? { claims: null } : {}) });
  return {
    hello: (h) => c.hello(h),
    submit: (s, m) => c.submit(s, m),
    gate: (s, g) => c.gate(s, { type: "gate", gate: g }),
    drain: (s) => c.drain(s),
    bye: (s) => c.bye(s),
    tick: () => c.tick(),
    advance: (ms) => void (t += ms),
  };
}

function makeSql(claims?: null): Coord {
  let t = Date.parse("2026-10-09T12:00:00.000Z");
  const sql = nodeSql();
  SqlCoordinator.init(sql, { repo: "r", ...(claims === null ? { claims: null } : {}) });
  const j = new JournaledCoordinator(sql, () => t);
  return {
    hello: (h) => j.call("hello", h),
    submit: (s, m) => j.call("submit", s, m),
    gate: (s, g) => j.call("gate", s, { type: "gate", gate: g }),
    drain: (s) => j.call("drain", s),
    bye: (s) => void j.call("bye", s),
    tick: () => j.call("tick"),
    advance: (ms) => void (t += ms),
  };
}

/**
 * codex-b edits fetchWithAuth reading refreshToken; claude-a then changes refreshToken's
 * signature; codex-b's next edit (commit mode: already in its workspace) is rejected with
 * stale_assumption. Returns codex-b's session with that one open error.
 */
function setup(c: Coord, mode: "check" | "commit" = "commit") {
  const a = c.hello(hello("claude-a", "I-a"));
  const b = c.hello(hello("codex-b", "I-b"));
  c.submit(b.session, edit(2, [[Y, "body"]], [X])); // #3
  c.submit(a.session, edit(1, [[X, "signature"]])); // #4
  const v = c.submit(b.session, edit(3, [[Y, "body"]], [X], mode)); // #5 rejected
  expect(v).toMatchObject({ verdict: "reject", seq: 5, diagnostics: [{ code: "stale_assumption", symbol: X }] });
  expect(c.gate(b.session, "stop")).toMatchObject({ allow: false });
  return { a: a.session, b: b.session };
}

const closed = (g: GateResult) => ({ allow: g.allow, open: g.open_errors.map((d) => `${d.code} ${d.symbol}`) });
const STILL_OPEN = { allow: false, open: [`stale_assumption ${X}`] };

describe.each([
  ["reference", makeRef],
  ["sql", makeSql],
] as const)("open errors cannot be bypassed (%s coordinator)", (_name, make) => {
  it("release with no keys does not clear a commit-mode error", () => {
    const c = make();
    const { b } = setup(c);
    expect(c.submit(b, ev("release", 5, { payload: {} }))).toMatchObject({ verdict: "accept" });
    expect(closed(c.gate(b, "stop"))).toEqual(STILL_OPEN);
    expect(closed(c.gate(b, "commit"))).toEqual(STILL_OPEN);
  });

  it("releasing the key itself does not clear a commit-mode error", () => {
    const c = make();
    const { b } = setup(c);
    expect(c.submit(b, ev("release", 5, { payload: { keys: [X] } }))).toMatchObject({ verdict: "accept" });
    expect(closed(c.gate(b, "stop"))).toEqual(STILL_OPEN);
  });

  it("an accepted intent that reads the key does not clear it", () => {
    const c = make();
    const { b } = setup(c);
    expect(c.submit(b, ev("intent", 5, { reads: [X], intent: "thinking" }))).toMatchObject({ verdict: "accept" });
    expect(closed(c.gate(b, "stop"))).toEqual(STILL_OPEN);
  });

  it("an accepted claim on the key does not clear it", () => {
    const c = make();
    const { b } = setup(c);
    expect(c.submit(b, ev("claim", 5, { writes: [{ key: X, kind: "signature" }], payload: { firm: false, source: "explicit" } }))).toMatchObject({ verdict: "accept" });
    expect(closed(c.gate(b, "stop"))).toEqual(STILL_OPEN);
  });

  it("bye followed by a new hello of the same change does not clear it, and the new session is told", () => {
    const c = make();
    const { b } = setup(c);
    c.bye(b);
    const b2 = c.hello(hello("codex-b", "I-b"));
    expect(closed(c.gate(b2.session, "stop"))).toEqual(STILL_OPEN);
    const inbox = c.drain(b2.session);
    expect(inbox.items).toMatchObject([{ kind: "diagnostic", seq: 5, diagnostic: { code: "stale_assumption", symbol: X } }]);
    expect(inbox.open_errors).toHaveLength(1);
  });

  it("a session expiry followed by a new hello does not clear it", () => {
    const c = make();
    const { b } = setup(c);
    c.advance(10 * 60_000);
    c.tick();
    expect(() => c.gate(b, "stop")).toThrow(/expired/);
    const b2 = c.hello(hello("codex-b", "I-b"));
    expect(closed(c.gate(b2.session, "stop"))).toEqual(STILL_OPEN);
  });

  it("two live sessions of one change share the open errors", () => {
    const c = make();
    const { b } = setup(c);
    const b2 = c.hello(hello("codex-b", "I-b"));
    expect(closed(c.gate(b2.session, "stop"))).toEqual(STILL_OPEN);
    expect(closed(c.gate(b, "stop"))).toEqual(STILL_OPEN);
  });

  it("redoing the edit against the current log clears it (the intended path)", () => {
    const c = make();
    const { b } = setup(c);
    expect(c.submit(b, edit(5, [[Y, "body"]], [X]))).toMatchObject({ verdict: "accept", diagnostics: [] });
    expect(closed(c.gate(b, "stop"))).toEqual({ allow: true, open: [] });
  });

  it("a check-mode error (edit denied, never applied) is cleared by releasing the key: a retreat", () => {
    const c = make();
    const { b } = setup(c, "check");
    expect(c.submit(b, ev("release", 5, { payload: { keys: [X] } }))).toMatchObject({ verdict: "accept" });
    expect(closed(c.gate(b, "stop"))).toEqual({ allow: true, open: [] });
  });

  it("releasing a different key does not clear a check-mode error", () => {
    const c = make();
    const { b } = setup(c, "check");
    c.submit(b, ev("release", 5, { payload: { keys: [Y] } }));
    expect(closed(c.gate(b, "stop"))).toEqual(STILL_OPEN);
  });
});

describe.each([
  ["reference", makeRef],
  ["sql", makeSql],
] as const)("legacy repos (no claims policy) (%s coordinator)", (_name, make) => {
  it("a claim_wounded while the loser has no live session is kept for its next session", () => {
    // Legacy rules keep claims after the last session ends, so a wound can hit a change with
    // nobody connected. The error used to be pushed to live sessions only, i.e. dropped.
    const c = make(null);
    const senior = c.hello(hello("gemini-c", "I-c", 5));
    const junior = c.hello(hello("codex-b", "I-b"));
    c.submit(junior.session, edit(2, [[X, "body"]])); // #3: soft claim of I-b
    c.bye(junior.session); // legacy: the claim stays
    expect(c.submit(senior.session, edit(1, [[X, "body"]]))).toMatchObject({ verdict: "accept", diagnostics: [{ code: "claim_contended" }] });
    const back = c.hello(hello("codex-b", "I-b"));
    expect(c.gate(back.session, "stop")).toMatchObject({ allow: false, open_errors: [{ code: "claim_wounded", symbol: X }] });
    expect(c.drain(back.session).items).toMatchObject([{ kind: "diagnostic", diagnostic: { code: "claim_wounded" } }]);
  });
});
