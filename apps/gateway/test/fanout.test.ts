// Polling must not fan out: /v1/repos and /v1/feed answer from the Registry's summary table, so an unchanged
// poll wakes no RepoCoordinator at all and a changed one wakes only the repos that changed. These tests run the
// gateway handler in-process with a WEFT_REPO binding that records every call made through it.

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FeedPage, RepoList, Verdict, Welcome } from "@weft/protocol";
import worker, { type Env } from "../src/index";
import { ADMIN, BASE, agentToken, call, createRepo, hello, observerToken, uniqueRepo, wcp } from "./helpers";

const KEY = "src/util/parse.ts#parseJson";

/** The gateway's env with WEFT_REPO wrapped so every method called on a repo stub is recorded. */
function counted() {
  const calls: string[] = [];
  const ns = env.WEFT_REPO;
  const wrapped = {
    idFromName: (n: string) => ns.idFromName(n),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id);
      const rec = <A extends unknown[], R>(name: string, f: (...a: A) => R) => (...a: A): R => {
        calls.push(name);
        return f(...a);
      };
      return {
        summary: rec("summary", () => stub.summary()),
        events: rec("events", (q: Parameters<typeof stub.events>[0]) => stub.events(q)),
        op: rec("op", (o: Parameters<typeof stub.op>[0], args: unknown[]) => stub.op(o, args)),
        queue: rec("queue", (s?: string[]) => stub.queue(s)),
        ops: rec("ops", () => stub.ops()),
        fetch: rec("fetch", (r: Request) => stub.fetch(r)),
      };
    },
  };
  return { calls, env: { ...env, WEFT_REPO: wrapped } as unknown as Env };
}

async function poll(path: string, tok: string, headers: Record<string, string> = {}) {
  const c = counted();
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, { headers: { "wcp-version": "0.1", authorization: `Bearer ${tok}`, ...headers } }), c.env, ctx);
  await waitOnExecutionContext(ctx);
  return { res, calls: c.calls };
}

async function repoWithEvent(prefix: string) {
  const repo = uniqueRepo(prefix);
  await createRepo(repo);
  const t = await agentToken(repo, "claude-a");
  const s = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, t, hello("claude-a", "I-a"));
  const edit = (base: number) =>
    wcp<Verdict>("POST", `/v1/repos/${repo}/sessions/${s.session}/events`, t, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: base, writes: [{ key: KEY, kind: "body" }] } });
  await edit(0);
  return { repo, t, s, edit };
}

