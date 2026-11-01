// Hosted spaces (`npx weft`): anonymous signup, the space API, tenant isolation (the space
// token is the boundary), quotas, rate limits and the kill switch. vitest.config.ts runs the
// gateway with WEFT_SIGNUPS=open and small limits (3 signups/network/day, 3 repos, 6 tokens, 20 rpm).

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

// Several tests wait out the 5 s grant cache; give each room under a loaded full-gate run.
vi.setConfig({ testTimeout: 90_000 });
import type { FeedPage, RepoList, Welcome } from "@weft/protocol";
import type { Registry } from "../src/registry";
import { networkKey } from "../src/spaces";
import { SELF } from "cloudflare:test";
import { ADMIN, BASE, agentToken, call, createRepo, hello, observerToken, uniqueRepo, wcp } from "./helpers";

let ipN = 0;
const freshIp = () => `198.51.100.${(ipN++ % 250) + 1}-${crypto.randomUUID().slice(0, 6)}`;

async function signup(ip = freshIp()) {
  const r = await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": ip });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { space: { id: string }; token: string };
  expect(j.space.id).toMatch(/^sp[a-z0-9]{10}$/);
  return { id: j.space.id, owner: j.token, ip };
}

async function spaceRepo(owner: string, name: string) {
  const r = await call("POST", "/v1/space/repos", owner, { name });
  expect([200, 201]).toContain(r.status);
  return ((await r.json()) as { repo: string }).repo;
}

async function spaceToken(owner: string, body: Record<string, unknown>) {
  const r = await call("POST", "/v1/space/tokens", owner, body);
  expect(r.status).toBe(201);
  return (await r.json()) as { token: string; info: { id: string } };
}

/** A device session for the owner's own CLI: read-only, expiring, revocable, usable as a bearer. */
async function deviceToken(owner: string, label = "test cli") {
  const r = await call("POST", "/v1/space/viewers", owner, { label });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { token: string; device: { id: string } };
  return { token: j.token, info: { id: j.device.id } };
}

/** What a browser does: a pairing code from the CLI, traded for a session cookie. Returns the `Cookie:` header value. */
async function pairBrowser(s: { id: string; owner: string }, ip = freshIp(), label = "Chrome on macOS") {
  const code = await newCode(s.owner);
  const r = await pair(s.id, code, ip, label);
  expect(r.status).toBe(200);
  return { cookie: cookieHeader(r), device: ((await r.json()) as { device: { id: string; label: string } }).device, response: r };
}
async function newCode(owner: string): Promise<string> {
  const r = await call("POST", "/v1/space/pairings", owner);
  expect(r.status).toBe(201);
  return ((await r.json()) as { code: string }).code;
}
const pair = (space: string, code: string, ip = freshIp(), label?: string) =>
  call("POST", "/v1/pair", undefined, { space, code, ...(label ? { label } : {}) }, { "cf-connecting-ip": ip });
