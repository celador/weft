// Team join (docs/hosted.md "Teammates"): the owner mints a one-time invite code, a teammate on another machine trades
// it at POST /v1/join for a *member key*. A member key reads the space and sets up checkouts (agent keys for its own
// agent ids `<name>.<handle>`, a CLI read session, pairing codes); it cannot add repos, mint landing keys, invite, list
// or remove members, touch billing, list or unpair devices, or erase the space. Removing a member revokes its key and
// everything it minted. vitest.config.ts: 3 signups/network/day, 3 repos, 6 active keys, 20 rpm per space, 3 devices.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Verdict, Welcome } from "@weft/protocol";
import type { Registry } from "../src/registry";
import { call, hello, wcp } from "./helpers";

vi.setConfig({ testTimeout: 90_000 });

let ipN = 0;
const freshIp = () => `203.0.113.${(ipN++ % 250) + 1}-${crypto.randomUUID().slice(0, 6)}`;

async function signup() {
  const r = await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": freshIp() });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { space: { id: string }; token: string };
  return { id: j.space.id, owner: j.token };
}

async function spaceRepo(key: string, name: string) {
  const r = await call("POST", "/v1/space/repos", key, { name });
  expect([200, 201]).toContain(r.status);
  return ((await r.json()) as { repo: string }).repo;
}

async function invite(owner: string): Promise<string> {
  const r = await call("POST", "/v1/space/invites", owner);
  expect(r.status).toBe(201);
  const j = (await r.json()) as { code: string; expires_in: number; space: string };
  expect(j.expires_in).toBe(1800);
  return j.code;
}

const join = (space: string, code: string, label = "Alice on alice-mbp", handle?: string, ip = freshIp()) =>
  call("POST", "/v1/join", undefined, { space, code, label, ...(handle ? { handle } : {}) }, { "cf-connecting-ip": ip });

async function member(s: { id: string; owner: string }, label: string, handle?: string) {
  const r = await join(s.id, await invite(s.owner), label, handle);
  expect(r.status).toBe(201);
  return (await r.json()) as { token: string; role: string; member: { id: string; handle: string; label: string } };
}

const registry = () => env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
const grace = () => new Promise((r) => setTimeout(r, 5_200)); // space grants are cached for 5 s