describe("polling does not wake repo objects", () => {
  it("GET /v1/repos reads the summary table: zero repo calls, current counts, ETag -> 304", async () => {
    const a = await repoWithEvent("fan");
    const b = await repoWithEvent("fan");
    const obs = await observerToken([a.repo, b.repo]);

    const first = await poll("/v1/repos", obs);
    expect(first.res.status).toBe(200);
    expect(first.calls).toEqual([]);
    const list = (await first.res.json()) as RepoList;
    const sa = list.repos.find((r) => r.repo === a.repo)!;
    expect(sa.head_seq).toBeGreaterThan(0);
    expect(sa.active_agents).toBe(1);
    expect(sa.last_event_at).toBeTruthy();
    expect(list.repos.map((r) => r.repo)).toEqual([a.repo, b.repo].sort());

    const etag = first.res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const again = await poll("/v1/repos", obs, { "if-none-match": etag });
    expect(again.res.status).toBe(304);
    expect(again.calls).toEqual([]);

    // One more event: the row follows (no stale 304), still without waking anything on the read.
    await a.edit(sa.head_seq);
    const after = await poll("/v1/repos", obs, { "if-none-match": etag });
    expect(after.res.status).toBe(200);
    expect(after.calls).toEqual([]);
    const l2 = (await after.res.json()) as RepoList;
    expect(l2.repos.find((r) => r.repo === a.repo)!.head_seq).toBe(sa.head_seq + 1);
    expect(l2.repos.find((r) => r.repo === b.repo)!.head_seq).toBe(list.repos.find((r) => r.repo === b.repo)!.head_seq);
  });

  it("GET /v1/feed with an up-to-date cursor wakes nothing; a new event wakes only its repo", async () => {
    const quiet = await repoWithEvent("fan");
    const busy = await repoWithEvent("fan");
    const obs = await observerToken([quiet.repo, busy.repo]);

    const tail = await poll("/v1/feed?tail=1&limit=50", obs);
    const f0 = (await tail.res.json()) as FeedPage;
    expect(f0.events.length).toBeGreaterThanOrEqual(2);

    // Nothing happened since the tail: no repo is asked, the cursor passes through, and the ETag matches.
    const idle = await poll(`/v1/feed?after=${encodeURIComponent(f0.cursor)}&limit=100`, obs);
    expect(idle.calls).toEqual([]);
    const f1 = (await idle.res.json()) as FeedPage;
    expect(f1).toMatchObject({ type: "feed", events: [], has_more: false, cursor: f0.cursor });
    const etag = idle.res.headers.get("etag")!;
    const cached = await poll(`/v1/feed?after=${encodeURIComponent(f0.cursor)}&limit=100`, obs, { "if-none-match": etag });
    expect(cached.res.status).toBe(304);
    expect(cached.calls).toEqual([]);

    // A new event in one repo: exactly that repo is read, and the page holds exactly that event.
    await busy.edit(f0.events.filter((e) => e.repo === busy.repo).at(-1)!.seq);
    const moved = await poll(`/v1/feed?after=${encodeURIComponent(f0.cursor)}&limit=100`, obs, { "if-none-match": etag });
    expect(moved.res.status).toBe(200);
    expect(moved.calls).toEqual(["events"]);
    const f2 = (await moved.res.json()) as FeedPage;
    expect(f2.events.map((e) => e.repo)).toEqual([busy.repo]);
    expect(f2.cursor).not.toBe(f0.cursor);
  });

  it("the tail only asks the most recently active repos, and its cursor still covers the rest", async () => {
    const repos: string[] = [];
    for (let i = 0; i < 9; i++) repos.push((await repoWithEvent("tl")).repo);
    const obs = await observerToken(repos);
    const tail = await poll("/v1/feed?tail=1&limit=3", obs);
    const f = (await tail.res.json()) as FeedPage;
    expect(f.events).toHaveLength(3);
    expect(tail.calls.length).toBeLessThan(repos.length); // one batch of 6, not all 9
    // The newest three events overall are the ones returned (same answer as asking every repo).
    const all = await wcp<FeedPage>("GET", `/v1/feed?limit=500`, obs);
    expect(f.events.map((e) => `${e.repo}#${e.seq}`)).toEqual(all.events.slice(-3).map((e) => `${e.repo}#${e.seq}`));
    // Repos the tail skipped are at their heads in the cursor: the next poll replays nothing.
    const next = await poll(`/v1/feed?after=${encodeURIComponent(f.cursor)}`, obs);
    expect(next.calls).toEqual([]);
    expect(((await next.res.json()) as FeedPage).events).toEqual([]);
  });

  it("a repo with no summary row yet is asked once and its row stored", async () => {
    const a = await repoWithEvent("fan");
    const obs = await observerToken([a.repo]);
    const reg = env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
    await runInDurableObject(reg, (_i, state) => {
      state.storage.sql.exec(`DELETE FROM repo_summaries WHERE repo = ?`, a.repo);
    });
    const first = await poll("/v1/repos", obs);
    expect(first.calls).toEqual(["summary"]);
    expect(((await first.res.json()) as RepoList).repos[0]!.head_seq).toBeGreaterThan(0);
    expect((await poll("/v1/repos", obs)).calls).toEqual([]);
  });

  it("an idle repo (no sockets, no sessions) sets no alarm", async () => {
    const repo = uniqueRepo("idle");
    await createRepo(repo);
    const policy = await call("POST", `/v1/admin/repos/${repo}/policy`, ADMIN, { claims: { lease_ms: 60_000, firm_max_ms: 600_000 } });
    expect(policy.status).toBe(200);
    const stub = env.WEFT_REPO.get(env.WEFT_REPO.idFromName(repo));
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();
  });
});

describe("DELETE /v1/admin/repos/{repo}", () => {
  it("needs the operator token and ?confirm=<repo>, erases the repo, its row and its repo-only tokens", async () => {
    const a = await repoWithEvent("gone");
    const keep = await repoWithEvent("keep");
    const only = await observerToken([a.repo]);
    const wide = await observerToken("*");
    expect((await call("DELETE", `/v1/admin/repos/${a.repo}?confirm=${a.repo}`, only)).status).toBe(401);
    expect((await call("DELETE", `/v1/admin/repos/${a.repo}`, ADMIN)).status).toBe(400);
    expect((await call("DELETE", `/v1/admin/repos/${a.repo}?confirm=nope`, ADMIN)).status).toBe(400);
    expect((await call("DELETE", `/v1/admin/repos/${uniqueRepo("never")}?confirm=x`, ADMIN)).status).toBe(400);

    const r = await call("DELETE", `/v1/admin/repos/${a.repo}?confirm=${a.repo}`, ADMIN);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ repo: a.repo, erased: true, events: 2 });
    // Gone from the lists, its repo-only token revoked, other repos and wildcard tokens untouched.
    const list = await wcp<RepoList>("GET", "/v1/repos", wide);
    expect(list.repos.map((x) => x.repo)).not.toContain(a.repo);
    expect(list.repos.map((x) => x.repo)).toContain(keep.repo);
    expect((await call("GET", "/v1/repos", only)).status).toBe(401);
    expect((await call("GET", `/v1/repos/${a.repo}/events`, wide)).status).toBe(404);
    // Again: unknown now.
    expect((await call("DELETE", `/v1/admin/repos/${a.repo}?confirm=${a.repo}`, ADMIN)).status).toBe(404);
  });
});