const cookieHeader = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;
const asBrowser = (method: string, path: string, cookie: string, headers: Record<string, string> = {}, body?: unknown) =>
  SELF.fetch(`${BASE}${path}`, { method, headers: { "wcp-version": "0.1", cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

const editEvent = (base: number, key: string) => ({ type: "submit", mode: "commit", event: { kind: "edit", base_seq: base, writes: [{ key, kind: "body" }] } });

describe("hosted spaces: signup and the space API", () => {
  it("signup needs no login; the owner token creates repos and mints repo-bound tokens", async () => {
    const s = await signup();
    const info = await wcp<{ space: { id: string; repos: unknown[] } }>("GET", "/v1/space", s.owner);
    expect(info.space.id).toBe(s.id);
    expect(info.space.repos).toEqual([]);

    const repo = await spaceRepo(s.owner, "shop");
    expect(repo).toBe(`${s.id}-shop`);
    // idempotent
    const again = await call("POST", "/v1/space/repos", s.owner, { name: "shop" });
    expect(again.status).toBe(200);

    const a = await spaceToken(s.owner, { kind: "agent", repo, agent: "shop-a" });
    const sess = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, a.token, hello("shop-a", "I-a"));
    await wcp("POST", `/v1/repos/${repo}/sessions/${sess.session}/events`, a.token, editEvent(sess.head_seq, "src/a.ts#f"));

    const viewer = await deviceToken(s.owner);
    const feed = await wcp<FeedPage>("GET", "/v1/feed?tail=1&limit=50", viewer.token);
    expect(feed.events.some((e) => e.repo === repo && e.kind === "edit")).toBe(true);

    // A repo created after the viewer token exists is visible too (expanded at verify time).
    const repo2 = await spaceRepo(s.owner, "docs");
    await new Promise((r) => setTimeout(r, 5_200)); // space grants are cached for 5 s
    const list = await wcp<RepoList>("GET", "/v1/repos", viewer.token);
    expect(list.repos.map((r) => r.repo).sort()).toEqual([repo2, repo].sort());
  });

  it("the owner token has no WCP access and other tokens have no space API access", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    expect((await call("GET", `/v1/repos/${repo}/events`, s.owner)).status).toBe(404); // owner grant lists no repos
    expect((await call("GET", "/v1/feed", s.owner)).status).toBe(403);
    const a = await spaceToken(s.owner, { kind: "agent", repo, agent: "app-a" });
    expect((await call("GET", "/v1/space", a.token)).status).toBe(403);
    expect((await call("POST", "/v1/space/repos", a.token, { name: "x" })).status).toBe(403);
    const v = await deviceToken(s.owner);
    expect((await call("POST", "/v1/space/tokens", v.token, { kind: "agent", repo, agent: "x" })).status).toBe(403);
    expect((await call("POST", "/v1/space/pairings", v.token)).status).toBe(403);
    // a paired device is observe-only: no human actions
    expect((await call("POST", `/v1/repos/${repo}/actions`, v.token, { type: "action", action: "pause", agent: "app-a" })).status).toBe(403);
  });

  it("rejects bad repo names and agent ids", async () => {
    const s = await signup();
    for (const name of ["", "../x", "UPPER", "a/b", "x".repeat(49), "-lead"]) {
      expect((await call("POST", "/v1/space/repos", s.owner, { name })).status).toBe(400);
    }
    const repo = await spaceRepo(s.owner, "ok");
    expect((await call("POST", "/v1/space/tokens", s.owner, { kind: "agent", repo, agent: "bad agent" })).status).toBe(400);
    expect((await call("POST", "/v1/space/tokens", s.owner, { kind: "root" })).status).toBe(400);
  });
});

describe("hosted spaces: tenant isolation (the space token is the boundary)", () => {
  it("space A cannot see, write to, or mint tokens for space B's repos or operator repos", async () => {
    const A = await signup();
    const B = await signup();
    const ra = await spaceRepo(A.owner, "shared-name");
    const rb = await spaceRepo(B.owner, "shared-name");
    expect(ra).not.toBe(rb);
    const operatorRepo = uniqueRepo("operator");
    await createRepo(operatorRepo);

    // B writes something private.
    const bAgent = await spaceToken(B.owner, { kind: "agent", repo: rb, agent: "b1" });
    const bs = await wcp<Welcome>("POST", `/v1/repos/${rb}/sessions`, bAgent.token, hello("b1", "I-b1"));
    await wcp("POST", `/v1/repos/${rb}/sessions/${bs.session}/events`, bAgent.token, editEvent(bs.head_seq, "src/secret.ts#key"));

    // A's owner cannot mint for B's repo or the operator's repo.
    for (const repo of [rb, operatorRepo]) {
      expect((await call("POST", "/v1/space/tokens", A.owner, { kind: "agent", repo, agent: "x" })).status).toBe(404);
      expect((await call("POST", "/v1/space/tokens", A.owner, { kind: "system", repo })).status).toBe(404);
    }
    // A's agent/system/viewer tokens get 404 on B's repo and the operator repo (existence not leaked).
    const aAgent = await spaceToken(A.owner, { kind: "agent", repo: ra, agent: "a1" });
    const aSys = await spaceToken(A.owner, { kind: "system", repo: ra });
    const aView = await deviceToken(A.owner);
    for (const repo of [rb, operatorRepo]) {
      expect((await call("POST", `/v1/repos/${repo}/sessions`, aAgent.token, hello("a1", "I-x"))).status).toBe(404);
      expect((await call("GET", `/v1/repos/${repo}/events`, aSys.token)).status).toBe(404);
      expect((await call("GET", `/v1/repos/${repo}/events`, aView.token)).status).toBe(404);
      expect((await call("POST", `/v1/repos/${repo}/system/events`, aSys.token, { kind: "land", base_seq: 0, change: "I-b1", payload: { sha: "a".repeat(40), op_id: "x" } })).status).toBe(404);
    }
    // A's viewer lists and feeds only A's repos.
    const list = await wcp<RepoList>("GET", "/v1/repos", aView.token);
    expect(list.repos.map((r) => r.repo)).toEqual([ra]);
    const feed = await wcp<FeedPage>("GET", `/v1/feed?tail=1&limit=200&repos=${rb},${operatorRepo}`, aView.token);
    expect(feed.events).toEqual([]);
    // A cannot revoke B's tokens; B's owner token is not usable by A.
    expect((await call("DELETE", `/v1/space/tokens/${bAgent.info.id}`, A.owner)).status).toBe(404);
    // Space agent tokens are bound to their agent id.
    expect((await call("POST", `/v1/repos/${ra}/sessions`, aAgent.token, hello("someone-else", "I-y"))).status).toBe(403);
    // An operator observer with repos "*" still sees space repos (operator view), as before.
    const op = await observerToken("*");
    expect((await call("GET", `/v1/repos/${rb}/events`, op)).status).toBe(200);
  });

  it("an operator token minted for a repo name does not leak across spaces", async () => {
    const A = await signup();
    const ra = await spaceRepo(A.owner, "x");
    const t = await agentToken(ra, "op-agent"); // operator-minted, explicitly bound to A's repo
    expect((await call("POST", `/v1/repos/${ra}/sessions`, t, hello("op-agent", "I-op"))).status).toBe(201);
  });

  it("deleting a space revokes every token at once, owner included", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "gone");
    const a = await spaceToken(s.owner, { kind: "agent", repo, agent: "g1" });
    const v = await deviceToken(s.owner);
    const del = await call("DELETE", "/v1/space", s.owner);
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ type: "space.erased", space: s.id, status: "erased", already_erased: false, erased: { repos: ["gone"] } });
    await new Promise((r) => setTimeout(r, 5_200));
    expect((await call("GET", "/v1/space", s.owner)).status).toBe(401);
    expect((await call("POST", `/v1/repos/${repo}/sessions`, a.token, hello("g1", "I-g"))).status).toBe(401);
    expect((await call("GET", "/v1/feed", v.token)).status).toBe(401);
  });

  it("revoking one token leaves the rest working; the owner token cannot be revoked this way", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "rev");
    const a = await spaceToken(s.owner, { kind: "agent", repo, agent: "r1" });
    const b = await spaceToken(s.owner, { kind: "agent", repo, agent: "r2" });
    expect((await call("DELETE", `/v1/space/tokens/${a.info.id}`, s.owner)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 5_200));
    expect((await call("POST", `/v1/repos/${repo}/sessions`, a.token, hello("r1", "I-r1"))).status).toBe(401);
    expect((await call("POST", `/v1/repos/${repo}/sessions`, b.token, hello("r2", "I-r2"))).status).toBe(201);
    const own = await wcp<{ tokens: Array<{ id: string; principal: string; space?: string }> }>("GET", "/v1/admin/tokens", ADMIN);
    const ownerId = own.tokens.find((t) => t.principal === `space:${s.id}`)!.id;
    expect((await call("DELETE", `/v1/space/tokens/${ownerId}`, s.owner)).status).toBe(404);
  });
});

