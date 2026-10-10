import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ReferenceCoordinator,
  runScenario,
  scenarioClock,
  scenarioInit,
  WcpProtocolError,
  type ConformanceTarget,
  type Hello,
  type Scenario,
} from "@weft/protocol";
import { SqlCoordinator } from "./coordinator";
import { JournaledCoordinator, replay } from "./journal";
import { nodeSql } from "./node-sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = join(here, "../../protocol/fixtures/scenarios");
const scenarios = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ name: f.replace(/\.json$/, ""), data: JSON.parse(readFileSync(join(scenarioDir, f), "utf8")) as Scenario }));

const initOf = (sc: Scenario) => scenarioInit(sc);

/** ConformanceTarget over a journaled SqlCoordinator (what the Durable Object runs). */
function sqlTarget(j: JournaledCoordinator): ConformanceTarget {
  return {
    hello: (h) => j.call("hello", h),
    submit: (s, m) => j.call("submit", s, m),
    drain: (s, ack) => j.call("drain", s, ack),
    gate: (s, g) => j.call("gate", s, g),
    heartbeat: (s) => j.call("heartbeat", s),
    bye: (s, r) => void j.call("bye", s, r),
    action: (h, a) => j.call("action", h, a),
    system: (d, a) => j.call("system", d, a),
    tick: () => j.call("tick"),
    events: (after, limit, o) => j.coord.events({ ...(after !== undefined ? { after } : {}), ...(limit !== undefined ? { limit } : {}), ...o }),
    event: (seq) => j.coord.event(seq),
    policy: (p) => j.call("policy", p),
  };
}

async function runSql(sc: Scenario) {
  const clock = scenarioClock(sc.start);
  const sql = nodeSql();
  SqlCoordinator.init(sql, initOf(sc));
  const j = new JournaledCoordinator(sql, clock.now);
  const results = await runScenario(sc, sqlTarget(j), clock);
  return { sql, j, results };
}

async function runRef(sc: Scenario) {
  const clock = scenarioClock(sc.start);
  const coord = new ReferenceCoordinator({ ...initOf(sc), now: clock.now });
  const results = await runScenario(sc, coord, clock);
  return { coord, results };
}

describe("SqlCoordinator conformance (spec §12)", () => {
  it("has all scenarios", () => expect(scenarios.length).toBeGreaterThanOrEqual(11));

  it.each(scenarios)("$name passes", async ({ data }) => {
    const { results } = await runSql(data);
    const failed = results.filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });

  it.each(scenarios)("$name: every step output equals the reference coordinator's", async ({ data }) => {
    const sql = await runSql(data);
    const ref = await runRef(data);
    expect(sql.results.map((r) => r.actual)).toEqual(ref.results.map((r) => r.actual));
    expect(sql.j.coord.events({ limit: 500, include_diff: true }).events).toEqual(ref.coord.log);
    expect(sql.j.coord.summary()).toEqual(ref.coord.summary());
  });

  it.each(scenarios)("$name: journal replay reproduces log and state exactly", async ({ data }) => {
    const live = await runSql(data);
    const entries = live.j.journal();
    const re = replay(nodeSql(), initOf(data), entries);
    expect(JSON.stringify(re.coord.dump())).toBe(JSON.stringify(live.j.coord.dump()));
    // And replay of the replay is a fixed point.
    const again = replay(nodeSql(), initOf(data), entries);
    expect(again.results).toEqual(re.results);
  });
});

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
const hello = (id: string, change: string, priority = 0): Hello => ({
  type: "hello",
  protocol: "wcp/0.1",
  agent: { id, harness: "claude-code" },
  capabilities: caps,
  task: { id: `T-${id}`, priority },
  change,
});

function fresh(init: Partial<Parameters<typeof SqlCoordinator.init>[1]> = {}) {
  let t = Date.parse("2026-10-05T12:00:00.000Z");
  const clock = { now: () => t, set: (v: number) => void (t = v), advance: (ms: number) => void (t += ms) };
  const sql = nodeSql();
  SqlCoordinator.init(sql, { repo: "r", ...init });
  return { sql, clock, j: new JournaledCoordinator(sql, clock.now) };
}

