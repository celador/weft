// Recorded dependencies hold the landing queue (spec §6.7, issue #7): a queued change whose
// dependency has not landed is `held_by` it, a batch never claims it, and it is released when the
// dependency lands or is abandoned (with a system message to the dependent's owner). The same rule
// (`dependencies()`) is checked against the reference coordinator here and, step by step, in the
// `dependencies-hold-landing` conformance scenario.
import { describe, expect, it } from "vitest";
import { ReferenceCoordinator, type Hello, type Submit } from "@weft/protocol";
import { SqlCoordinator } from "./coordinator";
import { JournaledCoordinator, replay, type JournalOp } from "./journal";
import { nodeSql } from "./node-sqlite";

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (agent: string, change: string, task: string): Hello => ({ type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "codex" }, capabilities: caps, task: { id: task }, change });
const edit = (base: number, writes: Array<[string, "new" | "body" | "signature"]>, reads: string[] = []): Submit => ({
  type: "submit",
  mode: "commit",
  event: { kind: "edit", base_seq: base, writes: writes.map(([key, kind]) => ({ key, kind })), reads },
});
const NEW = "src/auth/session.ts#createSession";
const PLAN = "src/billing/plan.ts#Plan";

function fresh() {
  const sql = nodeSql();
  SqlCoordinator.init(sql, { repo: "r" });
  let t = Date.parse("2026-11-26T12:00:00.000Z");
  const j = new JournaledCoordinator(sql, () => t);
  const ref = new ReferenceCoordinator({ repo: "r", now: () => t });
  /** Run one call on both coordinators, one clock tick per call. */
  const both = <T>(op: JournalOp, ...args: unknown[]): T => {
    t += 1;
    const out = j.call<T>(op, ...args);
    (ref as unknown as Record<string, (...a: unknown[]) => unknown>)[op]!(...args);
    return out;
  };
  return { j, ref, both };
}

/** A relies on nothing; B uses A's new createSession and C's new Plan (B's records: #4 and #6). */
function setup() {
  const f = fresh();
  const a = f.both<{ session: string }>("hello", hello("claude-a", "A", "T-1")).session;
  const b = f.both<{ session: string }>("hello", hello("codex-b", "B", "T-2")).session;
  const c = f.both<{ session: string }>("hello", hello("gemini-c", "C", "T-3")).session;
  f.both("submit", a, edit(1, [[NEW, "new"]])); // #4
  f.both("submit", c, edit(3, [[PLAN, "new"]])); // #5
  f.both("submit", b, edit(2, [["src/routes/signup.ts#signup", "body"]], [NEW, PLAN])); // #6
  return { ...f, a, b, c };
}

