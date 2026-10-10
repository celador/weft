// Cross-agent conflict policy (spec §8.4) is per-repo: `conflicts` in the repo config, recorded at
// init, so the journal replays it exactly. Default (no field) is `hold` and must not change.
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator, type Hello } from "@weft/protocol";
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

  it("hold: the stale agent's stop is refused and the owner gets no diagnostic", () => {
    const { j } = repo({ repo: "r" });
    const { a, b } = staleCall(j);
    expect(j.call<{ allow: boolean }>("gate", b.session, { type: "gate", gate: "stop" }).allow).toBe(false);
    expect(j.call<{ items: Array<{ kind: string }> }>("drain", a.session, 0).items.filter((i) => i.kind === "diagnostic")).toEqual([]);
  });
});

describe("conflicts: continue (repo config)", () => {
  const init: CoordinatorInit = { repo: "r", conflicts: "continue" };

  it("stop is allowed with the cross-agent conflict open, commit is refused, the owner gets a warning", () => {
    const { j } = repo(init);
    const { a, b, r } = staleCall(j);
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics.map((d) => d.code)).toContain("stale_assumption");

    const stop = j.call<{ allow: boolean; open_errors: unknown[] }>("gate", b.session, { type: "gate", gate: "stop" });
    expect(stop.allow).toBe(true);
    expect(stop.open_errors.length).toBeGreaterThan(0);
    expect(j.call<{ allow: boolean }>("gate", b.session, { type: "gate", gate: "commit" }).allow).toBe(false);

    const told = j.call<{ items: Array<{ kind: string; diagnostic?: { severity: string; code: string; message: string } }> }>("drain", a.session, 0).items.filter((i) => i.kind === "diagnostic");
    const warn = told.find((i) => i.diagnostic?.code === "stale_assumption")?.diagnostic;
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toContain("conflicts with your change");
    expect(j.call<{ allow: boolean }>("gate", a.session, { type: "gate", gate: "commit" }).allow).toBe(true);
  });

  it("the editor's stale_assumption suggestion uses the continue wording", () => {
    const { r } = staleCall(repo(init).j);
    expect(r.diagnostics.find((d) => d.code === "stale_assumption")?.suggestion).toContain("Keep working on your other tasks");
  });

  it("the editor's stale_overwrite suggestion uses the continue wording", () => {
    const r = overwriteCall(repo(init).j);
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics.find((d) => d.code === "stale_overwrite")?.suggestion).toContain("Keep working on your other tasks");
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