describe("SqlCoordinator persistence and extras", () => {
  it("state survives re-instantiation (Durable Object eviction)", () => {
    const { sql, clock, j } = fresh();
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    j.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#f", kind: "signature" }] } });
    const b = j.call<{ session: string }>("hello", hello("b", "B"));
    // Throw the instance away; a new one over the same storage must see everything.
    const j2 = new JournaledCoordinator(sql, clock.now);
    const v = j2.call<{ verdict: string; diagnostics: Array<{ code: string }> }>("submit", b.session, {
      type: "submit",
      mode: "commit",
      event: { kind: "edit", base_seq: 1, reads: ["src/x.ts#f"], writes: [{ key: "src/y.ts#g", kind: "body" }] },
    });
    expect(v.verdict).toBe("reject");
    expect(v.diagnostics.map((d) => d.code)).toEqual(["stale_assumption"]);
    expect(j2.coord.head).toBe(4);
  });

  it("Idempotency-Key returns the original verdict and appends nothing", () => {
    const { j } = fresh();
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    const sub = { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#f", kind: "body" }] } };
    const v1 = j.call("submit", a.session, sub, { idempotencyKey: "k1" });
    const v2 = j.call("submit", a.session, sub, { idempotencyKey: "k1" });
    expect(v2).toEqual(v1);
    expect(j.coord.head).toBe(2);
    j.call("submit", a.session, sub, { idempotencyKey: "k2" });
    expect(j.coord.head).toBe(3);
  });

  it("session ownership: another agent's token cannot use the session", () => {
    const { j } = fresh();
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    expect(() => j.call("drain", a.session, undefined, "mallory")).toThrowError(WcpProtocolError);
    expect(() => j.call("drain", a.session, undefined, "a")).not.toThrow();
  });

  it("ts is non-decreasing even if the clock steps back", () => {
    const { clock, j } = fresh();
    j.call("hello", hello("a", "A"));
    clock.advance(-60_000);
    j.call("hello", hello("b", "B"));
    const ev = j.coord.events().events;
    expect(ev[1]!.ts >= ev[0]!.ts).toBe(true);
  });

  it("server-side filters and next_after = highest seq examined", () => {
    const { j } = fresh();
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    j.call("hello", hello("b", "B"));
    for (let i = 0; i < 3; i++)
      j.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: `src/x.ts#f${i}`, kind: "body" }], diff: "+x" } });
    const page = j.coord.events({ filters: { kind: ["edit"] }, limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(page.events[0]!.has_diff).toBe(true);
    expect(page.events[0]!.diff).toBeUndefined();
    expect(page.has_more).toBe(true);
    const page2 = j.coord.events({ filters: { kind: ["edit"] }, after: page.next_after, limit: 2 });
    expect(page2.events.map((e) => e.seq)).toEqual([5]);
    const none = j.coord.events({ filters: { agent: ["nobody"] } });
    expect(none.events).toEqual([]);
    expect(none.next_after).toBe(5);
    expect(none.has_more).toBe(false);
  });

  it("submit queue: enqueue is idempotent per change; land marks it landed and logs an op", () => {
    const { j } = fresh();
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    j.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
    const q1 = j.call<{ id: number }>("enqueue", "A", "human:john");
    const q2 = j.call<{ id: number }>("enqueue", "A", "human:john");
    expect(q2.id).toBe(q1.id);
    expect(j.coord.queue()).toHaveLength(1);
    j.call("system", { kind: "land", base_seq: 2, change: "A", payload: { sha: "abc1234", op_id: "op-1" } });
    expect(j.coord.queue()).toHaveLength(0);
    expect(j.coord.queue(["landed"])[0]).toMatchObject({ change: "A", status: "landed", landed_seq: 3 });
    expect(j.coord.ops()).toEqual([expect.objectContaining({ op_id: "op-1", seq: 3, kind: "land", change_id: "A", sha: "abc1234" })]);
  });

  it("system checkpoint (Artifacts push) matches the reference and is attributed to the change", () => {
    const { j } = fresh();
    const ref = new ReferenceCoordinator({ repo: "r", now: () => Date.parse("2026-10-05T12:00:00.000Z") });
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    ref.hello(hello("a", "A"));
    const sys = { type: "system" as const, id: "artifacts" };
    const draft = { kind: "checkpoint" as const, base_seq: 1, change: "A", payload: { sha: "a".repeat(40), ref: "refs/heads/main" } };
    const rec = j.call<{ seq: number; kind: string; agent?: string; change?: string; status: string; actor: unknown }>("system", draft, sys);
    expect(rec).toMatchObject({ kind: "checkpoint", status: "accepted", agent: "a", change: "A", actor: sys });
    const rrec = ref.system(draft, sys);
    expect({ ...rrec, ts: undefined, repo: undefined }).toEqual({ ...rec, ts: undefined, repo: undefined });
    // Unknown change (no session yet): recorded with the draft's change/task, no agent.
    const anon = j.call<{ agent?: string; change?: string; task?: string }>("system", { kind: "checkpoint", base_seq: 2, change: "B", task: "T", payload: { sha: "b".repeat(40) } }, sys);
    expect(anon).toMatchObject({ change: "B", task: "T" });
    expect(anon.agent).toBeUndefined();
    expect(a.session).toBeTruthy();
    // Still forbidden: kinds outside the system set.
    expect(() => j.call("system", { kind: "edit", base_seq: 3, writes: [{ key: "x#y", kind: "body" }] }, sys)).toThrow(WcpProtocolError);
  });

  it("system message (workflow bounce) reaches the change's agent inbox, same as the reference", () => {
    const { j } = fresh();
    const ref = new ReferenceCoordinator({ repo: "r", now: () => Date.parse("2026-10-05T12:00:00.000Z") });
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    ref.hello(hello("a", "A"));
    const sys = { type: "system" as const, id: "workflows" };
    const draft = { kind: "message" as const, base_seq: 1, change: "A", payload: { to: { change: "A" }, text: "rebase conflict in src/x.ts", intent: "steer" } };
    const rec = j.call<{ seq: number; status: string; change?: string }>("system", draft, sys);
    expect(rec).toMatchObject({ status: "accepted", change: "A" });
    const rrec = ref.system(draft, sys);
    expect({ ...rrec, ts: undefined, repo: undefined }).toEqual({ ...rec, ts: undefined, repo: undefined });
    const inbox = j.call<{ items: Array<{ kind: string; seq: number }> }>("drain", a.session);
    expect(inbox.items.some((i) => i.kind === "message" && i.seq === rec.seq)).toBe(true);
  });

  it("nextExpiry reports the earliest claim or session expiry", () => {
    const { clock, j } = fresh({ claim_ttl_ms: 1000, session_ttl_ms: 5000 });
    expect(j.coord.nextExpiry()).toBeNull();
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    j.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#f", kind: "body" }] } });
    expect(j.coord.nextExpiry()).toBe(clock.now() + 1000);
  });
});

