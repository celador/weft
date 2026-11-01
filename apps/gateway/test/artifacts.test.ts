// B6: Artifacts integration. Candidate forks + tokens + Change-Ids over HTTP, and the
// `weft-artifacts-events` queue consumer turning pushes into WCP `checkpoint` events.
// Artifacts and the event-subscription API are faked (MemoryArtifacts/MemorySubscriber);
// D1, the RepoCoordinator DO, the Registry and the queue handler are real.

import { createExecutionContext, createMessageBatch, env, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHANGE_ID, decodeEnvelope, formatTrailers, parsePush } from "@weft/artifacts";
import { MemoryArtifacts, MemorySubscriber } from "@weft/artifacts/memory";
import type { EventPage, Welcome } from "@weft/protocol";
import worker, { type Env } from "../src/index";
import { ADMIN, BASE, agentToken, createRepo, hello, observerToken, systemToken, uniqueRepo } from "./helpers";

type Candidate = {
  change: string;
  n: number;
  agent?: string;
  fork: { namespace: string; name: string; remote: string; default_branch: string };
  token: { plaintext: string; scope: string; expires_at: string };
  trailers: Record<string, string>;
  subscription: { status: string; id?: string; error?: string };
};

function world() {
  const art = new MemoryArtifacts("weft-test");
  const subs = new MemorySubscriber();
  const e: Env = { ...env, ARTIFACTS: art, WEFT_EVENT_SUBSCRIBER: subs, WEFT_ARTIFACTS_NAMESPACE: "weft-test" };
  const fetch = async (method: string, path: string, token?: string, body?: unknown) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { "wcp-version": "0.1", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  };
  const j = async <T = Record<string, unknown>>(method: string, path: string, token?: string, body?: unknown, status?: number): Promise<T> => {
    const r = await fetch(method, path, token, body);
    const t = await r.text();
    if (status !== undefined && r.status !== status) throw new Error(`${method} ${path}: ${r.status} ${t}`);
    return JSON.parse(t) as T;
  };
  let id = 0;
  const deliver = async (...bodies: unknown[]) => {
    const batch = createMessageBatch("weft-artifacts-events", bodies.map((body) => ({ id: `m${id++}`, timestamp: new Date(), attempts: 1, body })));
    const ctx = createExecutionContext();
    await worker.queue!(batch, e, ctx);
    return getQueueResult(batch, ctx);
  };
  return { art, subs, e, fetch, j, deliver };
}

async function setup(opts: { count?: number; agents?: string[] } = {}) {
  const w = world();
  const repo = uniqueRepo("art");
  await createRepo(repo);
  const bound = await w.j<{ trunk: string; remote: string; namespace: string }>("POST", "/v1/admin/artifacts/repos", ADMIN, { repo, trunk: `${repo}-trunk`, create: true }, 201);
  const trunkTok = (await (await w.art.get(bound.trunk)).createToken("write", 600)).plaintext;
  const base = w.art.push(bound.trunk, { token: trunkTok, after: "1".repeat(40), message: "init" }).payload.after;
  const sys = await systemToken([repo], "dispatcher");
  const obs = await observerToken([repo]);
  const task = "t_cefe064a";
  const created = await w.j<{ candidates: Candidate[] }>(
    "POST",
    `/v1/repos/${repo}/tasks/${task}/candidates`,
    sys,
    { count: opts.count ?? 2, ...(opts.agents ? { agents: opts.agents } : { agent: "claude-a" }), title: "Fix auth refresh" },
    201,
  );
  return { ...w, repo, bound, base, sys, obs, task, cands: created.candidates, trunkTok };
}