describe("hosted spaces: quotas, rate limits, kill switch", () => {
  it("limits signups per network per day", async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await signup(ip);
    const r = await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": ip });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: { code: "rate_limited" } });
    // the operator can always create one
    expect((await call("POST", "/v1/spaces", ADMIN, {}, { "cf-connecting-ip": ip })).status).toBe(201);
  });

  it("caps repos and active tokens per space", async () => {
    const s = await signup();
    for (const n of ["r1", "r2", "r3"]) await spaceRepo(s.owner, n);
    expect((await call("POST", "/v1/space/repos", s.owner, { name: "r4" })).status).toBe(429);
    // owner token counts as one of the 6 (paired devices have their own cap)
    for (let i = 0; i < 5; i++) await spaceToken(s.owner, { kind: "system", repo: `${s.id}-r1` });
    expect((await call("POST", "/v1/space/tokens", s.owner, { kind: "system", repo: `${s.id}-r1` })).status).toBe(429);
  });

  it("rate-limits requests per space", async () => {
    const s = await signup();
    let limited = 0;
    for (let i = 0; i < 30; i++) if ((await call("GET", "/v1/space", s.owner)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    // another space is unaffected
    const other = await signup();
    expect((await call("GET", "/v1/space", other.owner)).status).toBe(200);
  });

  it("kill switch: no-signups keeps existing spaces, off refuses every space token", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "k");
    const v = await deviceToken(s.owner);
    try {
      expect((await call("POST", "/v1/admin/hosted", ADMIN, { mode: "no-signups" })).status).toBe(200);
      expect((await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": freshIp() })).status).toBe(503);
      expect((await call("GET", "/v1/space", s.owner)).status).toBe(200);
      expect((await call("POST", "/v1/admin/hosted", ADMIN, { mode: "off" })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 5_200));
      expect((await call("GET", "/v1/space", s.owner)).status).toBe(401);
      expect((await call("GET", `/v1/repos/${repo}/events`, v.token)).status).toBe(401);
      // operator tokens are unaffected
      expect((await call("GET", `/v1/repos/${repo}/events`, await observerToken([repo]))).status).toBe(200);
      expect(await wcp("GET", "/v1/admin/hosted", ADMIN)).toMatchObject({ mode: "off" });
    } finally {
      await call("POST", "/v1/admin/hosted", ADMIN, { mode: "open" });
    }
    await new Promise((r) => setTimeout(r, 5_200));
    expect((await call("GET", "/v1/space", s.owner)).status).toBe(200);
  });

  it("operator can list and suspend spaces", async () => {
    const s = await signup();
    const list = await wcp<{ spaces: Array<{ id: string; status: string }> }>("GET", "/v1/admin/spaces", ADMIN);
    expect(list.spaces.find((x) => x.id === s.id)?.status).toBe("active");
    expect((await call("POST", `/v1/admin/spaces/${s.id}/suspend`, ADMIN)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5_200));
    expect((await call("GET", "/v1/space", s.owner)).status).toBe(401);
    expect((await call("GET", "/v1/admin/spaces", s.owner)).status).toBe(401);
    const stats = await wcp<{ days: Array<{ day: string; spaces: number }> }>("GET", "/v1/admin/stats", ADMIN);
    expect(stats.days.at(-1)!.spaces).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------- real erasure
//
// DELETE /v1/space (owner) and DELETE /v1/admin/spaces/{id} (operator) empty every repo Durable
// Object of the space (sockets closed, alarm cleared, ctx.storage.deleteAll()) and delete the
// space's Registry rows; only a tombstone stays (docs/hosted.md "Deleting your data").

describe("hosted spaces: real erasure", () => {
  const registryStub = () => env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
  const repoStub = (repo: string) => env.WEFT_REPO.get(env.WEFT_REPO.idFromName(repo));

  /** A repo with real content in it: an agent session and an edit carrying a diff, an intent and a transcript pointer. */
  async function seed(owner: string, name: string, agent: string) {
    const repo = await spaceRepo(owner, name);
    const a = await spaceToken(owner, { kind: "agent", repo, agent });
    const sess = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, a.token, hello(agent, `I-${agent}`));
    await wcp("POST", `/v1/repos/${repo}/sessions/${sess.session}/events`, a.token, {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: sess.head_seq, writes: [{ key: "src/private.ts#secretFn", kind: "body" }], diff: "+const unshipped = 'customer code';", intent: "unshipped feature", transcript: { uri: "r2://t/1.jsonl", offset: 1 } },
    });
    return { repo, token: a.token };
  }

  /** What is left in a repo Durable Object: user tables (the platform's own _cf_ tables aside), KV keys, alarm. */
  const leftIn = (repo: string) =>
    runInDurableObject(repoStub(repo), async (_i, state: DurableObjectState) => ({
      tables: state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'`).toArray().map((t) => t.name),
      keys: [...(await state.storage.list()).keys()],
      alarm: await state.storage.getAlarm(),
    }));
  const rowsOf = (space: string) =>
    runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const n = (q: string) => sql.exec<{ n: number }>(q, space).one().n;
      return {
        repos: n(`SELECT COUNT(*) AS n FROM repos WHERE space = ?`),
        tokens: n(`SELECT COUNT(*) AS n FROM tokens WHERE space = ?`),
        spaces: sql.exec(`SELECT * FROM spaces WHERE id = ?`, space).toArray() as Array<Record<string, unknown>>,
      };
    });

  it("owner erase: the repo Durable Objects are empty, the Registry has no repos or tokens left, only a tombstone remains", async () => {
    const s = await signup();
    const a = await seed(s.owner, "alpha", "al1");
    const b = await seed(s.owner, "beta", "be1");
    // content is there before
    expect((await leftIn(a.repo)).tables).toContain("events");
    const before = await call("GET", `/v1/repos/${a.repo}/events?include=diff`, await observerToken([a.repo]));
    expect(JSON.stringify(await before.json())).toContain("customer code");

    const del = await call("DELETE", "/v1/space", s.owner);
    expect(del.status).toBe(200);
    const rep = (await del.json()) as { type: string; erased: { repos: string[]; events: number; tokens: number } };
    expect(rep).toMatchObject({ type: "space.erased", space: s.id, status: "erased", already_erased: false });
    expect(rep.erased.repos.sort()).toEqual(["alpha", "beta"]);
    expect(rep.erased.events).toBeGreaterThanOrEqual(4); // hello + edit in each repo
    expect(rep.erased.tokens).toBe(3); // owner + two agent tokens

    for (const repo of [a.repo, b.repo]) {
      expect(await leftIn(repo)).toEqual({ tables: [], keys: [], alarm: null });
      // The object still answers (a stale cached grant, an operator "*" token) but there is nothing in it.
      const r = await call("GET", `/v1/repos/${repo}/events`, await observerToken("*"));
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: { code: "repo_not_found" } });
      expect(await leftIn(repo)).toEqual({ tables: [], keys: [], alarm: null }); // reading did not recreate a schema
    }
    const rows = await rowsOf(s.id);
    expect(rows.repos).toBe(0);
    expect(rows.tokens).toBe(0);
    expect(rows.spaces).toHaveLength(1);
    // the tombstone: id, status, deleted_at, created_at as a date; no label
    expect(rows.spaces[0]).toMatchObject({ id: s.id, status: "erased", label: null });
    expect(String(rows.spaces[0]!.deleted_at)).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(String(rows.spaces[0]!.created_at)).toMatch(/^\d{4}-\d\d-\d\d$/);

    // the repo name is free of the space's data: the operator's list shows the tombstone and no repos
    const list = await wcp<{ spaces: Array<{ id: string; status: string; repos: number; tokens: number }> }>("GET", "/v1/admin/spaces", ADMIN);
    expect(list.spaces.find((x) => x.id === s.id)).toMatchObject({ status: "erased", repos: 0, tokens: 0 });
    // an owner token no longer works (after the 5 s grant cache): 401
    await new Promise((r) => setTimeout(r, 5_200));
    expect((await call("GET", "/v1/space", s.owner)).status).toBe(401);
    expect((await call("DELETE", "/v1/space", s.owner)).status).toBe(401); // already gone
    expect((await call("POST", `/v1/repos/${a.repo}/sessions`, a.token, hello("al1", "I-al1"))).status).toBe(401);
  });

  it("admin erase is idempotent, 404 for an unknown space, 401 without the admin token", async () => {
    const s = await signup();
    const a = await seed(s.owner, "once", "on1");
    expect((await call("DELETE", `/v1/admin/spaces/${s.id}`, s.owner)).status).toBe(401); // an owner token is not the operator
    expect((await call("DELETE", `/v1/admin/spaces/${s.id}`)).status).toBe(401);
    const first = await wcp<{ already_erased: boolean; erased: { repos: string[] } }>("DELETE", `/v1/admin/spaces/${s.id}`, ADMIN);
    expect(first).toMatchObject({ already_erased: false, erased: { repos: ["once"] } });
    const second = await wcp<{ type: string; status: string; already_erased: boolean; erased: { repos: string[]; events: number; tokens: number } }>("DELETE", `/v1/admin/spaces/${s.id}`, ADMIN);
    expect(second).toMatchObject({ type: "space.erased", status: "erased", already_erased: true, erased: { repos: [], events: 0, tokens: 0 } });
    expect(await leftIn(a.repo)).toEqual({ tables: [], keys: [], alarm: null });
    expect((await call("DELETE", "/v1/admin/spaces/spdoesnotexist", ADMIN)).status).toBe(404);
  });

  it("the owner of space A cannot erase space B; erasing A leaves B's data untouched", async () => {
    const A = await signup();
    const B = await signup();
    const a = await seed(A.owner, "same", "a1");
    const b = await seed(B.owner, "same", "b1");
    // the space API takes its space from the token only: there is no id to aim at B, and A's token on the admin route is refused
    expect((await call("DELETE", `/v1/admin/spaces/${B.id}`, A.owner)).status).toBe(401);
    expect((await call("DELETE", `/v1/space/${B.id}`, A.owner)).status).toBe(404);
    expect((await call("DELETE", "/v1/space", b.token)).status).toBe(403); // an agent token is not an owner token
    expect((await call("DELETE", "/v1/space", A.owner)).status).toBe(200);

    expect(await leftIn(a.repo)).toEqual({ tables: [], keys: [], alarm: null });
    const bEvents = await wcp<{ events: Array<{ kind: string }> }>("GET", `/v1/repos/${b.repo}/events`, await observerToken([b.repo]));
    expect(bEvents.events.some((e) => e.kind === "edit")).toBe(true);
    expect((await rowsOf(B.id)).repos).toBe(1);
    expect((await rowsOf(B.id)).spaces[0]).toMatchObject({ status: "active" });
    expect((await call("GET", "/v1/space", B.owner)).status).toBe(200);
  });

  it("a suspended space can be erased by the operator", async () => {
    const s = await signup();
    const a = await seed(s.owner, "held", "h1");
    expect((await call("POST", `/v1/admin/spaces/${s.id}/suspend`, ADMIN)).status).toBe(200);
    expect((await rowsOf(s.id)).spaces[0]).toMatchObject({ status: "suspended" });
    expect((await leftIn(a.repo)).tables).toContain("events"); // suspending keeps the data for the operator
    const r = await wcp<{ erased: { repos: string[] } }>("DELETE", `/v1/admin/spaces/${s.id}`, ADMIN);
    expect(r.erased.repos).toEqual(["held"]);
    expect(await leftIn(a.repo)).toEqual({ tables: [], keys: [], alarm: null });
    expect(await rowsOf(s.id)).toMatchObject({ repos: 0, tokens: 0, spaces: [{ status: "erased" }] });
  });

  it("the alarm finishes spaces an older gateway only soft-deleted and erasures that were interrupted", async () => {
    const legacy = await signup();
    const interrupted = await signup();
    const keep = await signup();
    const l = await seed(legacy.owner, "old", "l1");
    const i = await seed(interrupted.owner, "half", "i1");
    const k = await seed(keep.owner, "safe", "k1");
    await runInDurableObject(registryStub(), (_inst: Registry, state: DurableObjectState) => {
      // the old soft delete: status flipped, tokens revoked, nothing purged
      state.storage.sql.exec(`UPDATE spaces SET status = 'deleted', deleted_at = ? WHERE id = ?`, new Date().toISOString(), legacy.id);
      state.storage.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE space = ?`, new Date().toISOString(), legacy.id);
      // an erase that stopped after step 1
      state.storage.sql.exec(`UPDATE spaces SET status = 'erasing' WHERE id = ?`, interrupted.id);
    });
    expect((await leftIn(l.repo)).tables).toContain("events");
    await runInDurableObject(registryStub(), (inst: Registry) => inst.alarm());
    for (const [x, repo] of [[legacy, l.repo], [interrupted, i.repo]] as const) {
      expect(await leftIn(repo)).toEqual({ tables: [], keys: [], alarm: null });
      expect(await rowsOf(x.id)).toMatchObject({ repos: 0, tokens: 0, spaces: [{ status: "erased" }] });
    }
    expect((await leftIn(k.repo)).tables).toContain("events"); // an active space is never touched by the sweep
    expect((await rowsOf(keep.id)).spaces[0]).toMatchObject({ status: "active" });
  });

  it("a repo being created while the space is erased does not survive the erase", async () => {
    const s = await signup();
    const out = await runInDurableObject(registryStub(), async (inst: Registry) => {
      const creating = inst.spaceCreateRepo(s.id, "late", 5); // passes the active check, then awaits the repo's init
      const erased = await inst.eraseSpace(s.id);
      return { created: await creating, erased };
    });
    expect(out.erased).toMatchObject({ status: "erased" });
    expect(out.created).toMatchObject({ code: "gone" });
    expect(await rowsOf(s.id)).toMatchObject({ repos: 0, tokens: 0, spaces: [{ status: "erased" }] });
    expect(await leftIn(`${s.id}-late`)).toEqual({ tables: [], keys: [], alarm: null });
    const orphan = await runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM repos WHERE repo = ?`, `${s.id}-late`).one().n);
    expect(orphan).toBe(0);
  });

  it("a suspended space is not swept by the alarm (the operator decides)", async () => {
    const s = await signup();
    const a = await seed(s.owner, "kept", "k2");
    await call("POST", `/v1/admin/spaces/${s.id}/suspend`, ADMIN);
    await runInDurableObject(registryStub(), (inst: Registry) => inst.alarm());
    expect((await leftIn(a.repo)).tables).toContain("events");
  });
});

