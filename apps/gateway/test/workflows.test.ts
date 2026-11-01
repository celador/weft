// B8 wiring in the gateway: pushes start ProcessRevision, /land starts LandChange, /select starts
// BestOfN, human `approve` signals BestOfN, `undo` starts RevertOperation, workflow-owned refs are
// not revisions, repo config is stored. Workflow bindings are faked; D1, the coordinator, the
// registry and the queue handler are real.

import { createExecutionContext, createMessageBatch, env, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MemoryArtifacts, MemorySubscriber } from "@weft/artifacts/memory";
import { ids } from "@weft/workflows/ids";
import worker, { type Env } from "../src/index";
import type { WorkflowLike } from "../src/artifacts";
import { ADMIN, BASE, agentToken, createRepo, hello, humanToken, systemToken, uniqueRepo } from "./helpers";

class FakeWorkflow implements WorkflowLike {
  readonly created: Array<{ id?: string; params?: unknown }> = [];
  readonly events: Array<{ id: string; type: string; payload: unknown }> = [];
  async create(o: { id?: string; params?: unknown }) {
    if (o.id && this.created.some((c) => c.id === o.id)) throw new Error(`instance ${o.id} already exists`);
    this.created.push(o);
    return { id: o.id ?? `wf-${this.created.length}` };
  }
  async get(id: string) {
    if (!this.created.some((c) => c.id === id)) throw new Error(`instance ${id} not found`);
    return { id, sendEvent: async (e: { type: string; payload: unknown }) => void this.events.push({ id, ...e }), status: async () => ({ status: "waiting" }) };
  }
}

async function setup() {
  const art = new MemoryArtifacts("weft-test");
  const wf = { process: new FakeWorkflow(), land: new FakeWorkflow(), revert: new FakeWorkflow(), best: new FakeWorkflow() };
  const e: Env = { ...env, ARTIFACTS: art, WEFT_EVENT_SUBSCRIBER: new MemorySubscriber(), WEFT_ARTIFACTS_NAMESPACE: "weft-test", WEFT_PROCESS_REVISION: wf.process, WEFT_LAND_CHANGE: wf.land, WEFT_REVERT_OPERATION: wf.revert, WEFT_BEST_OF_N: wf.best };
  const j = async <T = Record<string, unknown>>(method: string, path: string, token?: string, body?: unknown, status?: number): Promise<T> => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request(`${BASE}${path}`, { method, headers: { "wcp-version": "0.1", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), e, ctx);
    await waitOnExecutionContext(ctx);
    const t = await r.text();
    if (status !== undefined && r.status !== status) throw new Error(`${method} ${path}: ${r.status} ${t}`);
    return JSON.parse(t) as T;
  };
  let n = 0;
  const deliver = async (...bodies: unknown[]) => {
    const batch = createMessageBatch("weft-artifacts-events", bodies.map((body) => ({ id: `m${n++}`, timestamp: new Date(), attempts: 1, body })));
    const ctx = createExecutionContext();
    await worker.queue!(batch, e, ctx);
    return getQueueResult(batch, ctx);
  };
  const repo = uniqueRepo("b8");
  await createRepo(repo);
  const config = { tests: { command: ["node", "--test"] }, resolver: { kind: "llm" } };
  const bound = await j<{ trunk: string; config: unknown }>("POST", "/v1/admin/artifacts/repos", ADMIN, { repo, trunk: `${repo}-trunk`, create: true, config }, 201);
  const sys = await systemToken([repo], "weft-workflows");
  const human = await humanToken([repo], "john");
  const cands = (await j<{ candidates: Array<{ change: string; fork: { name: string }; token: { plaintext: string }; trailers: Record<string, string> }> }>("POST", `/v1/repos/${repo}/tasks/t_9/candidates`, sys, { count: 2, agent: "claude-a" }, 201)).candidates;
  return { art, wf, e, j, deliver, repo, bound, config, sys, human, cands };
}