describe("team join: invite codes", () => {
  it("the owner mints a 10-symbol code; a teammate trades it once for a member key (never in a URL)", async () => {
    const s = await signup();
    const code = await invite(s.owner);
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    const r = await join(s.id, code.toLowerCase().replace("-", " "), "Alice on alice-mbp", "Alice"); // case and separators do not matter
    expect(r.status).toBe(201);
    const j = (await r.json()) as { type: string; role: string; token: string; space: { id: string }; member: { id: string; handle: string; label: string } };
    expect(j).toMatchObject({ type: "space.member", role: "member", space: { id: s.id }, member: { handle: "alice", label: "Alice on alice-mbp" } });
    expect(j.token).toMatch(/^weft_/);
    expect(j.member.id).toMatch(/^mem_/);
    // single use
    expect((await join(s.id, code)).status).toBe(401);
    // the member reads the space and is told who it is
    const info = await wcp<{ role: string; member: { handle: string }; space: { id: string; members: number } }>("GET", "/v1/space", j.token);
    expect(info).toMatchObject({ role: "member", member: { handle: "alice" }, space: { id: s.id, members: 1 } });
    expect((await wcp<{ role: string }>("GET", "/v1/space", s.owner)).role).toBe("owner");
  });

  it("wrong, unknown-space, other-space and expired codes all fail the same way", async () => {
    const A = await signup();
    const B = await signup();
    const codeA = await invite(A.owner);
    const answers = [await join(A.id, "ZZZZZ-ZZZZZ"), await join("spzzzzzzzzzz", codeA), await join(B.id, codeA)];
    for (const r of answers) {
      expect(r.status).toBe(401);
      expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/not valid or has expired/);
    }
    // expiry: age the open invite past its 30 minutes
    await runInDurableObject(registry(), async (_o: Registry, state) => {
      state.storage.sql.exec(`UPDATE invites SET expires_at = ? WHERE space = ?`, new Date(Date.now() - 1000).toISOString(), A.id);
    });
    expect((await join(A.id, codeA)).status).toBe(401);
    // a bad body is a 400, not a 401
    expect((await call("POST", "/v1/join", undefined, { space: "nope", code: "x" }, { "cf-connecting-ip": freshIp() })).status).toBe(400);
  });

  it("codes are stored only as salted hashes; at most 5 are open, the 6th retires the oldest; the owner can cancel them", async () => {
    const s = await signup();
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) codes.push(await invite(s.owner));
    const rows = await runInDurableObject(registry(), async (_o: Registry, state) => state.storage.sql.exec<{ code_hash: string }>(`SELECT code_hash FROM invites WHERE space = ?`, s.id).toArray());
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
      for (const c of codes) expect(r.code_hash).not.toContain(c.replace("-", ""));
    }
    expect((await join(s.id, codes[0]!)).status).toBe(401); // retired
    expect((await call("DELETE", "/v1/space/invites", s.owner)).status).toBe(200);
    expect((await join(s.id, codes[5]!)).status).toBe(401); // cancelled
  });

  it("two requests racing for one code: exactly one wins", async () => {
    const s = await signup();
    const code = await invite(s.owner);
    const [a, b] = await Promise.all([join(s.id, code, "a"), join(s.id, code, "b")]);
    expect([a.status, b.status].sort()).toEqual([201, 401]);
  });

  it("brute force: join attempts are rate limited per network and per space", async () => {
    const s = await signup();
    const ip = freshIp();
    let limited = 0;
    for (let i = 0; i < 14; i++) if ((await join(s.id, "ZZZZZ-ZZZZZ", "x", undefined, ip)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    // per space too: fresh networks, same space
    const t = await signup();
    let spaceLimited = 0;
    for (let i = 0; i < 14; i++) if ((await join(t.id, "ZZZZZ-ZZZZZ", "x")).status === 429) spaceLimited++;
    expect(spaceLimited).toBeGreaterThan(0);
  });

  it("handles are unique in the space (removed members' handles included), and plain text", async () => {
    const s = await signup();
    const a = await member(s, "Alice", "alice");
    const b = await member(s, "Alice again", "alice");
    expect([a.member.handle, b.member.handle]).toEqual(["alice", "alice-2"]);
    expect((await call("DELETE", `/v1/space/members/${a.member.id}`, s.owner)).status).toBe(200);
    const c = await member(s, "\u0007Al ice <b>", "Al ice <b>");
    expect(c.member.handle).toBe("al-ice-b");
    expect(c.member.label).toBe("Al ice <b>");
    const d = await member(s, "x", "alice");
    expect(d.member.handle).toBe("alice-3"); // alice was removed, but its handle is never handed out again
  });
});