describe("feed page", () => {
  it("is served without auth, never cached, and cannot be framed or leak its URL", async () => {
    for (const path of ["/feed", "/feed?space=spabcdefghij"]) {
      const r = await call("GET", path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/text\/html/);
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      const csp = r.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(/connect-src 'self'/);
      expect(csp).toMatch(/default-src 'none'/);
      const html = await r.text();
      expect(html).not.toMatch(/weft_[A-Za-z0-9_-]{20,}/);
    }
  });

  it("asks for a pairing code, sends no credential from the URL, and retires #t= links with a clear message", async () => {
    const html = await (await call("GET", "/feed")).text();
    expect(html).toContain("/v1/pair");
    expect(html).toContain("npx @celador/weft pair");
    // the old link format: noticed, forgotten from the address bar, explained
    expect(html).toContain("This link format was retired");
    expect(html).toContain("history.replaceState");
    // the page never builds an Authorization header from anything it is given
    expect(html.toLowerCase()).not.toContain("authorization");
    expect(html).not.toContain("encodeURIComponent(key)");
  });
});

describe("hosted spaces: no IP-derived data on the space", () => {
  const registryStub = () => env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));

  it("a created space record has no IP-derived field, and counters use a daily-rotating keyed hash", async () => {
    const ip = freshIp();
    const s = await signup(ip);
    const { cols, row, keys } = await runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => {
      const sql = state.storage.sql;
      return {
        cols: sql.exec<{ name: string }>(`PRAGMA table_info(spaces)`).toArray().map((c) => c.name),
        row: sql.exec(`SELECT * FROM spaces WHERE id = ?`, s.id).toArray()[0] as Record<string, unknown>,
        keys: sql.exec<{ net_key: string }>(`SELECT net_key FROM signup_counters`).toArray().map((r) => r.net_key),
      };
    });
    expect(cols.sort()).toEqual(["created_at", "deleted_at", "id", "label", "status"]);
    expect(Object.keys(row).sort()).toEqual(["created_at", "deleted_at", "id", "label", "status"]);
    expect(JSON.stringify(row)).not.toContain(ip);
    const today = new Date().toISOString().slice(0, 10);
    const k = await networkKey(ip, "test-admin-token", today);
    expect(keys).toContain(k);
    // Not a plain hash of the address, and a different day gives an unrelated key.
    const plain = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`weft-signup:${ip}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(plain.startsWith(k.slice(0, 24))).toBe(false);
    expect(await networkKey(ip, "test-admin-token", "2026-01-01")).not.toBe(await networkKey(ip, "test-admin-token", "2026-01-02"));
    expect(await networkKey(ip, "another-secret", today)).not.toBe(k);
  });

  it("signup counters older than 48 hours are deleted (on signup and on the alarm)", async () => {
    const day = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
    const H = 3_600_000;
    const seed = () =>
      runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => {
        for (const [d, k] of [[day(72 * H), "old3"], [day(49 * H), "old"], [day(24 * H), "yesterday"]] as const)
          state.storage.sql.exec(`INSERT OR REPLACE INTO signup_counters (day, net_key, n) VALUES (?, ?, 1)`, d, k);
      });
    const left = () =>
      runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) =>
        state.storage.sql.exec<{ net_key: string }>(`SELECT net_key FROM signup_counters WHERE net_key IN ('old3','old','yesterday')`).toArray().map((r) => r.net_key).sort(),
      );
    await signup(); // makes sure the tables exist
    await seed();
    await signup();
    expect(await left()).toEqual(["yesterday"]);
    await seed();
    await runInDurableObject(registryStub(), (inst: Registry) => inst.alarm());
    expect(await left()).toEqual(["yesterday"]);
    // Once that day is 48 h old it goes too, and an alarm is pending for the oldest row left.
    const twoDaysOn = Date.parse(`${day(24 * H)}T00:00:00Z`) + 2 * 86_400_000;
    await runInDurableObject(registryStub(), (inst: Registry) => inst.pruneSignupCounters(twoDaysOn));
    expect(await left()).toEqual([]);
    const alarm = await runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });

  it("migrates a legacy Registry: blanks and drops spaces.ip_hash and the old counter table", async () => {
    const stub = env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName(`legacy-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (_i: Registry, state: DurableObjectState) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', label TEXT, ip_hash TEXT, created_at TEXT NOT NULL, deleted_at TEXT)`);
      sql.exec(`CREATE TABLE signup_counts (day TEXT NOT NULL, ip_hash TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, ip_hash))`);
      sql.exec(`INSERT INTO spaces (id, ip_hash, created_at) VALUES ('spold0000000', 'abcdef0123456789abcdef01', '2026-10-01T00:00:00Z')`);
      sql.exec(`INSERT INTO signup_counts VALUES ('2026-10-24', 'abcdef0123456789abcdef01', 1)`);
    });
    const spaces = await stub.listSpaces();
    expect(spaces.map((x) => x.id)).toEqual(["spold0000000"]);
    const after = await runInDurableObject(stub, (_i: Registry, state: DurableObjectState) => {
      const sql = state.storage.sql;
      return {
        cols: sql.exec<{ name: string }>(`PRAGMA table_info(spaces)`).toArray().map((c) => c.name),
        tables: sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray().map((t) => t.name),
      };
    });
    expect(after.cols).not.toContain("ip_hash");
    expect(after.tables).not.toContain("signup_counts");
    expect(after.tables).toContain("signup_counters");
  });
});

