// Landing holds for recorded dependencies (spec §6.7, issue #7), through the LandChange workflow:
// a change whose recorded dependency has not landed waits in the submit queue even when it is the
// queue head, the change behind it lands first, and the dependent lands once its dependency has.
// Real git + weft-job.mjs and a journaled SqlCoordinator, as workflows.test.ts.
import { describe, expect, it } from "vitest";
import type { EventRecord, Submit } from "@weft/protocol";
import { FakeStep, world, type Cand } from "./harness";

type W = Awaited<ReturnType<typeof world>>;

const edit = (base: number, writes: Array<[string, "new" | "body"]>, reads: string[] = []): Submit => ({
  type: "submit",
  mode: "commit",
  event: { kind: "edit", base_seq: base, writes: writes.map(([key, kind]) => ({ key, kind })), reads },
});

/** A adds `a`; B's edit reads it, so B's record depends on A. Both pushed. */
async function pair(w: W): Promise<[Cand, Cand]> {
  const a = await w.candidate("t-a", "claude-a");
  const b = await w.candidate("t-b", "codex-b");
  const head = () => w.j.coord.summary().head_seq;
  w.j.call("drain", a.session);
  w.j.call("submit", a.session, edit(head(), [["src/a.ts#a", "new"]]));
  w.j.call("drain", b.session);
  const v = w.j.call<{ seq: number }>("submit", b.session, edit(head(), [["src/b.ts#b", "new"]], ["src/a.ts#a"]));
  expect(w.j.coord.event(v.seq).depends_on).toEqual([expect.objectContaining({ change: a.change, keys: ["src/a.ts#a"] })]);
  await a.push({ "src/a.ts": "export const a = 1;\n" }, "a: add a");
  await b.push({ "src/b.ts": "export const b = 2;\n" }, "b: add b");
  return [a, b];
}

const landSeq = (w: W, change: string) => (w.j.coord.ops() as Array<{ kind: string; change_id: string; seq: number }>).find((o) => o.kind === "land" && o.change_id === change)?.seq;

describe("LandChange holds a change until its recorded dependencies land (#7)", () => {
  it("the dependent, queued first, waits; its dependency lands first; then the dependent lands", async () => {
    const w = await world();
    const [a, b] = await pair(w);
    const qb = w.j.call<{ id: number; held_by?: string[] }>("enqueue", b.change, "human:john");
    expect(qb.held_by).toEqual([a.change]);
    w.j.call("enqueue", a.change, "human:john");

    let seenWhileWaiting: unknown;
    let ra: Awaited<ReturnType<W["wf"]["land"]>> | undefined;
    const sb = new FakeStep();
    sb.onSleep = async (name) => {
      if (name !== "queue wait 0") return;
      // B is the queue head but held: A (behind it) gets the turn and lands.
      seenWhileWaiting = w.j.coord.queue().map((e) => [e.change, e.held_by ?? []]);
      ra = await w.wf.land(a);
    };
    const rb = await w.wf.land(b, sb);

    expect(seenWhileWaiting).toEqual([
      [b.change, [a.change]],
      [a.change, []],
    ]);
    expect(ra).toMatchObject({ status: "landed" });
    expect(rb).toMatchObject({ status: "landed" });
    expect(sb.sleeps).toContain("queue wait 0");
    expect(landSeq(w, a.change)).toBeLessThan(landSeq(w, b.change)!);
    expect(w.j.coord.dependencies(b.change)).toMatchObject({ landed: true, depends_on: [{ change: a.change, status: "landed" }] });
  });

  it("a dependency that never lands keeps the dependent queued until the queue wait runs out, and the failure says why", async () => {
    const w = await world();
    const [a, b] = await pair(w);
    const rb = await w.wf.land(b);
    expect(rb).toMatchObject({ status: "failed", reason: `timed out waiting for dependencies to land: ${a.change}` });
    expect(w.j.coord.queue(["failed"])).toEqual([expect.objectContaining({ change: b.change, note: `timed out waiting for dependencies to land: ${a.change}` })]);
    expect(landSeq(w, b.change)).toBeUndefined();
  });

  it("an abandoned dependency releases the hold: the dependent lands, and its owner was told", async () => {
    const w = await world();
    const [a, b] = await pair(w);
    const sb = new FakeStep();
    sb.onSleep = async (name) => {
      if (name === "queue wait 0") w.j.call("system", { kind: "release", base_seq: w.j.coord.summary().head_seq, change: a.change, payload: { reason: "abandoned" } }, { type: "system", id: "artifacts" });
    };
    expect(await w.wf.land(b, sb)).toMatchObject({ status: "landed" });
    const notice = w.j.coord.events({ filters: { kind: ["message"] } }).events.find((r: EventRecord) => r.actor.type === "system" && r.payload?.intent === "info");
    expect(notice).toMatchObject({ payload: { to: { change: b.change } } });
    expect(String(notice?.payload?.text)).toContain(`${a.change} (claude-a, task t-a) will not land`);
  });
});
