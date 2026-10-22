// Cross-agent conflict policy (spec §8.4) is per-repo: `conflicts` in the repo config, recorded at
// init, so the journal replays it exactly. Default (no field) is `hold` and must not change.
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator, type Hello, type Submit } from "@weft/protocol";
import { configFrom, SqlCoordinator, type CoordinatorInit } from "./coordinator";
import { JournaledCoordinator, replay } from "./journal";
import { nodeSql } from "./node-sqlite";

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (id: string, change: string): Hello => ({
  type: "hello",
  protocol: "wcp/0.1",
  agent: { id, harness: "claude-code" },
  capabilities: caps,
  task: { id: `T-${id}` },
  change,
});

/** A repo created with `init` (the same init is passed to replay, as the repo's creation did). */
function repo(init: CoordinatorInit) {
  let t = Date.parse("2026-10-05T12:00:00.000Z");
  const now = () => t;
  const sql = nodeSql();
  SqlCoordinator.init(sql, init);
  return { sql, now, j: new JournaledCoordinator(sql, now) };
}

/** A's signature change on calcTotal is accepted; B, on the old base, calls it: stale_assumption. */
function staleCall(j: JournaledCoordinator) {
  const a = j.call<{ session: string }>("hello", hello("claude-a", "I-a"));
  const b = j.call<{ session: string }>("hello", hello("claude-b", "I-b"));
  j.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
  const r = j.call<{ verdict: string; diagnostics: Array<{ code: string; suggestion?: string }> }>("submit", b.session, {
    type: "submit",
    mode: "commit",
    event: { kind: "edit", base_seq: 1, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] },
  });
  return { a, b, r };
}

/** A's body edit lands; B, on the old base, writes the same symbol: stale_overwrite. */
function overwriteCall(j: JournaledCoordinator) {
  const a = j.call<{ session: string }>("hello", hello("claude-a", "I-a"));
  const b = j.call<{ session: string }>("hello", hello("claude-b", "I-b"));
  j.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
  // Overwrite (R1) is against a committed write: A's change lands on trunk.
  j.call("system", { kind: "land", base_seq: 2, change: "I-a", payload: { sha: "a".repeat(40), op_id: "op-1" } });
  return j.call<{ verdict: string; diagnostics: Array<{ code: string; suggestion?: string }> }>("submit", b.session, {
    type: "submit",
    mode: "commit",
    event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#f", kind: "body" }] },
  });
}