describe("candidates: fork per change, tokens, Change-Ids", () => {
  it("forks trunk into weft-<repo>-<task>-<n> with a repo-scoped write token and a subscription", async () => {
    const s = await setup({ count: 2, agents: ["claude-a", "codex-b"] });
    expect(s.bound).toMatchObject({ namespace: "weft-test", trunk: `${s.repo}-trunk` });
    expect(s.cands.map((c) => c.fork.name)).toEqual([`weft-${s.repo}-t_cefe064a-1`, `weft-${s.repo}-t_cefe064a-2`]);
    for (const [i, c] of s.cands.entries()) {
      expect(c.n).toBe(i + 1);
      expect(CHANGE_ID.test(c.change)).toBe(true);
      expect(c.trailers).toEqual({ "Change-Id": c.change, "Task-Id": "t_cefe064a", "Agent-Id": i === 0 ? "claude-a" : "codex-b" });
      expect(c.fork.remote).toBe(s.art.remote(c.fork.name));
      // fork starts at trunk (default branch only)
      expect(s.art.ref(c.fork.name)).toBe(s.base);
      // token: write on its own fork, nothing on trunk or the sibling fork
      expect(c.token.scope).toBe("write");
      expect(s.art.authorize(c.fork.name, c.token.plaintext, "write")).toBe(true);
      expect(s.art.authorize(s.bound.trunk, c.token.plaintext, "read")).toBe(false);
      expect(s.art.authorize(s.cands[1 - i]!.fork.name, c.token.plaintext, "read")).toBe(false);
      expect(c.subscription.status).toBe("active");
      expect(s.subs.subs.get(c.subscription.id!)).toEqual({ namespace: "weft-test", repo: c.fork.name });
    }
    // n keeps counting across calls; listing never returns tokens
    const more = await s.j<{ candidates: Candidate[] }>("POST", `/v1/repos/${s.repo}/tasks/${s.task}/candidates`, s.sys, {}, 201);
    expect(more.candidates[0]!.n).toBe(3);
    const list = await s.j<{ candidates: Candidate[] }>("GET", `/v1/repos/${s.repo}/tasks/${s.task}/candidates`, s.obs, undefined, 200);
    expect(list.candidates.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(JSON.stringify(list)).not.toContain("art_v1_");
    // board view: tasks with candidates + evidence tally, observer scope, no tokens
    await s.e.WEFT_DB!.prepare(`INSERT INTO evidence (change_id, sha, kind, status, uri, data, created_at) VALUES (?, 'abc', 'test', 'pass', NULL, NULL, ?)`).bind(s.cands[0]!.change, Date.now()).run();
    const board = await s.j<{ tasks: Array<{ task: string; title?: string; candidate_count: number; candidates: Array<{ change: string; n: number; evidence: Record<string, number> }> }> }>("GET", `/v1/repos/${s.repo}/tasks`, s.obs, undefined, 200);
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0]).toMatchObject({ task: s.task, title: "Fix auth refresh", candidate_count: 3 });
    expect(board.tasks[0]!.candidates.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(board.tasks[0]!.candidates[0]!.evidence).toEqual({ pass: 1 });
    expect(JSON.stringify(board)).not.toContain("art_v1_");
    expect((await s.fetch("GET", `/v1/repos/${s.repo}/tasks`)).status).toBe(401);
  });

  it("enforces scopes, validates input, and requires a bound trunk", async () => {
    const s = await setup({ count: 1 });
    const other = uniqueRepo("art-unbound");
    await createRepo(other);
    const sysOther = await systemToken([other]);
    expect((await s.fetch("POST", `/v1/repos/${s.repo}/tasks/t1/candidates`, s.obs, {})).status).toBe(403);
    expect((await s.fetch("POST", `/v1/repos/${s.repo}/tasks/t1/candidates`, sysOther, {})).status).toBe(404); // other repo's token: repo hidden
    expect((await s.fetch("POST", `/v1/repos/${other}/tasks/t1/candidates`, sysOther, {})).status).toBe(404); // no trunk bound
    expect((await s.fetch("POST", `/v1/repos/${s.repo}/tasks/t1/candidates`, s.sys, { count: 11 })).status).toBe(400);
    expect((await s.fetch("POST", `/v1/repos/${s.repo}/tasks/t1/candidates`, s.sys, { ttl: 5 })).status).toBe(400);
    expect((await s.fetch("POST", `/v1/repos/${s.repo}/tasks/bad%20id/candidates`, s.sys, {})).status).toBe(400);
    expect((await s.fetch("POST", "/v1/admin/artifacts/repos", ADMIN, { repo: other, trunk: "does-not-exist" })).status).toBe(404);
  });

  it("re-mints fork tokens, issues trunk tokens for landing, and abandons changes", async () => {
    const s = await setup({ count: 1 });
    const c = s.cands[0]!;
    const t = await s.j<{ token: { plaintext: string; scope: string } }>("POST", `/v1/repos/${s.repo}/changes/${c.change}/token`, s.sys, { scope: "read", ttl: 120 }, 201);
    expect(t.token.scope).toBe("read");
    expect(s.art.authorize(c.fork.name, t.token.plaintext, "read")).toBe(true);
    expect(s.art.authorize(c.fork.name, t.token.plaintext, "write")).toBe(false);
    const tt = await s.j<{ trunk: string; branch: string; token: { plaintext: string } }>("POST", `/v1/repos/${s.repo}/system/trunk-token`, s.sys, {}, 201);
    expect(tt).toMatchObject({ trunk: s.bound.trunk, branch: "main" });
    expect(s.art.authorize(s.bound.trunk, tt.token.plaintext, "write")).toBe(true);
    expect((await s.fetch("POST", `/v1/repos/${s.repo}/system/trunk-token`, s.obs, {})).status).toBe(403);
    const del = await s.j<{ fork_deleted: boolean }>("DELETE", `/v1/repos/${s.repo}/changes/${c.change}`, s.sys, undefined, 200);
    expect(del.fork_deleted).toBe(true);
    expect(s.art.repos.has(c.fork.name)).toBe(false);
    expect(s.subs.subs.size).toBe(0);
    const got = await s.j<{ status: string; subscription: { status: string } }>("GET", `/v1/repos/${s.repo}/changes/${c.change}`, s.obs, undefined, 200);
    expect(got).toMatchObject({ status: "abandoned", subscription: { status: "deleted" } });
    expect((await s.fetch("POST", `/v1/repos/${s.repo}/changes/${c.change}/token`, s.sys, {})).status).toBe(422);
  });

  it("keeps the candidate when the subscription API fails, and lets the operator reconcile", async () => {
    const w = world();
    const repo = uniqueRepo("art-sub");
    await createRepo(repo);
    await w.j("POST", "/v1/admin/artifacts/repos", ADMIN, { repo, create: true }, 201);
    const sys = await systemToken([repo]);
    w.subs.failNext = true;
    const r = await w.j<{ candidates: Candidate[] }>("POST", `/v1/repos/${repo}/tasks/t9/candidates`, sys, {}, 201);
    const c = r.candidates[0]!;
    expect(c.subscription).toMatchObject({ status: "failed", error: "subscription API unavailable" });
    const pending = await w.j<{ changes: { change: string }[] }>("GET", "/v1/admin/artifacts/subscriptions", ADMIN, undefined, 200);
    expect(pending.changes.map((x) => x.change)).toContain(c.change);
    await w.j("POST", "/v1/admin/artifacts/subscriptions", ADMIN, { change: c.change, subscription_id: "sub-manual" }, 200);
    const after = await w.j<{ changes: { change: string }[] }>("GET", "/v1/admin/artifacts/subscriptions", ADMIN, undefined, 200);
    expect(after.changes.map((x) => x.change)).not.toContain(c.change);
  });

  it("without a subscriber configured, candidates are created with subscription pending", async () => {
    const w = world();
    delete (w.e as Partial<Env>).WEFT_EVENT_SUBSCRIBER;
    const repo = uniqueRepo("art-nosub");
    await createRepo(repo);
    await w.j("POST", "/v1/admin/artifacts/repos", ADMIN, { repo, create: true }, 201);
    const r = await w.j<{ candidates: Candidate[] }>("POST", `/v1/repos/${repo}/tasks/t1/candidates`, await systemToken([repo]), {}, 201);
    expect(r.candidates[0]!.subscription).toEqual({ status: "pending" });
  });
});

