// Batched landing with bisect (t_5f9c01c1): the land queue head stacks the queued changes,
// runs presubmit once, bisects on failure, lands the passing prefix with one CAS push and
// keeps one op (and one revert path) per change. Real git + weft-job.mjs, as workflows.test.ts.
import { describe, expect, it } from "vitest";
import { batchConfig } from "../src/core/workflows";
import { BASE, FakeStep, world, type Cand } from "./harness";

const P = BASE["src/pricing.ts"]!;
const BUG = P.replace("s + (", "s - ("); // calcTotal goes negative: test/pricing.test.ts fails

type W = Awaited<ReturnType<typeof world>>;

async function four(w: W, bug?: "c") {
  const a = await w.candidate("t-a", "claude-a");
  const b = await w.candidate("t-b", "codex-b");
  const c = await w.candidate("t-c", "cursor-c");
  const d = await w.candidate("t-d", "gemini-d");
  await a.push({ "src/a.ts": "export const a = 1;\n" }, "a: add a");
  await b.push({ "src/b.ts": "export const b = 2;\n" }, "b: add b");
  await c.push(bug === "c" ? { "src/c.ts": "export const c = 3;\n", "src/pricing.ts": BUG } : { "src/c.ts": "export const c = 3;\n" }, "c: add c");
  await d.push({ "src/d.ts": "export const d = 4;\n" }, "d: add d");
  return [a, b, c, d] as const;
}
/** Queue all of them first (as concurrent LandChange workflows would), in order. */
function enqueue(w: W, cs: readonly Cand[]) {
  return cs.map((c) => w.j.call<{ id: number }>("enqueue", c.change, "human:john").id);
}
function points(w: W) {
  const out: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  w.deps.metrics = { writeDataPoint: (p) => void out.push(p) };
  return out;
}
const jobsOf = (w: W, kind: string) => w.jobs.started.filter((s) => s.req.spec.job === kind);