describe("default (no conflicts field): hold, suggestion text unchanged", () => {
  it("config JSON has no conflicts key, so existing configs are byte-identical", () => {
    const cfg = configFrom({ repo: "r" });
    expect("conflicts" in cfg).toBe(false);
    expect(new SqlCoordinator(repo({ repo: "r" }).sql).conflicts).toBe("hold");
  });

  it("stale_assumption suggestion is the hold wording", () => {
    const { r } = staleCall(repo({ repo: "r" }).j);
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics.find((d) => d.code === "stale_assumption")?.suggestion).toBe(
      "Read the new src/pricing.ts#calcTotal (event #3) and update this call site, or negotiate with claude-a.",
    );
  });

  it("stale_overwrite suggestion is the hold wording", () => {
    const r = overwriteCall(repo({ repo: "r" }).j);
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics.find((d) => d.code === "stale_overwrite")?.suggestion).toBe("Rebase onto trunk at or after #4, then redo the edit.");
  });

  it("hold: landing rejected by a trunk change says 'rebase and retry the landing.'", () => {
    const { j } = repo({ repo: "r" });
    const a = j.call<{ session: string; delivered_through: number }>("hello", hello("claude-a", "I-a"));
    const ea = j.call<{ seq: number }>("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
    j.call("system", { kind: "land", base_seq: ea.seq, change: "I-a", payload: { sha: "a".repeat(40), op_id: "op-1" } });
    const b = j.call<{ session: string; delivered_through: number }>("hello", hello("claude-b", "I-b"));
    j.call("submit", b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
    const landing = j.call<{ status: string; diagnostics: Array<{ message: string }> }>("system", { kind: "land", base_seq: ea.seq, change: "I-b", payload: { sha: "b".repeat(40), op_id: "op-2" } });
    expect(landing.status).toBe("rejected");
    expect(landing.diagnostics.map((d) => d.message)).toEqual(["Trunk changed src/x.ts#f in #3 after the landing base #2; rebase and retry the landing."]);
  });

  it("hold: the stale stop gate result is the full object (reason and open_errors)", () => {
    const { j } = repo({ repo: "r" });
    const { b } = staleCall(j);
    expect(j.call("gate", b.session, { type: "gate", gate: "stop" })).toEqual({
      type: "gate.result",
      gate: "stop",
      allow: false,
      reason:
        "1 open Weft error(s) must be resolved first:\n" +
        "[weft error] stale_assumption src/pricing.ts#calcTotal: You use src/pricing.ts#calcTotal, whose signature changed in #3 by claude-a after your base #1. " +
        "(caused by claude-a · task T-claude-a · event #3). Suggestion: Read the new src/pricing.ts#calcTotal (event #3) and update this call site, or negotiate with claude-a.",
      open_errors: [
        {
          severity: "error",
          code: "stale_assumption",
          file: "src/pricing.ts",
          symbol: "src/pricing.ts#calcTotal",
          message: "You use src/pricing.ts#calcTotal, whose signature changed in #3 by claude-a after your base #1.",
          suggestion: "Read the new src/pricing.ts#calcTotal (event #3) and update this call site, or negotiate with claude-a.",
          caused_by_seq: 3,
          caused_by_agent: "claude-a",
          caused_by_task: "T-claude-a",
        },
      ],
    });
  });

  it("hold: the stale agent's stop is refused and the owner gets no diagnostic", () => {
    const { j } = repo({ repo: "r" });
    const { a, b } = staleCall(j);
    expect(j.call<{ allow: boolean }>("gate", b.session, { type: "gate", gate: "stop" }).allow).toBe(false);
    expect(j.call<{ items: Array<{ kind: string }> }>("drain", a.session, 0).items.filter((i) => i.kind === "diagnostic")).toEqual([]);
  });
});