describe("team join: what a member key can and cannot do", () => {
  it("sets up checkouts: existing repos, agent keys for <name>.<handle> only, a CLI read session, pairing codes", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    const m = await member(s, "Bob on bob-pc", "bob");
    // an existing repo answers as for the owner; a new name is the owner's call
    expect((await call("POST", "/v1/space/repos", m.token, { name: "app" })).status).toBe(200);
    const nr = await call("POST", "/v1/space/repos", m.token, { name: "other" });
    expect(nr.status).toBe(403);
    expect(((await nr.json()) as { error: { message: string } }).error.message).toMatch(/it has: app/);
    // agent ids carry the member's handle, so they never clash with the owner's or another member's
    const bad = await call("POST", "/v1/space/tokens", m.token, { kind: "agent", repo, agent: "app" });
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toMatch(/end in \.bob.*app\.bob/);
    expect((await call("POST", "/v1/space/tokens", m.token, { kind: "agent", repo, agent: "app.alice" })).status).toBe(403);
    expect((await call("POST", "/v1/space/tokens", m.token, { kind: "system", repo })).status).toBe(403);
    const t = await call("POST", "/v1/space/tokens", m.token, { kind: "agent", repo, agent: "app.bob" });
    expect(t.status).toBe(201);
    const agent = (await t.json()) as { token: string; info: { id: string } };
    expect((await call("POST", `/v1/repos/${repo}/sessions`, agent.token, hello("app.bob", "I-bob"))).status).toBe(201);
    // read session for the member's CLI, and pairing codes for its browsers
    const v = await call("POST", "/v1/space/viewers", m.token, { label: "weft CLI on bob-pc" });
    expect(v.status).toBe(201);
    expect((await call("GET", "/v1/feed?tail=1&limit=5", ((await v.json()) as { token: string }).token)).status).toBe(200);
    expect((await call("POST", "/v1/space/pairings", m.token)).status).toBe(201);
    // revoke what it minted
    expect((await call("DELETE", `/v1/space/tokens/${agent.info.id}`, m.token)).status).toBe(204);
  });

  it("cannot erase, bill, invite, list or remove members, list or unpair devices, or revoke anyone else's keys", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    const m = await member(s, "Mallory", "mallory");
    const other = await member(s, "Alice", "alice");
    const ownerAgent = (await (await call("POST", "/v1/space/tokens", s.owner, { kind: "agent", repo, agent: "app" })).json()) as { info: { id: string } };
    const forbidden: Array<[string, string, unknown?]> = [
      ["DELETE", "/v1/space"],
      ["POST", "/v1/space/billing/checkout", { seats: 1, interval: "month" }],
      ["POST", "/v1/space/billing/portal", {}],
      ["POST", "/v1/space/invites"],
      ["DELETE", "/v1/space/invites"],
      ["GET", "/v1/space/members"],
      ["DELETE", "/v1/space/members"],
      ["DELETE", `/v1/space/members/${other.member.id}`],
      ["GET", "/v1/space/viewers"],
      ["DELETE", "/v1/space/viewers"],
    ];
    // Spread over two spaces: one space gets 20 requests a minute in the test config.
    const s2 = await signup();
    const m2 = await member(s2, "Mallory", "mallory");
    for (const [i, [method, path, body]] of forbidden.entries()) {
      const key = i % 2 ? m2.token : m.token;
      expect([method, path, (await call(method, path.replace(other.member.id, i % 2 ? "mem_none" : other.member.id), key, body)).status]).toEqual([method, path, 403]);
    }
    // another member's or the owner's keys look like they do not exist
    expect((await call("DELETE", `/v1/space/tokens/${ownerAgent.info.id}`, m.token)).status).toBe(404);
    expect((await call("DELETE", `/v1/space/tokens/${other.member.id}`, m.token)).status).toBe(404);
    // no WCP access with the member key itself
    expect((await call("GET", `/v1/repos/${repo}/events`, m.token)).status).toBe(404);
    expect((await call("GET", "/v1/feed", m.token)).status).toBe(403);
    // the space is intact
    expect((await call("GET", "/v1/space", s.owner)).status).toBe(200);
  });

  it("a member key reaches only its own space", async () => {
    const A = await signup();
    const B = await signup();
    const rb = await spaceRepo(B.owner, "app");
    await spaceRepo(A.owner, "app");
    const m = await member(A, "Alice", "alice");
    expect((await call("POST", "/v1/space/tokens", m.token, { kind: "agent", repo: rb, agent: "app.alice" })).status).toBe(404);
    expect((await call("DELETE", `/v1/space/tokens/x`, m.token)).status).toBe(404);
    const info = await wcp<{ space: { id: string; repos: Array<{ repo: string }> } }>("GET", "/v1/space", m.token);
    expect(info.space.id).toBe(A.id);
    expect(info.space.repos.map((r) => r.repo)).toEqual([`${A.id}-app`]);
  });
});