describe("schema migration", () => {
  it("adds changes.merged_into to a v1 database and keeps its data", () => {
    const sql = nodeSql();
    // The v1 changes table (before B11) had no merged_into column.
    sql.exec(`CREATE TABLE changes (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, agent TEXT NOT NULL, task TEXT, priority INTEGER NOT NULL, birth INTEGER,
      landed INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0)`).toArray();
    sql.exec(`INSERT INTO changes (id, ord, agent, task, priority) VALUES ('I-old', 1, 'claude-a', 'T-1', 0)`).toArray();
    sql.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`).toArray();
    sql.exec(`INSERT INTO meta (k, v) VALUES ('schema_version', '1')`).toArray();
    SqlCoordinator.init(sql, { repo: "demo" });
    const cols = sql.exec<{ name: string }>(`PRAGMA table_info(changes)`).toArray().map((r) => r.name);
    expect(cols).toContain("merged_into");
    expect(sql.exec<{ id: string; merged_into: string | null }>(`SELECT id, merged_into FROM changes`).toArray()).toEqual([{ id: "I-old", merged_into: null }]);
    expect(sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'schema_version'`).toArray()[0]!.v).toBe("2");
    // A config written before B11 has no escalation field: it reads as auto.
    sql.exec(`UPDATE meta SET v = ? WHERE k = 'config'`, JSON.stringify({ repo: "demo", policy: "wound-wait", claim_ttl_ms: 1, session_ttl_ms: 1, heartbeat_interval_ms: 1, limits: { max_diff_bytes: 1, max_keys: 1, max_page: 1 } })).toArray();
    expect(new SqlCoordinator(sql).escalation).toBe("auto");
  });
});