describe("conflicts: continue (repo config)", () => {
  const init: CoordinatorInit = { repo: "r", conflicts: "continue" };

  it("stop and commit are refused with the cross-agent conflict open (as in hold); the owner gets a warning", () => {
    const { j } = repo(init);
    const { a, b, r } = staleCall(j);
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics.map((d) => d.code)).toContain("stale_assumption");

    const stop = j.call<{ allow: boolean; open_errors: unknown[] }>("gate", b.session, { type: "gate", gate: "stop" });
    expect(stop.allow).toBe(false);
    expect(stop.open_errors.length).toBeGreaterThan(0);
    expect(j.call<{ allow: boolean }>("gate", b.session, { type: "gate", gate: "commit" }).allow).toBe(false);

    const told = j.call<{ items: Array<{ kind: string; diagnostic?: { severity: string; code: string; message: string } }> }>("drain", a.session, 0).items.filter((i) => i.kind === "diagnostic");
    const warn = told.find((i) => i.diagnostic?.code === "stale_assumption")?.diagnostic;
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toContain("conflicts with your change");
    expect(j.call<{ allow: boolean }>("gate", a.session, { type: "gate", gate: "commit" }).allow).toBe(true);
  });

  it("a resubmission of the same conflicting edit does not repeat the owner's notice (sequencer and reference)", () => {
    const stale = { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } } satisfies Submit;
    type Items = { items: Array<{ kind: string; diagnostic?: { code: string } }> };
    const notices = (d: Items) => d.items.filter((i) => i.kind === "diagnostic" && i.diagnostic?.code === "stale_assumption");

    const { j } = repo(init);
    const { a, b } = staleCall(j);
    expect(j.call<{ verdict: string }>("submit", b.session, stale).verdict).toBe("reject");
    expect(j.call<{ verdict: string }>("submit", b.session, stale).verdict).toBe("reject");
    expect(notices(j.call<Items>("drain", a.session, 0))).toHaveLength(1);

    const ref = new ReferenceCoordinator({ repo: "r", conflicts: "continue", now: () => Date.parse("2026-10-05T12:00:00.000Z") });
    const ra = ref.hello(hello("claude-a", "I-a"));
    const rb = ref.hello(hello("claude-b", "I-b"));
    ref.submit(ra.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    for (let n = 0; n < 3; n++) expect(ref.submit(rb.session, stale).verdict).toBe("reject");
    expect(notices(ref.drain(ra.session, 0) as Items)).toHaveLength(1);
  });

  it("a landing rejected by another agent's trunk change says not to rebase, and that agent is told once", () => {
    const { j } = repo(init);
    const a = j.call<{ session: string; delivered_through: number }>("hello", hello("claude-a", "I-a"));
    const ea = j.call<{ seq: number }>("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.delivered_through, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
    j.call("system", { kind: "land", base_seq: ea.seq, change: "I-a", payload: { sha: "a".repeat(40), op_id: "op-1" } });
    const b = j.call<{ session: string; delivered_through: number }>("hello", hello("claude-b", "I-b"));
    j.call("submit", b.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: b.delivered_through, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
    const land = () => j.call<{ status: string; diagnostics: Array<{ message: string }> }>("system", { kind: "land", base_seq: ea.seq, change: "I-b", payload: { sha: "b".repeat(40), op_id: "op-2" } });
    const landing = land();
    expect(landing.status).toBe("rejected");
    expect(landing.diagnostics.map((d) => d.message)).toEqual([
      "Trunk changed src/x.ts#f in #3 after the landing base #2; the owner of the change is told if it has a live session; do not rebase and retry the landing to clear it.",
    ]);
    const told = j.call<{ items: Array<{ kind: string; diagnostic?: { severity: string; message: string } }> }>("drain", a.session, 0).items.filter((i) => i.kind === "diagnostic");
    expect(told).toHaveLength(1);
    expect(told[0]?.diagnostic?.severity).toBe("warning");
    expect(told[0]?.diagnostic?.message).toBe("claude-b's landing touching src/x.ts#f conflicts with your change #3.");
  });

  it("a rejected claim is called a claim in the owner's notice, not an edit (sequencer and reference)", () => {
    const wd: CoordinatorInit = { repo: "r", conflicts: "continue", policy: "wait-die" };
    const edit = { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#f", kind: "body" }] } } satisfies Submit;
    const claim = { type: "submit", mode: "commit", event: { kind: "claim", base_seq: 2, writes: [{ key: "src/x.ts#f", kind: "body" }], payload: { firm: false, source: "explicit" } } } satisfies Submit;
    type Items = { items: Array<{ kind: string; diagnostic?: { code: string; message: string } }> };
    const msgs = (d: Items) => d.items.filter((i) => i.kind === "diagnostic").map((i) => `${i.diagnostic?.code}: ${i.diagnostic?.message}`);
    const expected = ["claim_die: claude-b's claim on src/x.ts#f conflicts with your change #3."];

    const { j } = repo(wd);
    const a = j.call<{ session: string }>("hello", hello("claude-a", "I-a"));
    const b = j.call<{ session: string }>("hello", hello("claude-b", "I-b"));
    j.call("submit", a.session, edit);
    expect(j.call<{ verdict: string }>("submit", b.session, claim).verdict).toBe("reject");
    expect(msgs(j.call<Items>("drain", a.session, 0))).toEqual(expected);

    const ref = new ReferenceCoordinator({ repo: "r", conflicts: "continue", policy: "wait-die" });
    const ra = ref.hello(hello("claude-a", "I-a"));
    const rb = ref.hello(hello("claude-b", "I-b"));
    ref.submit(ra.session, edit);
    expect(ref.submit(rb.session, claim).verdict).toBe("reject");
    expect(msgs(ref.drain(ra.session, 0) as Items)).toEqual(expected);
  });

  it("the editor's stale_assumption suggestion uses the continue wording", () => {
    const { r } = staleCall(repo(init).j);
    expect(r.diagnostics.find((d) => d.code === "stale_assumption")?.suggestion).toContain("Keep editing your other tasks");
  });

  it("the editor's stale_overwrite suggestion uses the continue wording", () => {
    const r = overwriteCall(repo(init).j);
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics.find((d) => d.code === "stale_overwrite")?.suggestion).toContain("Keep editing your other tasks");
    // Owner notices go to live sessions only (spec §8.4), so the editor is not promised more.
    expect(r.diagnostics.find((d) => d.code === "stale_overwrite")?.suggestion).toMatch(/claude-a owns the conflict and is told about it if it has a live session\.$/);
  });

  it("use first, contract change second: the user's change gets a gate-closing stale_assumption in continue wording, the owner a notice (sequencer and reference)", () => {
    const { j } = repo(init);
    const ref = new ReferenceCoordinator({ repo: "r", conflicts: "continue", now: () => Date.parse("2026-10-05T12:00:00.000Z") });
    const use: Submit = { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 2, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } };
    const change: Submit = { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } };
    const a = j.call<{ session: string }>("hello", hello("claude-a", "I-a"));
    const b = j.call<{ session: string }>("hello", hello("claude-b", "I-b"));
    j.call("submit", b.session, use);
    const owner = j.call<{ verdict: string; inbox: Array<{ diagnostic?: { severity: string; code: string } }> }>("submit", a.session, change);
    const ra = ref.hello(hello("claude-a", "I-a"));
    const rb = ref.hello(hello("claude-b", "I-b"));
    ref.submit(rb.session, use);
    expect(ref.submit(ra.session, change)).toEqual(owner);
    expect(owner.verdict).toBe("accept");
    expect(owner.inbox.map((i) => [i.diagnostic?.severity, i.diagnostic?.code])).toEqual([["warning", "stale_assumption"]]);
    const told = j.call<{ items: Array<{ diagnostic?: { code: string; severity: string; suggestion?: string } }> }>("drain", b.session, 0);
    expect(told).toEqual(ref.drain(rb.session, 0));
    expect(told.items.map((i) => i.diagnostic?.code)).toEqual(["stale_assumption"]);
    expect(told.items[0]!.diagnostic?.suggestion).toBe(
      "Keep editing your other tasks, but the commit gate stays closed while this error is open: report it instead of working around it. Do not adapt your call sites to claude-a's new src/pricing.ts#calcTotal (event #4) or adopt their partial work: claude-a owns the conflict.",
    );
    const gate = j.call<{ allow: boolean }>("gate", b.session, { type: "gate", gate: "commit" });
    expect(gate.allow).toBe(false);
    expect(gate).toEqual(ref.gate(rb.session, { type: "gate", gate: "commit" }));
  });

  it("matches the reference coordinator for the same repo config", () => {
    const { j } = repo(init);
    const { b, r } = staleCall(j);
    const ref = new ReferenceCoordinator({ repo: "r", conflicts: "continue", now: () => Date.parse("2026-10-05T12:00:00.000Z") });
    const ra = ref.hello(hello("claude-a", "I-a"));
    const rb = ref.hello(hello("claude-b", "I-b"));
    ref.submit(ra.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, files: ["src/pricing.ts"], reads: [], writes: [{ key: "src/pricing.ts#calcTotal", kind: "signature" }] } });
    const rr = ref.submit(rb.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, files: ["src/cart.ts"], reads: ["src/pricing.ts#calcTotal"], writes: [{ key: "src/cart.ts#cartSummary", kind: "body" }] } });
    expect(r.diagnostics).toEqual(rr.diagnostics);
    expect(j.call("gate", b.session, { type: "gate", gate: "stop" })).toEqual(ref.gate(rb.session, { type: "gate", gate: "stop" }));
  });

  it("journal replay with the same repo config reproduces the log, state and every result exactly", () => {
    const live = repo(init);
    const { a, b } = staleCall(live.j);
    live.j.call("gate", b.session, { type: "gate", gate: "stop" });
    live.j.call("gate", b.session, { type: "gate", gate: "commit" });
    live.j.call("drain", a.session, 0);
    const entries = live.j.journal();
    const re = replay(nodeSql(), init, entries);
    expect(JSON.stringify(re.coord.dump())).toBe(JSON.stringify(live.j.coord.dump()));
    expect(re.coord.conflicts).toBe("continue");
    expect(replay(nodeSql(), init, entries).results).toEqual(re.results);
    // The policy is in the config: replaying the same journal under hold is a different repo.
    const holdReplay = replay(nodeSql(), { repo: "r" }, entries);
    expect(JSON.stringify(holdReplay.coord.dump())).not.toBe(JSON.stringify(live.j.coord.dump()));
  });
});