describe("team join: two people, same harness, same symbol", () => {
  it("their agents get distinct ids, so one's signature change is a stale_assumption for the other", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "shop");
    const alice = await member(s, "Alice on alice-mbp", "alice");
    const bob = await member(s, "Bob on bob-pc", "bob");
    // Both machines have a checkout called `shop` running Claude Code: the CLI makes them shop.alice and shop.bob.
    const mint = async (key: string, agent: string) => ((await (await call("POST", "/v1/space/tokens", key, { kind: "agent", repo, agent })).json()) as { token: string }).token;
    const ta = await mint(alice.token, "shop.alice");
    const tb = await mint(bob.token, "shop.bob");
    const base = `/v1/repos/${repo}`;
    const sa = await wcp<Welcome>("POST", `${base}/sessions`, ta, hello("shop.alice", "I-alice"));
    const sb = await wcp<Welcome>("POST", `${base}/sessions`, tb, hello("shop.bob", "I-bob"));
    const K = "src/pricing.ts#calcTotal";
    const a = await wcp<Verdict>("POST", `${base}/sessions/${sa.session}/events`, ta, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: sa.delivered_through, writes: [{ key: K, kind: "signature" }] } });
    expect(a.verdict).toBe("accept");
    const b = await wcp<Verdict>("POST", `${base}/sessions/${sb.session}/events`, tb, {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: sb.delivered_through, reads: [K], writes: [{ key: "src/cart.ts#cartTotal", kind: "body" }] },
    });
    expect(b.verdict).toBe("reject");
    expect(b.diagnostics).toEqual([expect.objectContaining({ code: "stale_assumption", symbol: K, caused_by_agent: "shop.alice" })]);

    // Why the suffix matters: two machines sharing a copied owner key both call their agent `shop`, and an agent is
    // never checked against itself, so the same pair of edits goes through with no diagnostic at all. (A second space:
    // the test config allows 6 keys per space.)
    const c = await signup();
    const crepo = await spaceRepo(c.owner, "shop");
    const mintC = async (agent: string) => ((await (await call("POST", "/v1/space/tokens", c.owner, { kind: "agent", repo: crepo, agent })).json()) as { token: string }).token;
    const t1 = await mintC("shop");
    const t2 = await mintC("shop");
    const cbase = `/v1/repos/${crepo}`;
    const s1 = await wcp<Welcome>("POST", `${cbase}/sessions`, t1, hello("shop", "I-same"));
    const s2 = await wcp<Welcome>("POST", `${cbase}/sessions`, t2, hello("shop", "I-same"));
    const K2 = "src/pricing.ts#applyTax";
    await wcp<Verdict>("POST", `${cbase}/sessions/${s1.session}/events`, t1, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: s1.delivered_through, writes: [{ key: K2, kind: "signature" }] } });
    const same = await wcp<Verdict>("POST", `${cbase}/sessions/${s2.session}/events`, t2, {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: s2.delivered_through, reads: [K2], writes: [{ key: "src/cart.ts#cartTax", kind: "body" }] },
    });
    expect(same.verdict).toBe("accept");
    expect(same.diagnostics.filter((d) => d.code === "stale_assumption")).toEqual([]);
  });
});