// ---------------------------------------------------------------------------------------------
// Finding #1: the feed is read by paired devices, not by a link that carries a key.

describe("feed pairing: one-time codes become per-device sessions", () => {
  const registryStub = () => env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
  const sqlOf = <T>(fn: (sql: SqlStorage) => T) => runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => fn(state.storage.sql));

  it("the owner mints a short code and a URL with no credential in it", async () => {
    const s = await signup();
    const r = await call("POST", "/v1/space/pairings", s.owner);
    expect(r.status).toBe(201);
    const j = (await r.json()) as { code: string; url: string; expires_in: number; expires_at: string };
    expect(j.code).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
    expect(j.expires_in).toBe(600);
    expect(Date.parse(j.expires_at) - Date.now()).toBeLessThanOrEqual(600_000);
    expect(j.url).toBe(`${BASE}/feed?space=${s.id}`);
    expect(JSON.stringify(j)).not.toContain(s.owner);
    // only the owner token mints codes
    const dev = await deviceToken(s.owner);
    expect((await call("POST", "/v1/space/pairings", dev.token)).status).toBe(403);
    expect((await call("POST", "/v1/space/pairings")).status).toBe(401);
    // codes are stored hashed, never in clear
    const stored = await sqlOf((sql) => sql.exec<{ code_hash: string }>(`SELECT code_hash FROM pairings WHERE space = ?`, s.id).toArray());
    expect(stored).toHaveLength(1);
    expect(stored[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.code_hash).not.toContain(j.code.replace("-", ""));
  });

  it("a code opens a browser session: HttpOnly + Secure + SameSite=Strict cookie, no token in the body, reads only its space", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    const a = await spaceToken(s.owner, { kind: "agent", repo, agent: "app-a" });
    const sess = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, a.token, hello("app-a", "I-a"));
    await wcp("POST", `/v1/repos/${repo}/sessions/${sess.session}/events`, a.token, editEvent(sess.head_seq, "src/a.ts#f"));

    // typed the way a person types it: lower case, no dash
    const code = (await newCode(s.owner)).replace("-", "").toLowerCase();
    const r = await pair(s.id, code, freshIp(), "Chrome on macOS");
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-weft_session=weft_dev_[A-Za-z0-9_-]{40,};/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age="]) expect(setCookie).toContain(attr);
    expect(setCookie).not.toMatch(/Domain=/i);
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)![1]);
    expect(maxAge).toBeGreaterThan(6 * 86_400);
    expect(maxAge).toBeLessThanOrEqual(7 * 86_400);
    const body = await r.text();
    expect(body).not.toContain("weft_dev_"); // the page's JavaScript never sees the session
    expect(JSON.parse(body)).toMatchObject({ type: "viewer.paired", device: { label: "Chrome on macOS" } });

    const cookie = cookieHeader(r);
    const me = (await (await asBrowser("GET", "/v1/viewer", cookie)).json()) as { space: string; device: { label: string } };
    expect(me).toMatchObject({ space: s.id, device: { label: "Chrome on macOS" } });
    const feed = (await (await asBrowser("GET", "/v1/feed?tail=1&limit=50", cookie)).json()) as FeedPage;
    expect(feed.events.some((e) => e.repo === repo && e.kind === "edit")).toBe(true);
    const repos = (await (await asBrowser("GET", "/v1/repos", cookie)).json()) as RepoList;
    expect(repos.repos.map((x) => x.repo)).toEqual([repo]);
    expect((await asBrowser("GET", `/v1/repos/${repo}/events?limit=5`, cookie)).status).toBe(200);
    // the session is a viewer: no actions, no space API
    expect((await asBrowser("POST", `/v1/repos/${repo}/actions`, cookie, {}, { type: "action", action: "pause", agent: "app-a" })).status).toBe(401);
    expect((await asBrowser("GET", "/v1/space", cookie)).status).toBe(401);
    expect((await asBrowser("POST", "/v1/space/pairings", cookie)).status).toBe(401);
  });

  it("a code works once; wrong, unknown-space and expired codes all fail the same way", async () => {
    const s = await signup();
    const code = await newCode(s.owner);
    expect((await pair(s.id, code)).status).toBe(200);
    const again = await pair(s.id, code);
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();

    const fresh = await newCode(s.owner);
    const wrong = await pair(s.id, "AAAAA-AAAAA");
    const unknown = await pair("spzzzzzzzzzz", fresh);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json()); // no oracle for "space exists"
    // the real code still works after wrong guesses
    expect((await pair(s.id, fresh)).status).toBe(200);

    // expired (10 minutes) -> refused, and the row is cleaned up
    const old = await newCode(s.owner);
    await sqlOf((sql) => sql.exec(`UPDATE pairings SET expires_at = ? WHERE space = ?`, new Date(Date.now() - 1000).toISOString(), s.id));
    expect((await pair(s.id, old)).status).toBe(401);
    await newCode(s.owner); // minting prunes expired rows
    expect(await sqlOf((sql) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pairings WHERE space = ?`, s.id).one().n)).toBe(1);

    // malformed bodies are refused before touching the registry
    expect((await call("POST", "/v1/pair", undefined, { space: "nope", code: "x" }, { "cf-connecting-ip": freshIp() })).status).toBe(400);
    expect((await call("POST", "/v1/pair", undefined, { space: s.id }, { "cf-connecting-ip": freshIp() })).status).toBe(400);
  });

  it("two requests racing for one code: exactly one wins", async () => {
    const s = await signup();
    const code = await newCode(s.owner);
    const rs = await Promise.all([pair(s.id, code), pair(s.id, code), pair(s.id, code)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401, 401]);
  });

  it("at most 3 codes are open at a time: minting a 4th retires the oldest", async () => {
    const s = await signup();
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) codes.push(await newCode(s.owner));
    expect((await pair(s.id, codes[0]!)).status).toBe(401);
    for (const c of codes.slice(1)) expect((await pair(s.id, c)).status).toBe(200);
  });

  it("brute force: pairing attempts are rate limited per network and per space", async () => {
    const s = await signup();
    await newCode(s.owner);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await pair(s.id, `WRONG-${String(i).padStart(4, "0")}`, ip)).status);
    expect(statuses.slice(0, 10).every((x) => x === 401)).toBe(true);
    expect(statuses.slice(10).every((x) => x === 429)).toBe(true);
    const limited = await pair(s.id, "AAAAA-AAAAA", ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    // a different network guessing at the same space is stopped by the per-space limit
    const other = await pair(s.id, "BBBBB-BBBBB", freshIp());
    expect(other.status).toBe(429);
    // the same network is stopped on every other space too
    const s2 = await signup();
    expect((await pair(s2.id, "CCCCC-CCCCC", ip)).status).toBe(429);
  });

  it("codes are 10 symbols from a 31-symbol alphabet", async () => {
    // 10 symbols from a 31-symbol alphabet is 31^10 ~ 2^49.5 guesses; at 10 tries/minute/space that is not a search anyone finishes.
    const codes = new Set<string>();
    const s = await signup();
    for (let i = 0; i < 3; i++) codes.add(await newCode(s.owner));
    expect(codes.size).toBe(3);
    for (const c of codes) expect(c.replace("-", "")).toHaveLength(10);
  });
});

describe("feed pairing: sessions expire, slide, and can be revoked", () => {
  const registryStub = () => env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
  const sqlOf = <T>(fn: (sql: SqlStorage) => T) => runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => fn(state.storage.sql));
  const row = (id: string) => sqlOf((sql) => sql.exec<{ expires_at: string; hard_expires_at: string; last_seen_at: string; revoked_at: string | null }>(`SELECT expires_at, hard_expires_at, last_seen_at, revoked_at FROM tokens WHERE id = ?`, id).one());

  it("a session past its expiry is refused", async () => {
    const s = await signup();
    const b = await pairBrowser(s);
    await sqlOf((sql) => sql.exec(`UPDATE tokens SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), b.device.id));
    expect((await asBrowser("GET", "/v1/feed?tail=1", b.cookie)).status).toBe(401);
    expect((await asBrowser("GET", "/v1/viewer", b.cookie)).status).toBe(401);
    // it does not show up as a paired device any more
    const list = (await (await call("GET", "/v1/space/viewers", s.owner)).json()) as { viewers: Array<{ id: string }> };
    expect(list.viewers.find((v) => v.id === b.device.id)).toBeUndefined();
  });

  it("use slides the expiry by 7 days, never past the 30-day cap", async () => {
    const s = await signup();
    const b = await pairBrowser(s);
    const long = await pairBrowser(s);
    const day = 86_400_000;
    await sqlOf((sql) => {
      // used 2 minutes ago, one hour left
      sql.exec(`UPDATE tokens SET last_seen_at = ?, expires_at = ? WHERE id = ?`, new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString(), b.device.id);
      // same, but only 2 days of absolute life left
      sql.exec(`UPDATE tokens SET last_seen_at = ?, expires_at = ?, hard_expires_at = ? WHERE id = ?`, new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 2 * day).toISOString(), long.device.id);
    });
    expect((await asBrowser("GET", "/v1/viewer", b.cookie)).status).toBe(200);
    expect((await asBrowser("GET", "/v1/viewer", long.cookie)).status).toBe(200);
    const slid = await row(b.device.id);
    expect(Date.parse(slid.expires_at) - Date.now()).toBeGreaterThan(6.9 * day);
    expect(Date.parse(slid.expires_at) - Date.now()).toBeLessThanOrEqual(7 * day);
    const capped = await row(long.device.id);
    expect(Date.parse(capped.expires_at)).toBeLessThanOrEqual(Date.parse(capped.hard_expires_at));
    expect(Date.parse(capped.expires_at) - Date.now()).toBeLessThan(2.01 * day);
    // a fresh pairing lasts 7 days, and no more than 30 in all
    const fresh = await row(b.device.id);
    expect(Date.parse(fresh.hard_expires_at) - Date.parse(fresh.last_seen_at)).toBeLessThanOrEqual(30 * day);
    // the cookie's own lifetime follows the session (the browser has to be told it slid)
    const refreshed = (await asBrowser("GET", "/v1/viewer", b.cookie)).headers.get("set-cookie")!;
    expect(refreshed).toContain("__Host-weft_session=");
    expect(Number(/Max-Age=(\d+)/.exec(refreshed)![1])).toBeGreaterThan(6 * 86_400);
  });

  it("the owner lists paired devices (label, created, last seen) and revokes one or all, at once", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    const one = await pairBrowser(s, freshIp(), "Chrome on macOS");
    const two = await pairBrowser(s, freshIp(), "Safari on iOS");
    expect((await asBrowser("GET", "/v1/repos", one.cookie)).status).toBe(200);
    expect((await asBrowser("GET", "/v1/repos", two.cookie)).status).toBe(200);

    const list = (await (await call("GET", "/v1/space/viewers", s.owner)).json()) as { viewers: Array<{ id: string; label: string; created_at: string; last_seen_at: string; expires_at: string }> };
    expect(list.viewers.map((v) => v.label)).toEqual(["Chrome on macOS", "Safari on iOS"]);
    for (const v of list.viewers) for (const f of [v.created_at, v.last_seen_at, v.expires_at]) expect(Date.parse(f)).toBeGreaterThan(0);
    expect(((await (await call("GET", "/v1/space", s.owner)).json()) as { space: { devices: number; tokens: number } }).space).toMatchObject({ devices: 2 });

    // revoke one: that browser is out on its next request, the other stays
    expect((await call("DELETE", `/v1/space/viewers/${one.device.id}`, s.owner)).status).toBe(204);
    expect((await asBrowser("GET", `/v1/repos/${repo}/events`, one.cookie)).status).toBe(401);
    expect((await asBrowser("GET", "/v1/repos", one.cookie)).status).toBe(401);
    expect((await asBrowser("GET", "/v1/repos", two.cookie)).status).toBe(200);
    expect((await call("DELETE", `/v1/space/viewers/${one.device.id}`, s.owner)).status).toBe(404);

    // revoke all
    const all = (await (await call("DELETE", "/v1/space/viewers", s.owner)).json()) as { revoked: number };
    expect(all.revoked).toBe(1);
    expect((await asBrowser("GET", "/v1/repos", two.cookie)).status).toBe(401);
    expect(((await (await call("GET", "/v1/space/viewers", s.owner)).json()) as { viewers: unknown[] }).viewers).toEqual([]);
    // the code that paired it cannot be replayed, and the space's other keys are untouched
    expect((await call("GET", "/v1/space", s.owner)).status).toBe(200);
  });

  it("a browser can leave on its own (needs the page's header: a cross-site form cannot send it)", async () => {
    const s = await signup();
    const b = await pairBrowser(s);
    expect((await asBrowser("POST", "/v1/viewer/logout", b.cookie)).status).toBe(401);
    expect((await asBrowser("GET", "/v1/viewer", b.cookie)).status).toBe(200);
    const out = await asBrowser("POST", "/v1/viewer/logout", b.cookie, { "x-weft-feed": "1" });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-weft_session=;.*Max-Age=0/);
    expect((await asBrowser("GET", "/v1/viewer", b.cookie)).status).toBe(401);
  });

  it("the cookie is honoured only for the feed's own reads, only same-site, and only for device sessions", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    const b = await pairBrowser(s);
    expect((await asBrowser("GET", "/v1/feed", b.cookie, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await asBrowser("GET", "/v1/feed", b.cookie, { "sec-fetch-site": "cross-site" })).status).toBe(401);
    expect((await asBrowser("GET", "/v1/feed", b.cookie, { "sec-fetch-site": "same-site" })).status).toBe(401);
    // not for sockets, sessions, or anything that writes
    expect((await asBrowser("POST", `/v1/repos/${repo}/sessions`, b.cookie, {}, hello("x", "I-x"))).status).toBe(401);
    // an owner/agent key smuggled into the cookie slot is not a session
    const a = await spaceToken(s.owner, { kind: "agent", repo, agent: "app-a" });
    expect((await asBrowser("GET", "/v1/feed", `__Host-weft_session=${s.owner}`)).status).toBe(401);
    expect((await asBrowser("GET", "/v1/feed", `__Host-weft_session=${a.token}`)).status).toBe(401);
    // a plain-named cookie (what an http local gateway uses) is read too
    expect((await asBrowser("GET", "/v1/feed", b.cookie.replace("__Host-weft_session", "weft_session"))).status).toBe(200);
  });

  it("caps paired devices per space without burning the code", async () => {
    const s = await signup();
    for (let i = 0; i < 3; i++) await pairBrowser(s);
    const code = await newCode(s.owner);
    const r = await pair(s.id, code);
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/viewers revoke/);
    // revoking one frees a slot and the same code then works
    const list = (await (await call("GET", "/v1/space/viewers", s.owner)).json()) as { viewers: Array<{ id: string }> };
    await call("DELETE", `/v1/space/viewers/${list.viewers[0]!.id}`, s.owner);
    expect((await pair(s.id, code)).status).toBe(200);
  });

  it("device labels are plain, short text", async () => {
    const s = await signup();
    const b = await pairBrowser(s, freshIp(), `  <img src=x onerror=1>\n\u0007 ${"x".repeat(200)}`);
    expect(b.device.label.length).toBeLessThanOrEqual(60);
    expect(b.device.label).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe("feed pairing: isolation, retired links, the migration", () => {
  const sqlOf = <T>(fn: (sql: SqlStorage) => T) => runInDurableObject(env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry")), (_i: Registry, state: DurableObjectState) => fn(state.storage.sql));

  it("a session for space A cannot read space B, B's codes do not open A, A's codes do not open B", async () => {
    const A = await signup();
    const B = await signup();
    const ra = await spaceRepo(A.owner, "shared-name");
    const rb = await spaceRepo(B.owner, "shared-name");
    const operatorRepo = uniqueRepo("operator");
    await createRepo(operatorRepo);
    const bAgent = await spaceToken(B.owner, { kind: "agent", repo: rb, agent: "b1" });
    const bs = await wcp<Welcome>("POST", `/v1/repos/${rb}/sessions`, bAgent.token, hello("b1", "I-b1"));
    await wcp("POST", `/v1/repos/${rb}/sessions/${bs.session}/events`, bAgent.token, editEvent(bs.head_seq, "src/secret.ts#key"));

    const a = await pairBrowser(A);
    for (const repo of [rb, operatorRepo]) {
      expect((await asBrowser("GET", `/v1/repos/${repo}/events`, a.cookie)).status).toBe(404);
      expect((await asBrowser("GET", `/v1/repos/${repo}/events/1`, a.cookie)).status).toBe(404);
    }
    const list = (await (await asBrowser("GET", "/v1/repos", a.cookie)).json()) as RepoList;
    expect(list.repos.map((r) => r.repo)).toEqual([ra]);
    const feed = (await (await asBrowser("GET", `/v1/feed?tail=1&limit=200&repos=${rb},${operatorRepo}`, a.cookie)).json()) as FeedPage;
    expect(feed.events).toEqual([]);
    const all = (await (await asBrowser("GET", "/v1/feed?tail=1&limit=200", a.cookie)).json()) as FeedPage;
    expect(all.events.some((e) => e.repo === rb)).toBe(false);
    // /v1/viewer names A, and A's owner cannot revoke or list B's devices
    expect(((await (await asBrowser("GET", "/v1/viewer", a.cookie)).json()) as { space: string }).space).toBe(A.id);
    const b = await pairBrowser(B);
    expect((await call("DELETE", `/v1/space/viewers/${b.device.id}`, A.owner)).status).toBe(404);
    expect(((await (await call("GET", "/v1/space/viewers", A.owner)).json()) as { viewers: Array<{ id: string }> }).viewers.map((v) => v.id)).toEqual([a.device.id]);
    expect((await asBrowser("GET", "/v1/repos", b.cookie)).status).toBe(200);

    // codes are bound to their space
    const codeA = await newCode(A.owner);
    const codeB = await newCode(B.owner);
    expect((await pair(B.id, codeA)).status).toBe(401);
    expect((await pair(A.id, codeB)).status).toBe(401);
    expect((await pair(A.id, codeA)).status).toBe(200);
    expect((await pair(B.id, codeB)).status).toBe(200);
  });

  it("deleting or suspending a space ends its paired browsers and its open codes", async () => {
    const s = await signup();
    const b = await pairBrowser(s);
    const code = await newCode(s.owner);
    expect((await call("DELETE", "/v1/space", s.owner)).status).toBe(200);
    expect((await asBrowser("GET", "/v1/repos", b.cookie)).status).toBe(401);
    expect((await pair(s.id, code)).status).toBe(401);
    expect(await sqlOf((sql) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pairings WHERE space = ?`, s.id).one().n)).toBe(0);
  });

  it("the old viewer token can no longer be minted: the answer says what to do", async () => {
    const s = await signup();
    const r = await call("POST", "/v1/space/tokens", s.owner, { kind: "viewer" });
    expect(r.status).toBe(400);
    const msg = ((await r.json()) as { error: { message: string } }).error.message;
    expect(msg).toMatch(/retired/);
    expect(msg).toContain("npx @celador/weft pair");
    expect((await call("POST", "/v1/space/tokens", s.owner, { kind: "root" })).status).toBe(400);
  });

  it("migration: long-lived viewer tokens are revoked once; agent, lander and owner tokens are not", async () => {
    const stub = env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName(`legacy-viewers-${crypto.randomUUID()}`));
    const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const rows: Array<[string, string, string]> = [
      ["legacyviewer1", "weft_legacy_viewer", "viewer"],
      ["legacyagent01", "weft_legacy_agent", "agent"],
      ["legacyowner01", "weft_legacy_owner", "owner"],
    ];
    const hashes = await Promise.all(rows.map((r) => sha(r[1])));
    await runInDurableObject(stub, (_i: Registry, state: DurableObjectState) => {
      const sql = state.storage.sql;
      // a Registry as the last release left it: no pairing columns in use, a live viewer link
      sql.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', label TEXT, created_at TEXT NOT NULL, deleted_at TEXT)`);
      sql.exec(`INSERT INTO spaces (id, created_at) VALUES ('splegacy0001', '2026-10-01T00:00:00Z')`);
      sql.exec(`ALTER TABLE tokens ADD COLUMN space TEXT`);
      rows.forEach(([id, , role], i) => {
        const grant = { id, principal: `space:splegacy0001:${role}`, scopes: role === "viewer" ? ["observe"] : [], repos: [], space: "splegacy0001", role };
        sql.exec(`INSERT INTO tokens (id, hash, grant_json, label, created_at, space) VALUES (?, ?, ?, 'x', '2026-10-01T00:00:00Z', 'splegacy0001')`, id, hashes[i], JSON.stringify(grant));
      });
    });
    expect(await stub.verify("weft_legacy_viewer")).toBeNull();
    expect(await stub.verify("weft_legacy_agent")).not.toBeNull();
    expect(await stub.verify("weft_legacy_owner")).not.toBeNull();
    const after = await runInDurableObject(stub, (_i: Registry, state: DurableObjectState) =>
      state.storage.sql.exec<{ id: string; revoked_at: string | null }>(`SELECT id, revoked_at FROM tokens ORDER BY id`).toArray(),
    );
    expect(after.find((r) => r.id === "legacyviewer1")!.revoked_at).not.toBeNull();
    expect(after.filter((r) => r.id !== "legacyviewer1").every((r) => r.revoked_at === null)).toBe(true);
  });
});