describe("B8: workflows wiring", () => {
  it("stores repo workflow config", async () => {
    const s = await setup();
    expect(s.bound.config).toEqual(s.config);
    const row = await s.e.WEFT_DB!.prepare(`SELECT config FROM artifacts_repos WHERE repo = ?`).bind(s.repo).first<{ config: string }>();
    expect(JSON.parse(row!.config)).toEqual(s.config);
  });

  it("a push starts one ProcessRevision per revision; workflow refs (weft/rebased) are ignored", async () => {
    const s = await setup();
    const c = s.cands[0]!;
    const sha = "c".repeat(40);
    const ev = s.art.push(c.fork.name, { token: c.token.plaintext, after: sha, message: "feat", trailers: c.trailers });
    await s.deliver(ev);
    await s.deliver(ev); // redelivery
    expect(s.wf.process.created).toEqual([{ id: ids.process(c.change, sha), params: { repo: s.repo, change: c.change, sha } }]);
    const rev = await s.e.WEFT_DB!.prepare(`SELECT status, workflow_id FROM revisions WHERE change_id = ?`).bind(c.change).first();
    expect(rev).toEqual({ status: "queued", workflow_id: ids.process(c.change, sha) });
    const side = s.art.push(c.fork.name, { token: c.token.plaintext, ref: "refs/heads/weft/rebased", after: "d".repeat(40), message: "rebased" });
    const out = await s.deliver(side);
    expect(out.explicitAcks).toHaveLength(1);
    expect(s.wf.process.created).toHaveLength(1);
    const n = await s.e.WEFT_DB!.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE change_id = ?`).bind(c.change).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("POST /changes/{id}/land starts LandChange (system or human), not for unpushed changes", async () => {
    const s = await setup();
    const c = s.cands[0]!;
    const early = await s.j<{ error: { code: string } }>("POST", `/v1/repos/${s.repo}/changes/${c.change}/land`, s.human, {}, 422);
    expect(early.error.code).toBe("invalid_reference");
    await s.deliver(s.art.push(c.fork.name, { token: c.token.plaintext, after: "e".repeat(40), message: "x", trailers: c.trailers }));
    const r = await s.j<{ workflow: string }>("POST", `/v1/repos/${s.repo}/changes/${c.change}/land`, s.human, { note: "ship it" }, 202);
    expect(r.workflow).toMatch(/^land-/);
    expect(s.wf.land.created[0]!.params).toEqual({ repo: s.repo, change: c.change, requested_by: "john", note: "ship it" });
    const agent = await agentToken(s.repo, "claude-a");
    await s.j("POST", `/v1/repos/${s.repo}/changes/${c.change}/land`, agent, {}, 403);
  });

  it("select starts BestOfN; a human approve is forwarded as an `approval` event", async () => {
    const s = await setup();
    const r = await s.j<{ workflow: string; n: number; risk: string }>("POST", `/v1/repos/${s.repo}/tasks/t_9/select`, s.sys, { risk: "high" }, 202);
    expect(r).toMatchObject({ workflow: ids.bestOfN(s.repo, "t_9"), n: 2, risk: "high" });
    expect(s.wf.best.created[0]!.params).toEqual({ repo: s.repo, task: "t_9", n: 2, risk: "high" });
    await s.j("POST", `/v1/repos/${s.repo}/tasks/t_9/select`, s.sys, {}, 422); // one selection per task

    // the change must be known to the coordinator for `approve`
    const c = s.cands[1]!;
    const agent = await agentToken(s.repo, "claude-a");
    await s.j("POST", `/v1/repos/${s.repo}/sessions`, agent, hello("claude-a", c.change), 201);
    const act = await s.j<{ workflow: string; record: { kind: string } }>("POST", `/v1/repos/${s.repo}/actions`, s.human, { type: "action", action: "approve", change: c.change }, 200);
    expect(act.workflow).toBe(ids.bestOfN(s.repo, "t_9"));
    expect(s.wf.best.events).toEqual([{ id: ids.bestOfN(s.repo, "t_9"), type: "approve", payload: { repo: s.repo, task: "t_9", change: c.change, by: "john" } }]);
  });

  it("human undo of a land starts RevertOperation; system revert endpoint too", async () => {
    const s = await setup();
    const c = s.cands[0]!;
    const agent = await agentToken(s.repo, "claude-a");
    await s.j("POST", `/v1/repos/${s.repo}/sessions`, agent, hello("claude-a", c.change), 201);
    const land = await s.j<{ seq: number }>("POST", `/v1/repos/${s.repo}/system/events`, s.sys, { kind: "land", base_seq: 1, change: c.change, payload: { sha: "f".repeat(40), op_id: "op-1" } }, 200);
    const act = await s.j<{ workflow: string }>("POST", `/v1/repos/${s.repo}/actions`, s.human, { type: "action", action: "undo", op_id: "op-1", reason: "error spike" }, 200);
    expect(act.workflow).toMatch(/^revert-/);
    expect(s.wf.revert.created[0]!.params).toEqual({ repo: s.repo, op_id: "op-1", reason: "error spike", requested_by: "john", requested_by_type: "human" });
    const r = await s.j<{ workflow: string }>("POST", `/v1/repos/${s.repo}/system/revert`, s.sys, { seq: land.seq, reason: "tail worker: 5xx spike", evidence: { text: "TypeError" } }, 202);
    expect(s.wf.revert.created[1]!.params).toMatchObject({ seq: land.seq, reason: "tail worker: 5xx spike", requested_by: "weft-workflows", requested_by_type: "system", evidence: { text: "TypeError" } });
    expect(r.workflow).toBe(s.wf.revert.created[1]!.id);
  });
});