describe("batched landing", () => {
  it("lands 4 queued changes as one batch: one presubmit, one CAS push, one op + landing range per change; followers see their outcome", async () => {
    const w = await world();
    const pts = points(w);
    const cs = await four(w);
    const [a, b, c, d] = cs;
    const qids = enqueue(w, cs);
    const t0 = w.tip();

    // B's own workflow is waiting for its turn when A's (the head's) runs.
    let leader: Awaited<ReturnType<typeof w.wf.land>> | undefined;
    const sb = new FakeStep();
    sb.onSleep = async (name) => {
      if (name === "queue wait 0") leader = await w.wf.land(a);
    };
    const rb = await w.wf.land(b, sb);

    expect(leader).toMatchObject({ status: "landed", before: t0, queue_id: qids[0], batch: { leader: qids[0], size: 4, rounds: 1, presubmit_runs: 1, presubmit_runs_saved: 3, bisect_steps: 0, culprits: [], conflicts: [] } });
    expect(leader!.batch!.landed).toEqual(cs.map((x) => x.change));
    // one land_batch job, no per-change land jobs, one push
    expect(jobsOf(w, "land_batch")).toHaveLength(1);
    expect(jobsOf(w, "land")).toHaveLength(0);
    expect(jobsOf(w, "land_batch")[0]!.req.forks!.map((f) => f.remote)).toEqual(cs.map((x) => x.remote));

    // one land op per change, in queue order, each its own trunk range (chained)
    const ops = w.j.coord.ops() as Array<{ op_id: string; kind: string; change_id: string; sha: string; seq: number }>;
    expect(ops.map((o) => [o.kind, o.change_id])).toEqual(cs.map((x) => ["land", x.change]));
    const lands = w.q<{ op_id: string; change_id: string; before_sha: string; after_sha: string }>(`SELECT op_id, change_id, before_sha, after_sha FROM landings ORDER BY seq`);
    expect(lands.map((l) => l.change_id)).toEqual(cs.map((x) => x.change));
    expect(lands[0]!.before_sha).toBe(t0);
    for (let i = 1; i < 4; i++) expect(lands[i]!.before_sha).toBe(lands[i - 1]!.after_sha);
    expect(w.tip()).toBe(lands[3]!.after_sha);
    expect(new Set(lands.map((l) => l.after_sha)).size).toBe(4);
    for (const [i, f] of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].entries()) {
      expect(await w.show(lands[i]!.after_sha, f)).toBeTruthy();
      if (i < 3) expect(await w.show(lands[i]!.after_sha, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"][i + 1]!)).toBeNull();
    }
    // the land events carry the batch position
    expect(w.j.coord.event(ops[2]!.seq)).toMatchObject({ kind: "land", status: "accepted", payload: { x_batch: { leader: qids[0], position: 3, size: 4, round: 1 } } });

    // queue + D1
    expect(w.j.coord.queue(["landed"]).map((e) => [e.change, e.batch])).toEqual(cs.map((x) => [x.change, qids[0]]));
    expect(w.q(`SELECT status FROM changes ORDER BY created_at`)).toEqual(cs.map(() => ({ status: "landed" })));
    const ev = w.q<{ kind: string; status: string; data: string }>(`SELECT kind, status, data FROM evidence WHERE change_id = ? ORDER BY id`, d.change);
    expect(ev.map((e) => [e.kind, e.status])).toEqual([
      ["land", "pass"],
      ["presubmit", "pass"],
    ]);
    expect(JSON.parse(ev[0]!.data).batch).toMatchObject({ leader: qids[0], position: 4, size: 4, presubmit_runs: 1, bisect_steps: 0 });

    // B (a follower) reports what its leader did
    expect(rb).toMatchObject({ status: "landed", op_id: ops[1]!.op_id, before: lands[0]!.after_sha, after: lands[1]!.after_sha, queue_id: qids[1], batch: { leader: qids[0] } });
    expect(jobsOf(w, "land_batch")).toHaveLength(1);
    // C and D's workflows, starting late, find their change landed
    expect(await w.wf.land(c)).toEqual({ status: "already_landed" });

    // Analytics Engine: one point for the round
    expect(pts).toEqual([{ indexes: ["weft-demo"], blobs: ["land.batch", "ok", `#${qids[0]}`], doubles: [4, 1, 3, 0, 4, 0, 0, 1] }]);
  });

  it("bisects a planted failure: lands the passing prefix, bounces the culprit with the failing tests, re-stacks the rest", async () => {
    const w = await world();
    const pts = points(w);
    const cs = await four(w, "c");
    const [a, b, c, d] = cs;
    const qids = enqueue(w, cs);
    const t0 = w.tip();
    // C's own workflow is waiting for its turn when the head's runs.
    let r!: Awaited<ReturnType<typeof w.wf.land>>;
    const sc = new FakeStep();
    sc.onSleep = async (name) => {
      if (name === "queue wait 0") r = await w.wf.land(a);
    };
    const rc = await w.wf.land(c, sc);

    // round 1: tip (4) fails, prefix 2 passes, prefix 3 fails -> C; A+B pushed. round 2: D alone.
    expect(r).toMatchObject({ status: "landed", batch: { size: 4, rounds: 2, presubmit_runs: 4, presubmit_runs_saved: 0, bisect_steps: 2, culprits: [c.change], conflicts: [] } });
    expect(r.batch!.landed).toEqual([a.change, b.change, d.change]);
    const jobs = jobsOf(w, "land_batch");
    expect(jobs.map((j) => (j.req.spec.changes as Array<{ change: string }>).map((x) => x.change))).toEqual([cs.map((x) => x.change), [d.change]]);

    const ev = w.q<{ kind: string; status: string; data: string }>(`SELECT kind, status, data FROM evidence WHERE change_id = ? ORDER BY id`, c.change);
    expect(ev.map((e) => [e.kind, e.status])).toEqual([
      ["land", "fail"],
      ["presubmit", "fail"],
    ]);
    const landFail = JSON.parse(ev[0]!.data);
    expect(landFail.reason).toMatch(/isolated by bisect/);
    expect(landFail.batch.tested).toEqual([
      { prefix: 4, status: "fail", ms: expect.any(Number) },
      { prefix: 2, status: "pass", ms: expect.any(Number) },
      { prefix: 3, status: "fail", ms: expect.any(Number) },
    ]);
    expect(JSON.parse(ev[1]!.data).summary).toMatchObject({ fail: 1 });

    // trunk: A, B, D landed; C's bug never reached trunk
    const lands = w.q<{ change_id: string; before_sha: string; after_sha: string }>(`SELECT change_id, before_sha, after_sha FROM landings ORDER BY seq`);
    expect(lands.map((l) => l.change_id)).toEqual([a.change, b.change, d.change]);
    expect(lands[0]!.before_sha).toBe(t0);
    expect(lands[2]!.before_sha).toBe(lands[1]!.after_sha);
    expect(w.tip()).toBe(lands[2]!.after_sha);
    expect(await w.show(w.tip(), "src/pricing.ts")).toBe(P.trim());
    expect(await w.show(w.tip(), "src/c.ts")).toBeNull();
    expect(await w.show(w.tip(), "src/d.ts")).toBe("export const d = 4;");

    // the culprit's agent is told, with the failing test output
    const inbox = w.j.call<{ items: Array<{ kind: string; record?: { payload?: { text?: string } } }> }>("drain", c.session);
    const msg = inbox.items.find((i) => i.kind === "message")?.record?.payload?.text ?? "";
    expect(msg).toMatch(/^Tests fail on your change rebased onto trunk/);
    expect(msg).toMatch(/fail 1/);
    expect(w.j.coord.queue(["failed"]).map((e) => e.change)).toEqual([c.change]);
    expect(w.q(`SELECT status FROM changes WHERE id = ?`, c.change)).toEqual([{ status: "open" }]);
    // C's own workflow reports the failure (no land job of its own)
    expect(rc).toMatchObject({ status: "failed", reason: expect.stringMatching(/isolated by bisect/), queue_id: qids[2], batch: { leader: qids[0] } });
    expect(jobsOf(w, "land")).toHaveLength(0);

    expect(pts.map((p) => p.doubles)).toEqual([
      [4, 3, 0, 2, 2, 1, 0, 1], // round size, runs, saved, bisect steps, landed, culprits, conflicts, round
      [1, 1, 0, 0, 1, 0, 0, 2],
    ]);
    expect(qids).toHaveLength(4);
  });

  it("revert one change of a batch: only its own range is reverted, the rest of the batch stays", async () => {
    const w = await world();
    const cs = await four(w);
    const [a, b] = cs;
    enqueue(w, cs);
    await w.wf.land(a);
    const op = (w.j.coord.ops() as Array<{ op_id: string; change_id: string }>).find((o) => o.change_id === b.change)!;
    const r = await w.revertOperation({ repo: w.repo, op_id: op.op_id, reason: "error spike after landing" }, new FakeStep(), w.deps, "revert-b");
    expect(r).toMatchObject({ status: "reverted", reverts_op_id: op.op_id });
    expect(w.tip()).toBe(r.sha);
    expect(await w.show(r.sha!, "src/b.ts")).toBeNull();
    for (const f of ["src/a.ts", "src/c.ts", "src/d.ts"]) expect(await w.show(r.sha!, f)).toBeTruthy();
    expect(w.q(`SELECT change_id, status FROM landings WHERE kind = 'land' ORDER BY seq`).map((x) => x)).toEqual([
      { change_id: cs[0].change, status: "landed" },
      { change_id: b.change, status: "reverted" },
      { change_id: cs[2].change, status: "landed" },
      { change_id: cs[3].change, status: "landed" },
    ]);
    expect(w.q(`SELECT id, status FROM tasks WHERE id = 't-b'`)).toEqual([{ id: "t-b", status: "open" }]);
  });

  it("a change that conflicts while stacking is dropped and bounced; the others land in the same push", async () => {
    const w = await world();
    const a = await w.candidate("t-a", "claude-a");
    const b = await w.candidate("t-b", "codex-b");
    const c = await w.candidate("t-c", "cursor-c");
    await a.push({ "src/a.ts": "export const a = 1;\n" }, "a");
    await b.push({ "src/pricing.ts": P.replace("apple: 1", "apple: 2") }, "b: apple 2");
    await c.push({ "src/pricing.ts": P.replace("apple: 1", "apple: 3") }, "c: apple 3");
    enqueue(w, [a, b, c]);
    const r = await w.wf.land(a);
    expect(r).toMatchObject({ status: "landed", batch: { size: 3, rounds: 1, presubmit_runs: 1, conflicts: [c.change], culprits: [] } });
    expect(r.batch!.landed).toEqual([a.change, b.change]);
    expect(await w.show(w.tip(), "src/pricing.ts")).toContain("apple: 2");
    const inbox = w.j.call<{ items: Array<{ kind: string; record?: { payload?: { text?: string } } }> }>("drain", c.session);
    expect(inbox.items.find((i) => i.kind === "message")?.record?.payload?.text).toContain("src/pricing.ts");
    expect(w.j.coord.queue(["failed"]).map((e) => e.change)).toEqual([c.change]);
  });

  it("a lone change lands exactly as before (one `land` job, no wait); `land.batch: false` keeps one presubmit per change", async () => {
    const w = await world();
    const a = await w.candidate("t-a", "claude-a");
    await a.push({ "src/a.ts": "export const a = 1;\n" }, "a");
    const step = new FakeStep();
    const r = await w.wf.land(a, step);
    expect(r).toMatchObject({ status: "landed", attempts: 1 });
    expect(r.batch).toBeUndefined();
    expect(jobsOf(w, "land")).toHaveLength(1);
    expect(jobsOf(w, "land_batch")).toHaveLength(0);
    expect(step.sleeps.filter((s) => s.startsWith("batch"))).toEqual([]);

    const w2 = await world({ config: { tests: { command: ["node", "--test"], timeout_s: 120 }, land: { batch: false } } });
    const x = await w2.candidate("t-x", "claude-a");
    const y = await w2.candidate("t-y", "codex-b");
    await x.push({ "src/x.ts": "export const x = 1;\n" }, "x");
    await y.push({ "src/y.ts": "export const y = 1;\n" }, "y");
    enqueue(w2, [x, y]);
    expect((await w2.wf.land(x)).status).toBe("landed");
    expect(w2.j.coord.queue(["queued"]).map((e) => e.change)).toEqual([y.change]);
    expect(jobsOf(w2, "land_batch")).toHaveLength(0);
  });

  it("lingers up to wait_s for the batch to fill when it already has company", async () => {
    const w = await world();
    const a = await w.candidate("t-a", "claude-a");
    const b = await w.candidate("t-b", "codex-b");
    const c = await w.candidate("t-c", "cursor-c");
    await a.push({ "src/a.ts": "export const a = 1;\n" }, "a");
    await b.push({ "src/b.ts": "export const b = 1;\n" }, "b");
    await c.push({ "src/c.ts": "export const c = 1;\n" }, "c");
    enqueue(w, [a, b]);
    const step = new FakeStep();
    step.onSleep = (name) => {
      if (name === "batch: linger 0") w.j.call("enqueue", c.change, "human:john"); // C arrives while A lingers
    };
    const r = await w.wf.land(a, step);
    expect(step.sleeps.filter((s) => s.startsWith("batch: linger"))).toEqual(expect.arrayContaining(["batch: linger 0"]));
    expect(r).toMatchObject({ status: "landed", batch: { size: 3, presubmit_runs: 1 } });
  });

  it("batch config: default 4 / 30 s, clamped; false or max < 2 disables", () => {
    expect(batchConfig({})).toEqual({ max: 4, wait_s: 30 });
    expect(batchConfig({ land: { batch: { max: 8, wait_s: 5 } } })).toEqual({ max: 8, wait_s: 5 });
    expect(batchConfig({ land: { batch: { max: 99, wait_s: 9999 } } })).toEqual({ max: 16, wait_s: 600 });
    expect(batchConfig({ land: { batch: false } })).toBeNull();
    expect(batchConfig({ land: { batch: { max: 1 } } })).toBeNull();
  });
});
