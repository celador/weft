// Retention metrics (counts only): per-space last_event_at and per-UTC-day event counts, the
// active / retained numbers in GET /v1/admin/stats, the `internal` tag that keeps our own test and
// demo spaces out of the headline, and what the counters do not store.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Welcome } from "@weft/protocol";
import type { Registry, RetentionStats } from "../src/registry";
import { ADMIN, call, hello, wcp } from "./helpers";

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
const registryStub = () => env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
let ipN = 0;

async function signup(label?: string) {
  const r = await call("POST", "/v1/spaces", undefined, label ? { label } : {}, { "cf-connecting-ip": `203.0.113.${(ipN++ % 200) + 1}-${crypto.randomUUID().slice(0, 6)}` });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { space: { id: string }; token: string };
  return { id: j.space.id, owner: j.token };
}

type Stats = { days: Array<{ day: string; spaces: number }>; spaces: { total: number; active: number }; retention: RetentionStats };
const stats = () => wcp<Stats>("GET", "/v1/admin/stats", ADMIN);
const row = (s: Stats, id: string) => s.retention.spaces.find((x) => x.id === id);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Records `events` events for a space at `now - daysAgo` days (registry-level, so the test controls the clock). */
const record = (id: string, daysAgo: number, events = 1, now = Date.now()) =>
  runInDurableObject(registryStub(), async (inst: Registry) => {
    for (let i = 0; i < events; i++) await inst.recordSpaceEvent(id, now - daysAgo * DAY);
  });

