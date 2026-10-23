// Observer role (spec §9) and auth (spec §3): repo list, paged events, full detail with
// redaction, combined feed with cursor resume, resumable WebSocket stream, agent socket
// pushes, and the browser auth frame.

import { describe, expect, it } from "vitest";
import { decodeCursor, type EventPage, type EventRecord, type FeedPage, type RepoList, type Verdict, type Welcome } from "@weft/protocol";
import { agentToken, call, createRepo, hello, humanToken, observerToken, openSocket, token, uniqueRepo, wcp } from "./helpers";

const KEY = "src/util/parse.ts#parseJson";

async function repoWithAgent(prefix = "obs") {
  const repo = uniqueRepo(prefix);
  await createRepo(repo);
  const t = await agentToken(repo, "claude-a");
  const s = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, t, hello("claude-a", "I-a"));
  const edit = (base: number, extra: Record<string, unknown> = {}) =>
    wcp<Verdict>("POST", `/v1/repos/${repo}/sessions/${s.session}/events`, t, {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: base, writes: [{ key: KEY, kind: "body" }], ...extra },
    });
  return { repo, t, s, edit };
}

describe("auth (spec §3)", () => {
  it("401 without/invalid token, 404 for repos outside the token, 403 for missing scope", async () => {
    const { repo, s } = await repoWithAgent();
    expect((await call("GET", `/v1/repos/${repo}/events`)).status).toBe(401);
    expect((await call("GET", `/v1/repos/${repo}/events`, "weft_bogus")).status).toBe(401);
    const other = await observerToken(["some-other-repo"]);
    const r404 = await call("GET", `/v1/repos/${repo}/events`, other);
    expect(r404.status).toBe(404);
    expect(await r404.json()).toMatchObject({ type: "error", error: { code: "repo_not_found" } });
    // Observer tokens are rejected on agent and human endpoints.
    const obs = await observerToken([repo]);
    expect((await call("POST", `/v1/repos/${repo}/sessions/${s.session}/inbox`, obs, { type: "inbox.drain" })).status).toBe(403);
    expect((await call("POST", `/v1/repos/${repo}/actions`, obs, { type: "action", action: "pause", agent: "claude-a" })).status).toBe(403);
    // Agent tokens cannot observe and cannot speak for another agent.
    const ta = await agentToken(repo, "claude-a");
    expect((await call("GET", `/v1/repos/${repo}/events`, ta)).status).toBe(403);
    const r = await call("POST", `/v1/repos/${repo}/sessions`, ta, hello("someone-else", "X"));
    expect(r.status).toBe(403);
    // Another agent's token cannot use claude-a's session.
    const tb = await agentToken(repo, "codex-b");
    expect((await call("POST", `/v1/repos/${repo}/sessions/${s.session}/inbox`, tb, { type: "inbox.drain" })).status).toBe(403);
    // Admin API needs the operator secret.
    expect((await call("GET", "/v1/admin/repos", obs)).status).toBe(401);
  });

  it("validates bodies (400 invalid_message with JSON Pointer issues) and versions", async () => {
    const { repo, t, s } = await repoWithAgent();
    const r = await call("POST", `/v1/repos/${repo}/sessions/${s.session}/events`, t, { type: "submit", mode: "commit", event: { kind: "edit" } });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: { code: string; details: { issues: Array<{ path: string }> } } };
    expect(j.error.code).toBe("invalid_message");
    expect(j.error.details.issues.length).toBeGreaterThan(0);
    expect(r.headers.get("wcp-version")).toBe("0.1");
    const v = await call("GET", `/v1/repos/${repo}/events`, await observerToken([repo]), undefined, { "wcp-version": "1.0" });
    expect(v.status).toBe(400);
    expect(await v.json()).toMatchObject({ error: { code: "unsupported_version" } });
  });
});