describe("dependencies hold the landing queue (#7)", () => {
  it("both coordinators record the same dependency and report the same hold", () => {
    const { j, ref } = setup();
    expect(j.coord.event(6).depends_on).toEqual([
      { change: "A", agent: "claude-a", task: "T-1", seq: 4, keys: [NEW] },
      { change: "C", agent: "gemini-c", task: "T-3", seq: 5, keys: [PLAN] },
    ]);
    expect(j.coord.event(6)).toEqual(ref.event(6));
    expect(j.coord.dependencies("B")).toEqual(ref.dependencies("B"));
    expect(j.coord.dependencies("B")).toMatchObject({ held: true, held_by: ["A", "C"] });
  });

  it("a dependent change stays queued, unclaimable by a batch, until its dependency lands", () => {
    const { j, both } = setup();
    const qb = j.call<{ id: number; held_by?: string[] }>("enqueue", "B", "human:john");
    expect(qb.held_by).toEqual(["A", "C"]);
    const qa = j.call<{ id: number; held_by?: string[] }>("enqueue", "A", "human:john");
    expect(qa.held_by).toBeUndefined();
    // A (its own queue turn) leads a batch: B is behind it but held, so it is not taken.
    j.call("queue_status", qa.id, "landing", "workflow wf-a");
    const qb2 = j.call<{ id: number }>("enqueue", "B", "human:john"); // idempotent
    expect(qb2.id).toBe(qb.id);
    expect(j.call<Array<{ id: number }>>("queue_claim", qa.id, [qb.id]).map((e) => e.id)).toEqual([qa.id]);
    expect(j.coord.queue().find((e) => e.id === qb.id)).toMatchObject({ status: "queued", held_by: ["A", "C"] });
    // A lands: B is still held by C.
    both("system", { kind: "land", base_seq: 6, change: "A", payload: { sha: "a".repeat(40), op_id: "op-a" } }); // #7
    expect(j.coord.queue().find((e) => e.id === qb.id)).toMatchObject({ status: "queued", held_by: ["C"] });
    // C lands: nothing holds B, and a batch may take it now.
    both("system", { kind: "land", base_seq: 7, change: "C", payload: { sha: "c".repeat(40), op_id: "op-c" } }); // #8
    const freed = j.coord.queue().find((e) => e.id === qb.id)!;
    expect(freed.status).toBe("queued");
    expect(freed.held_by).toBeUndefined();
  });

  it("an abandoned dependency releases the hold, and the dependent's owner is told by a system message", () => {
    const { j, ref, both, b } = setup();
    const qb = j.call<{ id: number }>("enqueue", "B", "human:john");
    both("system", { kind: "land", base_seq: 6, change: "A", payload: { sha: "a".repeat(40), op_id: "op-a" } }); // #7
    both("drain", b, 100);
    // The platform abandons C (gateway DELETE /changes/C appends this): #8, then the notice #9.
    const rel = both<{ seq: number; status: string }>("system", { kind: "release", base_seq: 7, change: "C", payload: { reason: "abandoned" } }, { type: "system", id: "artifacts" });
    expect(rel).toMatchObject({ seq: 8, status: "accepted" });
    const notice = j.coord.event(9);
    expect(notice).toMatchObject({ kind: "message", status: "accepted", actor: { type: "system", id: "coordinator" }, payload: { to: { change: "B" }, intent: "info" } });
    expect(String(notice.payload?.text)).toContain("C (gemini-c, task T-3) will not land: abandoned in #8. Your change B relies on it for src/billing/plan.ts#Plan.");
    expect(notice).toEqual(ref.event(9));
    expect(j.call<{ items: Array<{ seq: number; kind: string }> }>("drain", b).items.map((i) => [i.seq, i.kind])).toEqual([[9, "message"]]);
    expect(j.coord.queue().find((e) => e.id === qb.id)!.held_by).toBeUndefined();
    expect(j.coord.dependencies("B")).toMatchObject({ held: false, depends_on: [{ change: "A", status: "landed", status_seq: 7 }, { change: "C", status: "abandoned", status_seq: 8, holds: false }] });
    // Once per abandonment: a second abandoning release tells nobody again.
    j.call("system", { kind: "release", base_seq: 9, change: "C", payload: { reason: "abandoned" } });
    expect(j.coord.head).toBe(10);
    // An agent's own keyless release is a retreat, not an abandonment.
    const f = setup();
    f.both("submit", f.c, { type: "submit", mode: "commit", event: { kind: "release", base_seq: 5, payload: { reason: "abandoned" } } });
    expect(f.j.coord.dependencies("B").held_by).toEqual(["A", "C"]);
  });

  it("the landing of an alternative abandons the losing candidate; its dependents are released and told", () => {
    const f = fresh();
    const a1 = f.both<{ session: string }>("hello", hello("claude-a", "A1", "T-1")).session;
    f.both("hello", hello("codex-a", "A2", "T-1"));
    const b = f.both<{ session: string }>("hello", hello("gemini-b", "B", "T-2")).session;
    f.both("submit", a1, edit(1, [[NEW, "new"]])); // #4
    f.both("submit", b, edit(3, [["src/x.ts#x", "body"]], [NEW])); // #5: relies on A1
    expect(f.j.coord.dependencies("B").held_by).toEqual(["A1"]);
    // A2 wins the selection: A1 lost and will not land.
    f.both("system", { kind: "land", base_seq: 5, change: "A2", payload: { sha: "b".repeat(40), op_id: "op-a2" } }); // #6, notice #7
    expect(f.j.coord.dependencies("B")).toMatchObject({ held: false, depends_on: [{ change: "A1", status: "abandoned", status_seq: 6 }] });
    expect(f.j.coord.event(7)).toMatchObject({ kind: "message", payload: { to: { change: "B" } } });
    expect(String(f.j.coord.event(7).payload?.text)).toContain("A2 landed instead (#6)");
    expect(f.j.coord.event(7)).toEqual(f.ref.event(7));
  });

  it("the journal replays the dependency records, notices and holds exactly", () => {
    const { j, both } = setup();
    j.call("enqueue", "B", "human:john");
    both("system", { kind: "release", base_seq: 6, change: "C", payload: { reason: "abandoned" } });
    const all = ["queued", "landing", "landed", "failed", "cancelled"];
    const { coord } = replay(nodeSql(), { repo: "r" }, j.journal());
    expect(coord.queue(all)).toEqual(j.coord.queue(all));
    expect(coord.dependencies("B")).toEqual(j.coord.dependencies("B"));
    expect(JSON.stringify(coord.dump())).toBe(JSON.stringify(j.coord.dump()));
  });
});
