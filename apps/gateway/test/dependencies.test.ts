// Recorded dependencies over HTTP (spec §6.7, issues #5–#7): depends_on in the events API, the
// observer endpoint GET /v1/repos/{repo}/dependencies?change=, the landing queue's hold, and the
// gateway's change abandonment telling the coordinator.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Dependencies, EventPage, EventRecord, InboxBatch, Verdict, Welcome } from "@weft/protocol";
import { abandonInCoordinator } from "../src/artifacts";
import { agentToken, call, createRepo, hello, observerToken, systemToken, uniqueRepo, wcp } from "./helpers";

const NEW = "src/auth/session.ts#createSession";
const PLAN = "src/billing/plan.ts#Plan";

async function world() {
  const repo = uniqueRepo("deps");
  await createRepo(repo);
  const base = `/v1/repos/${repo}`;
  const toks = { a: await agentToken(repo, "claude-a"), b: await agentToken(repo, "codex-b"), c: await agentToken(repo, "gemini-c") };
  const s = {
    a: await wcp<Welcome>("POST", `${base}/sessions`, toks.a, hello("claude-a", "I-a")),
    b: await wcp<Welcome>("POST", `${base}/sessions`, toks.b, hello("codex-b", "I-b")),
    c: await wcp<Welcome>("POST", `${base}/sessions`, toks.c, hello("gemini-c", "I-c")),
  };
  const seen = { a: s.a.delivered_through, b: s.b.delivered_through, c: s.c.delivered_through };
  const edit = async (who: "a" | "b" | "c", writes: Array<[string, string]>, reads: string[] = []) => {
    const v = await wcp<Verdict>("POST", `${base}/sessions/${s[who].session}/events`, toks[who], {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: seen[who], writes: writes.map(([key, kind]) => ({ key, kind })), reads },
    });
    seen[who] = v.delivered_through;
    return v;
  };
  return { repo, base, toks, s, edit, observer: await observerToken([repo]), system: await systemToken([repo], "landing-queue") };
}

describe("recorded dependencies over HTTP", () => {
  it("#5: the events API returns depends_on on the accepted edit; a client-sent one is ignored", async () => {
    const w = await world();
    await w.edit("a", [[NEW, "new"]]); // #4
    const v = await w.edit("b", [["src/routes/signup.ts#signup", "body"]], [NEW]); // #5
    expect(v).toMatchObject({ verdict: "accept", seq: 5 });
    const want = [{ change: "I-a", agent: "claude-a", task: "T-claude-a", seq: 4, keys: [NEW] }];
    expect((await wcp<EventRecord>("GET", `${w.base}/events/5`, w.observer)).depends_on).toEqual(want);
    const page = await wcp<EventPage>("GET", `${w.base}/events?after=0&limit=10`, w.observer);
    expect(page.events.find((e) => e.seq === 5)?.depends_on).toEqual(want);
    expect(page.events.find((e) => e.seq === 4)?.depends_on).toBeUndefined();
    // A forged draft field never reaches the record.
    const forged = await wcp<Verdict>("POST", `${w.base}/sessions/${w.s.c.session}/events`, w.toks.c, {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: 3, writes: [{ key: "src/c.ts#c", kind: "body" }], depends_on: [{ change: "I-a", agent: "claude-a", seq: 4, keys: [NEW] }] },
    });
    expect((await wcp<EventRecord>("GET", `${w.base}/events/${forged.seq}`, w.observer)).depends_on).toBeUndefined();
  });

  it("#6/#7: GET /dependencies reports the hold; the system queue shows held_by until the dependency lands", async () => {
    const w = await world();
    await w.edit("a", [[NEW, "new"]]); // #4
    await w.edit("b", [["src/routes/signup.ts#signup", "body"]], [NEW]); // #5
    const q = `${w.base}/dependencies?change=${encodeURIComponent("I-b")}`;
    expect(await wcp<Dependencies>("GET", q, w.observer)).toMatchObject({
      type: "dependencies",
      change: "I-b",
      held: true,
      held_by: ["I-a"],
      depends_on: [{ change: "I-a", keys: [NEW], status: "pending", holds: true }],
    });
    // An agent token of the repo reads it too (as history, §9.7); a system-only token, or another repo's agent, does not.
    expect((await call("GET", q, w.toks.b)).status).toBe(200);
    expect((await call("GET", q, w.system)).status).toBe(403);
    expect((await call("GET", q, await agentToken("elsewhere", "codex-b"))).status).toBe(404);
    expect((await call("GET", `${w.base}/dependencies`, w.observer)).status).toBe(400);
    expect((await call("GET", `${w.base}/dependencies?change=nobody`, w.observer)).status).toBe(404);
    const entry = await wcp<{ id: number; held_by?: string[] }>("POST", `${w.base}/system/queue`, w.system, { change: "I-b" });
    expect(entry.held_by).toEqual(["I-a"]);
    await wcp("POST", `${w.base}/system/events`, w.system, { kind: "land", base_seq: 5, change: "I-a", payload: { sha: "a".repeat(40), op_id: "op-a" } }); // #6
    const queue = await wcp<{ entries: Array<{ id: number; status: string; held_by?: string[] }> }>("GET", `${w.base}/system/queue`, w.system);
    expect(queue.entries.find((e) => e.id === entry.id)).toEqual(expect.objectContaining({ status: "queued" }));
    expect(queue.entries.find((e) => e.id === entry.id)?.held_by).toBeUndefined();
    expect(await wcp<Dependencies>("GET", q, w.observer)).toMatchObject({ held: false, depends_on: [{ change: "I-a", status: "landed", status_seq: 6, holds: false }] });
  });

  it("#7: abandoning a change through the gateway releases the hold and messages the dependent's owner", async () => {
    const w = await world();
    await w.edit("c", [[PLAN, "new"]]); // #4
    await w.edit("b", [["src/routes/signup.ts#signupPlan", "new"]], [PLAN]); // #5
    expect(await abandonInCoordinator(env, w.repo, "I-c")).toBe(6);
    const msg = await wcp<EventRecord>("GET", `${w.base}/events/7`, w.observer);
    expect(msg).toMatchObject({ kind: "message", actor: { type: "system", id: "coordinator" }, payload: { to: { change: "I-b" }, intent: "info" } });
    const inbox = await wcp<InboxBatch>("POST", `${w.base}/sessions/${w.s.b.session}/inbox`, w.toks.b, { type: "inbox.drain" });
    expect(inbox.items.some((i) => i.kind === "message" && i.seq === 7)).toBe(true);
    expect(await wcp<Dependencies>("GET", `${w.base}/dependencies?change=I-b`, w.observer)).toMatchObject({ held: false, depends_on: [{ change: "I-c", status: "abandoned", status_seq: 6 }] });
    // A change the coordinator never saw: nothing is appended.
    const head = (await wcp<EventPage>("GET", `${w.base}/events?tail=1&limit=1`, w.observer)).head_seq;
    expect(await abandonInCoordinator(env, w.repo, "never-helloed")).toBeNull();
    expect((await wcp<EventPage>("GET", `${w.base}/events?tail=1&limit=1`, w.observer)).head_seq).toBe(head);
  });
});
