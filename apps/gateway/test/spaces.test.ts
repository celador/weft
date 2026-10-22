// Hosted spaces (`npx weft`): anonymous signup, the space API, tenant isolation (the space
// token is the boundary), quotas, rate limits and the kill switch. vitest.config.ts runs the
// gateway with WEFT_SIGNUPS=open and small limits (3 signups/IP/day, 3 repos, 6 tokens, 20 rpm).

import { describe, expect, it, vi } from "vitest";

// Several tests wait out the 5 s grant cache; give each room under a loaded full-gate run.
vi.setConfig({ testTimeout: 90_000 });
import type { FeedPage, RepoList, Welcome } from "@weft/protocol";
import { ADMIN, agentToken, call, createRepo, hello, observerToken, uniqueRepo, wcp } from "./helpers";

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

    const viewer = await spaceToken(s.owner, { kind: "viewer" });
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
    const v = await spaceToken(s.owner, { kind: "viewer" });
    expect((await call("POST", "/v1/space/tokens", v.token, { kind: "viewer" })).status).toBe(403);
    // viewer is observe-only: no human actions
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
    const aView = await spaceToken(A.owner, { kind: "viewer" });
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
    const v = await spaceToken(s.owner, { kind: "viewer" });
    expect((await call("DELETE", "/v1/space", s.owner)).status).toBe(204);
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
    // owner token counts as one of the 6
    for (let i = 0; i < 5; i++) await spaceToken(s.owner, { kind: "viewer" });
    expect((await call("POST", "/v1/space/tokens", s.owner, { kind: "viewer" })).status).toBe(429);
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
    const v = await spaceToken(s.owner, { kind: "viewer" });
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

describe("feed page", () => {
  it("is served without auth, never caches a key, and locks itself down", async () => {
    const r = await call("GET", "/feed");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-security-policy")).toMatch(/connect-src 'self'/);
    const html = await r.text();
    expect(html).toContain("location.hash");
    expect(html).not.toMatch(/weft_[A-Za-z0-9_-]{20,}/);
  });
});