describe("team join: removing members", () => {
  it("the owner lists members and removes one: its key and every key, session and code it minted stop at once", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    const m = await member(s, "Bob on bob-pc", "bob");
    const keep = await member(s, "Alice", "alice");
    const agent = (await (await call("POST", "/v1/space/tokens", m.token, { kind: "agent", repo, agent: "app.bob" })).json()) as { token: string };
    const view = (await (await call("POST", "/v1/space/viewers", m.token, { label: "weft CLI on bob-pc" })).json()) as { token: string };
    const pairing = (await (await call("POST", "/v1/space/pairings", m.token)).json()) as { code: string };
    const list = await wcp<{ members: Array<{ id: string; handle: string; label: string; created_at: string; last_seen_at: string }> }>("GET", "/v1/space/members", s.owner);
    expect(list.members.map((x) => x.handle)).toEqual(["bob", "alice"]);
    // devices list who paired them
    const devs = await wcp<{ viewers: Array<{ label: string; by?: string }> }>("GET", "/v1/space/viewers", s.owner);
    expect(devs.viewers.find((d) => d.label === "weft CLI on bob-pc")?.by).toBe("bob");

    const del = await call("DELETE", `/v1/space/members/${m.member.id}`, s.owner);
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ type: "space.member.removed", revoked: 3 }); // member key, agent key, CLI session
    expect((await call("DELETE", `/v1/space/members/${m.member.id}`, s.owner)).status).toBe(404);
    // its open pairing code is gone (in this isolate at once; grants elsewhere within 5 s)
    expect((await call("POST", "/v1/pair", undefined, { space: s.id, code: pairing.code }, { "cf-connecting-ip": freshIp() })).status).toBe(401);
    await grace();
    expect((await call("GET", "/v1/space", m.token)).status).toBe(401);
    expect((await call("POST", `/v1/repos/${repo}/sessions`, agent.token, hello("app.bob", "I-b"))).status).toBe(401);
    expect((await call("GET", "/v1/feed", view.token)).status).toBe(401);
    // the other member is untouched
    expect((await call("GET", "/v1/space", keep.token)).status).toBe(200);
    expect((await wcp<{ members: unknown[] }>("GET", "/v1/space/members", s.owner)).members).toHaveLength(1);
  });

  it("a member removed while its request is in flight mints nothing (the Registry checks the member in the same step)", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    const m = await member(s, "Bob", "bob");
    const r = await runInDurableObject(registry(), async (o: Registry) => {
      await o.memberRevoke(s.id, m.member.id);
      return o.spaceIssueToken(s.id, { kind: "agent", repo, agent: "app.bob" }, 10, { id: m.member.id, handle: "bob" });
    });
    expect(r).toMatchObject({ code: "gone" });
  });

  it("a member can leave; DELETE /v1/space/members and erasure remove everyone", async () => {
    const s = await signup();
    await spaceRepo(s.owner, "app");
    const a = await member(s, "A", "a");
    const left = await call("DELETE", "/v1/space/members/me", a.token);
    expect(left.status).toBe(200);
    expect(await left.json()).toMatchObject({ type: "space.member.left", revoked: 1 });
    expect((await call("DELETE", "/v1/space/members/me", s.owner)).status).toBe(400);
    const b = await member(s, "B", "b");
    const c = await member(s, "C", "c");
    expect(await (await call("DELETE", "/v1/space/members", s.owner)).json()).toMatchObject({ revoked: 2 });
    await invite(s.owner);
    expect((await call("DELETE", "/v1/space", s.owner)).status).toBe(200);
    await grace();
    for (const t of [a.token, b.token, c.token]) expect((await call("GET", "/v1/space", t)).status).toBe(401);
    const left2 = await runInDurableObject(registry(), async (_o: Registry, state) => ({
      invites: state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invites WHERE space = ?`, s.id).one().n,
      tokens: state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ?`, s.id).one().n,
    }));
    expect(left2).toEqual({ invites: 0, tokens: 0 });
  });

  it("a member counts as an active key: a full space refuses the join without burning the code", async () => {
    const s = await signup();
    const repo = await spaceRepo(s.owner, "app");
    // owner + 4 system keys = 5 of 6
    for (let i = 0; i < 4; i++) expect((await call("POST", "/v1/space/tokens", s.owner, { kind: "system", repo })).status).toBe(201);
    const m = await member(s, "A", "a"); // 6 of 6
    expect(m.member.handle).toBe("a");
    const code = await invite(s.owner);
    expect((await join(s.id, code)).status).toBe(429);
    expect((await call("DELETE", `/v1/space/members/${m.member.id}`, s.owner)).status).toBe(200);
    expect((await join(s.id, code)).status).toBe(201); // the same code still works
  });
});