describe("observer API (spec §9)", () => {
  it("GET /v1/repos lists only visible repos with live counts", async () => {
    const one = await repoWithAgent("list");
    const two = await repoWithAgent("list");
    await one.edit(1);
    const obs = await observerToken([one.repo, two.repo]);
    const list = await wcp<RepoList>("GET", "/v1/repos", obs);
    expect(list.type).toBe("repos");
    expect(list.repos.map((r) => r.repo).sort()).toEqual([one.repo, two.repo].sort());
    expect(list.repos.find((r) => r.repo === one.repo)).toMatchObject({ head_seq: 2, active_agents: 1, active_changes: 1, open_conflicts: 0, policy: { arbitration: "wound-wait" } });
    const narrow = await wcp<RepoList>("GET", "/v1/repos", await observerToken([two.repo]));
    expect(narrow.repos.map((r) => r.repo)).toEqual([two.repo]);
  });

  it("paged events (after/tail/before/filters) and full detail with secrets redacted", async () => {
    const { repo, edit } = await repoWithAgent();
    const secret = "AKIAABCDEFGHIJKLMNOP";
    await edit(1, { diff: `+const k = "${secret}";\n+const api_key = "supersecretvalue123";`, intent: "rotate keys", transcript: { uri: "r2://t/1.jsonl", offset: 7 } });
    for (let i = 0; i < 4; i++) await edit(2 + i);
    const obs = await observerToken([repo]);
    const p1 = await wcp<EventPage>("GET", `/v1/repos/${repo}/events?after=0&limit=2`, obs);
    expect(p1).toMatchObject({ type: "events", repo, head_seq: 6, next_after: 2, has_more: true });
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.events[1]).toMatchObject({ has_diff: true, summary: "claude-a edited parseJson in src/util/parse.ts — rotate keys" });
    expect(p1.events[1]!.diff).toBeUndefined();
    const tail = await wcp<EventPage>("GET", `/v1/repos/${repo}/events?tail=1&limit=2`, obs);
    expect(tail.events.map((e) => e.seq)).toEqual([5, 6]);
    const back = await wcp<EventPage>("GET", `/v1/repos/${repo}/events?before=5&limit=2`, obs);
    expect(back.events.map((e) => e.seq)).toEqual([3, 4]);
    const joins = await wcp<EventPage>("GET", `/v1/repos/${repo}/events?kind=join`, obs);
    expect(joins.events.map((e) => e.seq)).toEqual([1]);
    expect(joins.next_after).toBe(6);
    const detail = await wcp<EventRecord>("GET", `/v1/repos/${repo}/events/2`, obs);
    expect(detail.diff).toContain("[REDACTED:aws-access-key]");
    expect(detail.diff).toContain("[REDACTED:assignment]");
    expect(detail.diff).not.toContain(secret);
    expect(detail.diff).not.toContain("supersecretvalue123");
    expect(detail).toMatchObject({ intent: "rotate keys", transcript: { uri: "r2://t/1.jsonl", offset: 7 }, writes: [{ key: KEY, kind: "body" }] });
    const missing = await call("GET", `/v1/repos/${repo}/events/999`, obs);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("GET /v1/feed merges visible repos and resumes exactly from its cursor", async () => {
    const r1 = await repoWithAgent("feed");
    const r2 = await repoWithAgent("feed");
    await r1.edit(1);
    await r2.edit(1);
    const obs = await observerToken([r1.repo, r2.repo]);
    const f1 = await wcp<FeedPage>("GET", `/v1/feed?limit=3`, obs);
    expect(f1.type).toBe("feed");
    expect(f1.events).toHaveLength(3);
    expect(f1.has_more).toBe(true);
    const f2 = await wcp<FeedPage>("GET", `/v1/feed?after=${encodeURIComponent(f1.cursor)}&limit=10`, obs);
    const seen = [...f1.events, ...f2.events].map((e) => `${e.repo}#${e.seq}`);
    expect(seen.sort()).toEqual([`${r1.repo}#1`, `${r1.repo}#2`, `${r2.repo}#1`, `${r2.repo}#2`].sort());
    expect(new Set(seen).size).toBe(4);
    expect(f2.has_more).toBe(false);
    expect(decodeCursor(f2.cursor)).toEqual({ [r1.repo]: 2, [r2.repo]: 2 });
    await r1.edit(2);
    const f3 = await wcp<FeedPage>("GET", `/v1/feed?after=${encodeURIComponent(f2.cursor)}`, obs);
    expect(f3.events.map((e) => `${e.repo}#${e.seq}`)).toEqual([`${r1.repo}#3`]);
    const tail = await wcp<FeedPage>("GET", `/v1/feed?tail=1&limit=2&repos=${r2.repo}`, obs);
    expect(tail.events.map((e) => e.repo)).toEqual([r2.repo, r2.repo]);
  });

  it("WS /stream replays after `after`, sends replay.done, then goes live; reconnect resumes", async () => {
    const { repo, edit } = await repoWithAgent("stream");
    await edit(1); // #2
    const obs = await observerToken([repo]);
    const s1 = await openSocket(`/v1/repos/${repo}/stream?after=0`, obs);
    await s1.until((f) => f.some((x) => x.type === "replay.done"));
    expect(s1.frames.map((f) => (f.type === "event" ? (f.event as EventRecord).seq : f.type))).toEqual([1, 2, "replay.done"]);
    expect(s1.frames[2]).toEqual({ type: "replay.done", head_seq: 2 });
    await edit(2); // #3 live
    await s1.until((f) => f.some((x) => x.type === "event" && (x.event as EventRecord).seq === 3));
    s1.ws.close(1000, "background");
    // Phone comes back: resume after the last processed seq.
    await edit(3); // #4 while disconnected
    const s2 = await openSocket(`/v1/repos/${repo}/stream?after=3`, obs);
    await s2.until((f) => f.some((x) => x.type === "replay.done"));
    expect(s2.frames.map((f) => (f.type === "event" ? (f.event as EventRecord).seq : f.type))).toEqual([4, "replay.done"]);
    s2.ws.close(1000, "done");
  });

  it("browser-style stream authenticates with a first auth frame; a bad token closes 4401", async () => {
    const { repo } = await repoWithAgent("wsauth");
    const obs = await observerToken([repo]);
    const s = await openSocket(`/v1/repos/${repo}/stream?after=0`);
    s.send({ type: "auth", token: obs, id: "a1" });
    await s.until((f) => f.some((x) => x.type === "replay.done"));
    expect(s.frames[0]).toEqual({ type: "auth.ok", re: "a1" });
    s.ws.close(1000, "done");
    const bad = await openSocket(`/v1/repos/${repo}/stream?after=0`);
    bad.send({ type: "auth", token: "weft_nope" });
    const end = Date.now() + 3000;
    while (!bad.closed() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(bad.closed()?.code).toBe(4401);
  });

  it("agent WebSocket: inbox pushes on new items and request/reply frames carry `re`", async () => {
    const repo = uniqueRepo("agentws");
    await createRepo(repo);
    const ta = await agentToken(repo, "a");
    const tb = await agentToken(repo, "b");
    const a = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, ta, hello("a", "C-a"));
    const b = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, tb, hello("b", "C-b"));
    const sock = await openSocket(`/v1/repos/${repo}/sessions/${b.session}/ws`, tb);
    sock.send({ type: "submit", id: 1, mode: "commit", event: { kind: "edit", base_seq: 2, reads: [KEY], writes: [{ key: "src/b.ts#b", kind: "body" }] } });
    await sock.until((f) => f.some((x) => x.re === 1));
    expect(sock.frames.find((x) => x.re === 1)).toMatchObject({ type: "verdict", verdict: "accept", seq: 3 });
    // A changes the signature B reads → B's socket gets an inbox push without asking.
    await wcp<Verdict>("POST", `/v1/repos/${repo}/sessions/${a.session}/events`, ta, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: KEY, kind: "signature" }] } });
    await sock.until((f) => f.some((x) => x.type === "inbox"));
    const push = sock.frames.find((x) => x.type === "inbox") as { items: Array<{ diagnostic?: { code: string } }>; re?: unknown };
    expect(push.re).toBeUndefined();
    // B's accepted edit already uses KEY, so the change opens a gate-closing error (spec §6.3 step 6).
    expect(push.items.map((i) => i.diagnostic?.code)).toEqual(["stale_assumption"]);
    sock.send({ type: "gate", gate: "stop", id: "g" });
    await sock.until((f) => f.some((x) => x.re === "g"));
    expect(sock.frames.find((x) => x.re === "g")).toMatchObject({ type: "gate.result", allow: false });
    sock.ws.close(1000, "done");
  });

  it("human scope implies observe; actions are attributed to the token principal", async () => {
    const { repo } = await repoWithAgent("human");
    const h = await humanToken([repo], "kathryn");
    expect((await call("GET", `/v1/repos/${repo}/events`, h)).status).toBe(200);
    const r = await wcp<{ record: EventRecord }>("POST", `/v1/repos/${repo}/actions`, h, { type: "action", action: "message", to: { agent: "claude-a" }, text: "ship it" });
    expect(r.record.actor).toEqual({ type: "human", id: "kathryn" });
    const bad = await call("POST", `/v1/repos/${repo}/actions`, h, { type: "action", action: "pause", agent: "ghost" });
    expect(bad.status).toBe(422);
  });

  it("admin: tokens are shown once, listed without secrets, and revocable", async () => {
    const repo = uniqueRepo("adm");
    await createRepo(repo);
    const r = await call("POST", "/v1/admin/tokens", "test-admin-token", { principal: "p", scopes: ["observe"], repos: [repo] });
    const { token: tok, info } = (await r.json()) as { token: string; info: { id: string } };
    expect(tok.startsWith("weft_")).toBe(true);
    const listing = await (await call("GET", "/v1/admin/tokens", "test-admin-token")).text();
    expect(listing).not.toContain(tok);
    expect((await call("DELETE", `/v1/admin/tokens/${info.id}`, "test-admin-token")).status).toBe(204);
    expect((await call("GET", `/v1/repos/${repo}/events`, tok)).status).toBe(401);
    // Agent tokens must be bound to one repo and one agent.
    expect((await call("POST", "/v1/admin/tokens", "test-admin-token", { principal: "x", scopes: ["agent"], repos: "*", agent: "x" })).status).toBe(400);
    await expect(token({ principal: "x", scopes: ["agent"], repos: [repo] })).rejects.toThrow();
  });
});