describe("retention counters in the Registry", () => {
  it("counts active (7d / 30d) and retained spaces from per-day activity, and leaves internal spaces out", async () => {
    const now = Date.now();
    const [once, back, old, ancient, quiet, mine] = await Promise.all(["once", "back", "old", "ancient", "quiet", "mine"].map((l) => signup(l)));
    const before = (await stats()).retention;

    await record(once!.id, 0, 3); // one day only: active, not retained
    await record(back!.id, 0); // two days, one today: retained
    await record(back!.id, 3, 2);
    await record(old!.id, 20, 2); // active in 30d, not 7d; two days but none in the last 7
    await record(old!.id, 25);
    await record(ancient!.id, 40); // outside 30d: not active
    await record(mine!.id, 0, 5); // internal: would be active and retained
    await record(mine!.id, 1);
    expect((await call("POST", `/v1/admin/spaces/${mine!.id}/tag`, ADMIN, { internal: true })).status).toBe(200);

    const after = await stats();
    const d = (k: "active_7d" | "active_30d" | "retained") => after.retention[k] - before[k];
    expect(d("active_7d")).toBe(2); // once, back
    expect(d("active_30d")).toBe(3); // once, back, old
    expect(d("retained")).toBe(1); // back
    expect(after.retention.internal_spaces).toBe(before.internal_spaces + 1);

    expect(row(after, once!.id)).toMatchObject({ label: "once", status: "active", active_days_30: 1 });
    expect(row(after, back!.id)).toMatchObject({ active_days_30: 2 });
    expect(row(after, old!.id)).toMatchObject({ active_days_30: 2 });
    expect(row(after, ancient!.id)).toMatchObject({ active_days_30: 0 });
    expect(row(after, quiet!.id)).toMatchObject({ last_event_at: null, active_days_30: 0 });
    expect(row(after, mine!.id)).toMatchObject({ internal: true, active_days_30: 2 });
    expect(row(after, once!.id)!.created).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(Date.parse(row(after, back!.id)!.last_event_at!)).toBeGreaterThan(now - 5_000); // the newest event wins, not the last one recorded
    // Most recently active first, never-active last.
    const order = after.retention.spaces.map((s) => s.last_event_at);
    expect(order.indexOf(null)).toBeGreaterThan(-1);
    expect(order.slice(order.indexOf(null)).every((x) => x === null)).toBe(true);

    // Events per day: totals across non-internal spaces, internal ones left out.
    const per = (s: Stats, ms: number) => s.retention.events_per_day.find((e) => e.day === day(ms))?.events ?? 0;
    expect(per(after, now)).toBe(per({ retention: before } as Stats, now) + 3 + 1);
    expect(per(after, now - 3 * DAY)).toBe(per({ retention: before } as Stats, now - 3 * DAY) + 2);

    // Untagging puts it back in the headline.
    expect((await call("POST", `/v1/admin/spaces/${mine!.id}/tag`, ADMIN, { internal: false })).status).toBe(200);
    const back2 = await stats();
    expect(back2.retention.retained - before.retained).toBe(2);
    expect(row(back2, mine!.id)!.internal).toBeUndefined();
  });

  it("tagging a space internal removes it from the first-run counts and the space totals", async () => {
    const a = await signup("tag-me");
    const before = await stats();
    const today = day(Date.now());
    expect((await call("POST", `/v1/admin/spaces/${a.id}/tag`, ADMIN, { internal: true })).status).toBe(200);
    const after = await stats();
    expect(after.spaces.total).toBe(before.spaces.total - 1);
    expect(after.spaces.active).toBe(before.spaces.active - 1);
    expect(after.days.find((x) => x.day === today)!.spaces).toBe(before.days.find((x) => x.day === today)!.spaces - 1);
    const list = await wcp<{ spaces: Array<{ id: string; internal?: boolean }> }>("GET", "/v1/admin/spaces", ADMIN);
    expect(list.spaces.find((x) => x.id === a.id)?.internal).toBe(true);
  });

  it("deletes per-day rows older than 90 days, and a deleted space keeps no activity", async () => {
    const s = await signup("prune");
    const now = Date.now();
    await runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => {
      for (const d of [day(now - 95 * DAY), day(now - 90 * DAY), day(now - 89 * DAY), day(now - DAY)]) state.storage.sql.exec(`INSERT OR REPLACE INTO space_days (space, day, n) VALUES (?, ?, 1)`, s.id, d);
    });
    await runInDurableObject(registryStub(), (inst: Registry) => inst.pruneActivity(now));
    const left = () =>
      runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) =>
        state.storage.sql.exec<{ day: string }>(`SELECT day FROM space_days WHERE space = ? ORDER BY day`, s.id).toArray().map((r) => r.day),
      );
    expect(await left()).toEqual([day(now - 89 * DAY), day(now - DAY)]);
    // Recording an event on a new UTC day also prunes.
    await runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => state.storage.sql.exec(`INSERT OR REPLACE INTO space_days (space, day, n) VALUES (?, ?, 1)`, s.id, day(now - 200 * DAY)));
    await runInDurableObject(registryStub(), (inst: Registry) => inst.recordSpaceEvent(s.id, now + 400 * DAY));
    expect((await left()).includes(day(now - 200 * DAY))).toBe(false);

    await record(s.id, 0);
    expect((await call("DELETE", "/v1/space", s.owner)).status).toBeLessThan(300);
    expect(await left()).toEqual([]);
    expect((await stats()).retention.spaces.some((x) => x.id === s.id)).toBe(false); // deleted spaces are not listed
  });

  it("ignores events for unknown or non-active spaces", async () => {
    await record("spdoesnotexist", 0);
    const n = await runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM space_days WHERE space = 'spdoesnotexist'`).one().n);
    expect(n).toBe(0);
  });

  it("stores only a space id, a timestamp, a day and a number: no IP-derived data, no content", async () => {
    const ip = `203.0.113.250-${crypto.randomUUID().slice(0, 6)}`;
    const r = await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": ip });
    const id = ((await r.json()) as { space: { id: string } }).space.id;
    await record(id, 0, 2);
    const dump = await runInDurableObject(registryStub(), (_i: Registry, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const cols = (t: string) => sql.exec<{ name: string }>(`PRAGMA table_info(${t})`).toArray().map((c) => c.name).sort();
      return {
        activity: cols("space_activity"),
        days: cols("space_days"),
        tags: cols("space_tags"),
        rows: JSON.stringify([...sql.exec(`SELECT * FROM space_activity WHERE space = ?`, id), ...sql.exec(`SELECT * FROM space_days WHERE space = ?`, id)]),
      };
    });
    expect(dump.activity).toEqual(["last_event_at", "space"]);
    expect(dump.days).toEqual(["day", "n", "space"]);
    expect(dump.tags).toEqual(["internal", "space"]);
    expect(dump.rows).not.toContain(ip);
  });
});

describe("retention through the gateway", () => {
  const edit = (base: number, key: string) => ({ type: "submit", mode: "commit", event: { kind: "edit", base_seq: base, writes: [{ key, kind: "body" }] } });

  it("an accepted agent event counts for its space; a session hello and a rejected request do not", async () => {
    const s = await signup("gw");
    const repoRes = await call("POST", "/v1/space/repos", s.owner, { name: "app" });
    const repo = ((await repoRes.json()) as { repo: string }).repo;
    const tok = (await (await call("POST", "/v1/space/tokens", s.owner, { kind: "agent", repo, agent: "gw-a" })).json()) as { token: string };
    const sess = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, tok.token, hello("gw-a", "I-gw-a"));
    expect(row(await stats(), s.id)).toMatchObject({ last_event_at: null, active_days_30: 0 });

    expect((await call("POST", `/v1/repos/${repo}/sessions/${sess.session}/events`, tok.token, { nonsense: true })).status).toBe(400);
    expect(row(await stats(), s.id)!.last_event_at).toBeNull();

    const t0 = Date.now();
    await wcp("POST", `/v1/repos/${repo}/sessions/${sess.session}/events`, tok.token, edit(sess.head_seq, "src/a.ts#f"));
    await wcp("POST", `/v1/repos/${repo}/sessions/${sess.session}/events`, tok.token, edit(sess.head_seq + 1, "src/a.ts#g"));
    const after = await stats();
    const r = row(after, s.id)!;
    expect(r).toMatchObject({ label: "gw", status: "active", active_days_30: 1 });
    expect(Date.parse(r.last_event_at!)).toBeGreaterThanOrEqual(t0 - 1_000);
    expect(after.retention.events_per_day.find((e) => e.day === day(Date.now()))!.events).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(after.retention)).not.toMatch(/src\/a\.ts|weft_[A-Za-z0-9_-]{20,}/); // counts only: no paths, no keys
  });

  it("the tag route is admin-only, validates its body, and 404s for an unknown space", async () => {
    const s = await signup();
    expect((await call("POST", `/v1/admin/spaces/${s.id}/tag`, s.owner, { internal: true })).status).toBe(401);
    expect((await call("POST", `/v1/admin/spaces/${s.id}/tag`, undefined, { internal: true })).status).toBe(401);
    expect((await call("POST", `/v1/admin/spaces/${s.id}/tag`, ADMIN, { internal: "yes" })).status).toBe(400);
    expect((await call("POST", `/v1/admin/spaces/${s.id}/tag`, ADMIN, {})).status).toBe(400);
    expect((await call("POST", "/v1/admin/spaces/spnosuchspace/tag", ADMIN, { internal: true })).status).toBe(404);
    expect((await call("GET", "/v1/admin/stats", s.owner)).status).toBe(401);
    expect(await wcp("POST", `/v1/admin/spaces/${s.id}/tag`, ADMIN, { internal: true })).toMatchObject({ type: "space.tagged", space: s.id, internal: true });
  });
});