describe("Artifacts events -> checkpoints", () => {
  it("records a push to a fork as a WCP checkpoint and a revision, idempotently", async () => {
    const s = await setup({ count: 1 });
    const c = s.cands[0]!;
    const sha = "a".repeat(40);
    const ev = s.art.push(c.fork.name, { token: c.token.plaintext, after: sha, message: "feat: refresh tokens", trailers: c.trailers });
    const q1 = await s.deliver(ev);
    expect(q1.explicitAcks).toEqual(["m0"]);
    expect(q1.retryMessages).toEqual([]);

    const page = await s.j<EventPage>("GET", `/v1/repos/${s.repo}/events?kind=checkpoint`, s.obs, undefined, 200);
    expect(page.events).toHaveLength(1);
    const rec = page.events[0]!;
    expect(rec).toMatchObject({ kind: "checkpoint", status: "accepted", change: c.change, task: s.task, actor: { type: "system", id: "artifacts" }, payload: { sha, ref: "refs/heads/main" } });
    expect(rec.summary).toContain("aaaaaaa");

    const ch = await s.j<{ head_sha: string; base_sha: string; revisions: { sha: string; seq: number; status: string; trailer_change_id: string; subject: string; before_sha: string }[] }>(
      "GET",
      `/v1/repos/${s.repo}/changes/${c.change}`,
      s.obs,
      undefined,
      200,
    );
    expect(ch).toMatchObject({ head_sha: sha, base_sha: s.base });
    expect(ch.revisions).toEqual([expect.objectContaining({ sha, seq: rec.seq, status: "queued", trailer_change_id: c.change, subject: "feat: refresh tokens", before_sha: s.base })]);

    // Redelivery (and a duplicate subscription) of the same push appends nothing.
    const q2 = await s.deliver(ev, JSON.stringify(ev));
    expect(q2.explicitAcks).toEqual(["m1", "m2"]);
    const again = await s.j<EventPage>("GET", `/v1/repos/${s.repo}/events?kind=checkpoint`, s.obs, undefined, 200);
    expect(again.events).toHaveLength(1);

    // A second push is a new revision and a new checkpoint.
    const sha2 = "b".repeat(40);
    await s.deliver(s.art.push(c.fork.name, { token: c.token.plaintext, after: sha2, expected: sha, message: "fix: tests", trailers: c.trailers }));
    const two = await s.j<EventPage>("GET", `/v1/repos/${s.repo}/events?kind=checkpoint`, s.obs, undefined, 200);
    expect(two.events.map((x) => (x.payload as { sha: string }).sha)).toEqual([sha, sha2]);
    const row = await s.e.WEFT_DB!.prepare(`SELECT status, seq, latency_ms FROM artifact_events WHERE key = ?`).bind(parsePush(decodeEnvelope(ev)!)!.key).first();
    expect(row).toMatchObject({ status: "recorded", seq: rec.seq });
  });

  it("attributes the checkpoint to the agent when its session announced the change", async () => {
    const s = await setup({ count: 1 });
    const c = s.cands[0]!;
    const at = await agentToken(s.repo, "claude-a");
    const r = await s.fetch("POST", `/v1/repos/${s.repo}/sessions`, at, hello("claude-a", c.change));
    expect(r.status).toBe(201);
    (await r.json()) as Welcome;
    await s.deliver(s.art.push(c.fork.name, { token: c.token.plaintext, after: "c".repeat(40), message: `wip\n\n${formatTrailers(c.trailers)}` }));
    const page = await s.j<EventPage>("GET", `/v1/repos/${s.repo}/events?kind=checkpoint`, s.obs, undefined, 200);
    expect(page.events[0]).toMatchObject({ agent: "claude-a", change: c.change, actor: { type: "system", id: "artifacts" } });
  });

  it("classifies trunk pushes, unknown repos, ref deletions and non-push events without appending", async () => {
    const s = await setup({ count: 1 });
    const c = s.cands[0]!;
    const trunkPush = s.art.push(s.bound.trunk, { token: s.trunkTok, after: "d".repeat(40), expected: s.base });
    const stranger = { ...trunkPush, source: { ...trunkPush.source, repoName: "someone-else" } };
    const del = s.art.push(c.fork.name, { token: c.token.plaintext, ref: "refs/heads/tmp", after: "e".repeat(40) });
    const delEv = { ...del, payload: { ...del.payload, before: "e".repeat(40), after: "0".repeat(40) } };
    const cloned = { type: "cf.artifacts.repo.cloned", source: { type: "artifacts.repo", namespace: "weft-test", repoName: c.fork.name }, payload: {}, metadata: { eventTimestamp: new Date().toISOString() } };
    const q = await s.deliver(trunkPush, stranger, delEv, cloned, "garbage");
    expect(q.explicitAcks).toHaveLength(5);
    const page = await s.j<EventPage>("GET", `/v1/repos/${s.repo}/events?kind=checkpoint`, s.obs, undefined, 200);
    expect(page.events).toHaveLength(0);
    const rows = await s.e.WEFT_DB!.prepare(`SELECT repo_name, status FROM artifact_events WHERE repo_name IN (?, ?, ?) ORDER BY received_at, key`).bind(s.bound.trunk, "someone-else", c.fork.name).all();
    expect(rows.results.map((r) => `${r.repo_name}:${r.status}`).sort()).toEqual([`${c.fork.name}:ignored`, `${c.fork.name}:ignored`, `${s.bound.trunk}:trunk`, "someone-else:unmatched"].sort());
  });

  it("retries when the coordinator cannot take the checkpoint yet", async () => {
    const w = world();
    const repo = uniqueRepo("art-retry");
    // Bound trunk + candidate, but the Weft repo (coordinator) is never initialized.
    await w.j("POST", "/v1/admin/artifacts/repos", ADMIN, { repo, create: true }, 201);
    const sys = await systemToken("*", "dispatcher-all");
    const r = await w.j<{ candidates: Candidate[] }>("POST", `/v1/repos/${repo}/tasks/t1/candidates`, sys, {}, 201);
    const c = r.candidates[0]!;
    const q = await w.deliver(w.art.push(c.fork.name, { token: c.token.plaintext, after: "f".repeat(40) }));
    expect(q.retryMessages).toHaveLength(1);
    const ev = await w.e.WEFT_DB!.prepare(`SELECT status, error FROM artifact_events WHERE repo_name = ?`).bind(c.fork.name).first<{ status: string; error: string }>();
    expect(ev).toMatchObject({ status: "error" });
    expect(ev!.error).toMatch(/not initialized/);
    // Once the repo exists, redelivery records it.
    await createRepo(repo);
    const q2 = await w.deliver(w.art.push(c.fork.name, { token: c.token.plaintext, after: "9".repeat(40), expected: "f".repeat(40) }));
    expect(q2.explicitAcks).toHaveLength(1);
  });
});
