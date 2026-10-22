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
import { SqlCoordinator, type CoordinatorInit } from "./coordinator";
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
    setPolicy: (p) => j.call("policy", p),
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
  it("unseen in-flight writes (spec §6.1 U): a late joiner is warned on a fresh database, not on one migrated from v3", () => {
    const run = (migrated: boolean) => {
      const { sql, clock, j } = fresh();
      const a = j.call<{ session: string }>("hello", hello("a", "A"));
      j.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key: "src/x.ts#f", kind: "signature" }] } });
      j.call("bye", a.session);
      let k = j;
      if (migrated) {
        // A v3 database knows nothing about what its changes were told: its log is the floor.
        sql.exec(`UPDATE meta SET v = '3' WHERE k = 'schema_version'`).toArray();
        k = new JournaledCoordinator(sql, clock.now);
      }
      const b = k.call<{ session: string; delivered_through: number }>("hello", hello("b", "B"));
      return k.call<{ verdict: string; diagnostics: Array<{ code: string; caused_by_seq?: number }> }>("submit", b.session, {
        type: "submit",
        mode: "check",
        event: { kind: "edit", base_seq: b.delivered_through, reads: ["src/x.ts#f"], writes: [{ key: "src/y.ts#g", kind: "body" }] },
      });
    };
    expect(run(false)).toMatchObject({ verdict: "reject", diagnostics: [{ code: "stale_assumption", caused_by_seq: 2 }] });
    expect(run(true)).toMatchObject({ verdict: "accept", diagnostics: [] });
  });

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
    const { clock, j } = fresh({ claims: { lease_ms: 1000, firm_max_ms: 2000 }, session_ttl_ms: 5000 });
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
    expect(sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'schema_version'`).toArray()[0]!.v).toBe("4");
    // A config written before B11 has no escalation field: it reads as auto.
    sql.exec(`UPDATE meta SET v = ? WHERE k = 'config'`, JSON.stringify({ repo: "demo", policy: "wound-wait", claim_ttl_ms: 1, session_ttl_ms: 1, heartbeat_interval_ms: 1, limits: { max_diff_bytes: 1, max_keys: 1, max_page: 1 } })).toArray();
    expect(new SqlCoordinator(sql).escalation).toBe("auto");
  });
});

describe("claims policy (spec §7.5) and per-change open errors (§6.5): storage", () => {
  const edit = (base: number, key: string) => ({ type: "submit", mode: "commit", event: { kind: "edit", base_seq: base, writes: [{ key, kind: "body" }] } });

  it("pins the defaults of a new repo: 2-minute lease, 10-minute firm limit", () => {
    const { j } = fresh();
    expect(j.coord.config.claims).toEqual({ lease_ms: 120_000, firm_max_ms: 600_000 });
    const w = j.call<{ claim_ttl_ms: number; policy: unknown }>("hello", hello("a", "A"));
    expect(w.claim_ttl_ms).toBe(120_000);
    expect(w.policy).toEqual({ arbitration: "wound-wait", escalation: "auto", claims: { lease_ms: 120_000, firm_max_ms: 600_000 } });
  });

  it("a legacy config (no claims) keeps the 30-minute claim TTL until the journaled policy op", () => {
    const { sql, j } = fresh({ claims: null });
    expect(j.coord.config.claims).toBeUndefined();
    const w = j.call<{ claim_ttl_ms: number; policy: { claims?: unknown } }>("hello", hello("a", "A"));
    expect(w.claim_ttl_ms).toBe(1_800_000);
    expect("claims" in w.policy).toBe(false);
    expect(j.call("policy", { claims: { lease_ms: 60_000, firm_max_ms: 300_000 } })).toEqual({ arbitration: "wound-wait", escalation: "auto", claims: { lease_ms: 60_000, firm_max_ms: 300_000 } });
    // Persisted in the stored config (survives eviction) and recorded in the journal.
    expect(new SqlCoordinator(sql).config.claims).toEqual({ lease_ms: 60_000, firm_max_ms: 300_000 });
    expect(j.journal().map((e) => e.op)).toEqual(["hello", "policy"]);
  });

  it("rejects an invalid policy without changing anything", () => {
    const { j } = fresh();
    for (const bad of [{}, { claims: { lease_ms: 0, firm_max_ms: 1 } }, { claims: { lease_ms: 1.5, firm_max_ms: 1 } }, { claims: { lease_ms: "1", firm_max_ms: 1 } }])
      expect(() => j.call("policy", bad)).toThrow(WcpProtocolError);
    expect(j.coord.config.claims).toEqual({ lease_ms: 120_000, firm_max_ms: 600_000 });
    expect(() => SqlCoordinator.init(nodeSql(), { repo: "r", claims: { lease_ms: -1, firm_max_ms: 1 } })).toThrow(/lease_ms/);
  });

  it("a legacy repo's journal replays exactly against its stored config, before and after the policy op", () => {
    const { sql, clock, j } = fresh({ claims: null });
    const a = j.call<{ session: string }>("hello", hello("a", "A"));
    j.call("submit", a.session, edit(1, "src/x.ts#f"));
    j.call("bye", a.session); // legacy: no release on exit
    clock.advance(31 * 60_000);
    j.call("tick");
    j.call("policy", { claims: { lease_ms: 120_000, firm_max_ms: 600_000 } });
    const b = j.call<{ session: string }>("hello", hello("b", "B"));
    j.call("submit", b.session, edit(5, "src/y.ts#g"));
    j.call("bye", b.session); // now: released on exit
    const kinds = j.coord.events({ limit: 50 }).events.map((e) => `${e.kind}${e.payload?.reason ? `:${String(e.payload.reason)}` : ""}`);
    expect(kinds).toEqual(["join", "edit", "leave", "release:expired", "join", "edit", "leave", "release:session_ended"]);
    // The stored config of the repo as it was created (no claims) replays it byte for byte.
    const re = replay(nodeSql(), { repo: "r", policy: "wound-wait", escalation: "auto", claim_ttl_ms: 1_800_000, session_ttl_ms: 300_000, heartbeat_interval_ms: 30_000, limits: { max_diff_bytes: 1_048_576, max_keys: 2000, max_page: 500 } }, j.journal());
    expect(JSON.stringify(re.coord.dump())).toBe(JSON.stringify(j.coord.dump()));
    void sql;
  });

  it("migrates v2 per-session open errors to per-change ones (strictest origin)", () => {
    const sql = nodeSql();
    SqlCoordinator.init(sql, { repo: "r" });
    sql.exec(`INSERT INTO sessions (id, ord, agent, harness, change_id, task, capabilities, delivered_through, next_inbox_id, paused_by, last_seen) VALUES ('s1', 1, 'a', 'h', 'A', NULL, '{}', 0, 1, NULL, 0)`).toArray();
    const d = { severity: "error", code: "stale_assumption", file: "src/x.ts", symbol: "src/x.ts#f", message: "m", caused_by_seq: 7, caused_by_agent: "b" };
    sql.exec(`INSERT INTO open_errors (session, key, ord, diagnostic) VALUES ('s1', 'src/x.ts#f', 3, ?)`, JSON.stringify(d)).toArray();
    sql.exec(`UPDATE meta SET v = '2' WHERE k = 'schema_version'`).toArray();
    new SqlCoordinator(sql);
    expect(sql.exec(`SELECT change_id, key, origin, seq FROM change_errors`).toArray()).toEqual([{ change_id: "A", key: "src/x.ts#f", origin: "commit", seq: 7 }]);
    expect(sql.exec(`SELECT COUNT(*) AS n FROM open_errors`).toArray()).toEqual([{ n: 0 }]);
    expect(sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'schema_version'`).toArray()[0]!.v).toBe("4");
  });
});

describe("enforcement mode (per-repo config, SQLite coordinator)", () => {
  const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
  const key = "src/auth/session.ts#refreshToken";
  const edit = { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key, kind: "body" }] } };
  const helloA = { type: "hello", protocol: "wcp/0.1", agent: { id: "claude-a", harness: "claude-code" }, capabilities: caps, task: { id: "T-1" }, change: "I-a" };
  const helloB = { type: "hello", protocol: "wcp/0.1", agent: { id: "codex-b", harness: "codex" }, capabilities: caps, task: { id: "T-2" }, change: "I-b" };
  type Verdict = { verdict: string; diagnostics: Array<{ code: string; severity: string }> };

  /** Senior claude-a edits the symbol; junior codex-b then submits the same edit. */
  function overlap(enforcement?: "advise" | "block") {
    const clock = scenarioClock("2026-10-05T14:00:00.000Z");
    const sql = nodeSql();
    SqlCoordinator.init(sql, enforcement ? { repo: "demo", enforcement } : { repo: "demo" });
    const j = new JournaledCoordinator(sql, clock.now);
    const a = j.call<{ session: string }>("hello", helloA);
    const b = j.call<{ session: string }>("hello", helloB);
    j.call("submit", a.session, edit);
    return j.call<Verdict>("submit", b.session, edit);
  }

  it("defaults to advise: claim_wait warning, edit accepted", () => {
    const r = overlap();
    expect(r.verdict).toBe("accept");
    expect(r.diagnostics).toMatchObject([{ code: "claim_wait", severity: "warning" }]);
    expect(overlap("advise").diagnostics).toMatchObject([{ code: "claim_wait", severity: "warning" }]);
  });
  it("block: claim_wait error, edit rejected", () => {
    const r = overlap("block");
    expect(r.verdict).toBe("reject");
    expect(r.diagnostics).toMatchObject([{ code: "claim_wait", severity: "error" }]);
  });
  it("absent enforcement is not written to the config and reads as advise", () => {
    const sql = nodeSql();
    SqlCoordinator.init(sql, { repo: "demo" });
    const c = new SqlCoordinator(sql);
    expect(c.config).not.toHaveProperty("enforcement");
    expect(c.enforcement).toBe("advise");
  });
  it("a block repo replays to identical results from its journaled config", () => {
    const clock = scenarioClock("2026-10-05T14:00:00.000Z");
    const init: CoordinatorInit = { repo: "demo", enforcement: "block" };
    const sql = nodeSql();
    SqlCoordinator.init(sql, init);
    const j = new JournaledCoordinator(sql, clock.now);
    const a = j.call<{ session: string }>("hello", helloA);
    const b = j.call<{ session: string }>("hello", helloB);
    j.call("submit", a.session, edit);
    const live = j.call<Verdict>("submit", b.session, edit);
    expect(live.verdict).toBe("reject");
    const entries = j.journal();
    // Only the journal and its config are needed: no mode is passed to replay.
    const re = replay(nodeSql(), init, entries);
    expect(re.coord.enforcement).toBe("block");
    expect(JSON.stringify(re.coord.dump())).toBe(JSON.stringify(j.coord.dump()));
    expect(re.results.at(-1)).toMatchObject({ verdict: "reject" });
    const again = replay(nodeSql(), init, entries);
    expect(again.results).toEqual(re.results);
  });
});

describe("claim lease: a claim expires and stops blocking", () => {
  const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
  const key = "src/auth/session.ts#refreshToken";
  // Soft claims are leases (spec §7.5): their lifetime is claims.lease_ms; claim_ttl_ms does not apply to them.
  const claims = { lease_ms: 1_000, firm_max_ms: 600_000 };
  it("a claim expires after claims.lease_ms and then stops blocking (the holder sends nothing)", () => {
    const clock = scenarioClock("2026-10-05T14:00:00.000Z");
    const sql = nodeSql();
    // Short lease keeps the test fast; the session TTL is long so only the claim expires.
    SqlCoordinator.init(sql, { repo: "demo", enforcement: "block", claims, session_ttl_ms: 60_000 });
    const j = new JournaledCoordinator(sql, clock.now);
    const a = j.call<{ session: string }>("hello", { type: "hello", protocol: "wcp/0.1", agent: { id: "claude-a", harness: "claude-code" }, capabilities: caps, task: { id: "T-1" }, change: "I-a" });
    const b = j.call<{ session: string }>("hello", { type: "hello", protocol: "wcp/0.1", agent: { id: "codex-b", harness: "codex" }, capabilities: caps, task: { id: "T-2" }, change: "I-b" });
    const edit = { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key, kind: "body" }] } };
    j.call("submit", a.session, edit);

    // The senior's claim is live: the junior is denied.
    const denied = j.call<{ verdict: string; diagnostics: Array<{ code: string; severity: string }> }>("submit", b.session, edit);
    expect(denied.verdict).toBe("reject");
    expect(denied.diagnostics).toMatchObject([{ code: "claim_wait", severity: "error" }]);

    // The senior goes silent (no heartbeat, no events) for longer than the lease. A heartbeat renews the
    // lease; see the next test.
    clock.advance(500);
    expect(j.call<{ verdict: string }>("submit", b.session, edit).verdict).toBe("reject");
    clock.advance(4_500);
    j.call("tick");
    const accepted = j.call<{ verdict: string; diagnostics: Array<{ code: string }> }>("submit", b.session, edit);
    expect(accepted.verdict).toBe("accept");
    expect(accepted.diagnostics.map((d) => d.code)).not.toContain("claim_wait");
  });

  it("a heartbeating holder keeps its claim alive past claims.lease_ms and still blocks", () => {
    const clock = scenarioClock("2026-10-05T14:00:00.000Z");
    const sql = nodeSql();
    SqlCoordinator.init(sql, { repo: "demo", enforcement: "block", claims, session_ttl_ms: 60_000 });
    const j = new JournaledCoordinator(sql, clock.now);
    const a = j.call<{ session: string }>("hello", { type: "hello", protocol: "wcp/0.1", agent: { id: "claude-a", harness: "claude-code" }, capabilities: caps, task: { id: "T-1" }, change: "I-a" });
    const b = j.call<{ session: string }>("hello", { type: "hello", protocol: "wcp/0.1", agent: { id: "codex-b", harness: "codex" }, capabilities: caps, task: { id: "T-2" }, change: "I-b" });
    const edit = { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, writes: [{ key, kind: "body" }] } };
    j.call("submit", a.session, edit);
    // 3.2s elapsed, over three times the lease, but each heartbeat renews the lease before it lapses.
    for (let i = 0; i < 4; i++) {
      clock.advance(800);
      j.call("heartbeat", a.session);
    }
    j.call("tick");
    const denied = j.call<{ verdict: string; diagnostics: Array<{ code: string; severity: string }> }>("submit", b.session, edit);
    expect(denied.verdict).toBe("reject");
    expect(denied.diagnostics).toMatchObject([{ code: "claim_wait", severity: "error" }]);
  });
});

describe("block mode: own claims, claim submissions, and wait-die (per repo)", () => {
  const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;
  const key = "src/auth/session.ts#refreshToken";
  const helloOf = (agent: string, harness: string, task: string, change: string) => ({
    type: "hello",
    protocol: "wcp/0.1",
    agent: { id: agent, harness },
    capabilities: caps,
    task: { id: task },
    change,
  });
  const message = (event: object) => ({ type: "submit", mode: "commit", event });
  const edit = message({ kind: "edit", base_seq: 1, writes: [{ key, kind: "body" }] });
  const claim = (firm = false) => message({ kind: "claim", base_seq: 1, writes: [{ key, kind: "body" }], payload: { firm, source: "explicit" } });
  type Verdict = { verdict: string; diagnostics: Array<{ code: string; severity: string }> };

  function fresh(init: CoordinatorInit) {
    const clock = scenarioClock("2026-10-05T14:00:00.000Z");
    const sql = nodeSql();
    SqlCoordinator.init(sql, init);
    return new JournaledCoordinator(sql, clock.now);
  }

  it("block: an agent's own claim on another task does not deny its edit; advise still warns", () => {
    const run = (enforcement?: "advise" | "block") => {
      const j = fresh(enforcement ? { repo: "demo", enforcement } : { repo: "demo" });
      const t1 = j.call<{ session: string }>("hello", helloOf("claude-a", "claude-code", "T-1", "I-a"));
      const t2 = j.call<{ session: string }>("hello", helloOf("claude-a", "claude-code", "T-2", "I-b"));
      j.call("submit", t1.session, edit);
      return j.call<Verdict>("submit", t2.session, edit);
    };
    expect(run("block")).toMatchObject({ verdict: "accept", diagnostics: [] });
    expect(run()).toMatchObject({ verdict: "accept", diagnostics: [{ code: "claim_wait", severity: "warning" }] });
  });

  it("block: a claim is never refused by enforcement; a junior's soft claim over a senior's is a warning, and its edit is denied", () => {
    const j = fresh({ repo: "demo", enforcement: "block" });
    const senior = j.call<{ session: string }>("hello", helloOf("claude-a", "claude-code", "T-1", "I-a"));
    const junior = j.call<{ session: string }>("hello", helloOf("codex-b", "codex", "T-2", "I-b"));
    j.call("submit", senior.session, claim());
    expect(j.call<Verdict>("submit", junior.session, claim())).toMatchObject({ verdict: "accept", diagnostics: [{ code: "claim_wait", severity: "warning" }] });
    expect(j.call<Verdict>("submit", junior.session, edit)).toMatchObject({ verdict: "reject", diagnostics: [{ code: "claim_wait", severity: "error" }] });
  });

  // Wait-die, block: the senior's edit is denied by a junior's claim. Pinned on purpose. This is part of the
  // lease discussion; do not change it without revisiting the lease design.
  it("wait-die + block: the senior's edit is denied by a junior's claim (wait, not die)", () => {
    const j = fresh({ repo: "demo", policy: "wait-die", enforcement: "block" });
    const senior = j.call<{ session: string }>("hello", helloOf("claude-a", "claude-code", "T-1", "I-a"));
    const junior = j.call<{ session: string }>("hello", helloOf("codex-b", "codex", "T-2", "I-b"));
    // The senior's first accepted event sets its birth before the junior's, making it the senior.
    j.call("submit", senior.session, message({ kind: "edit", base_seq: 1, writes: [{ key: "src/other.ts#x", kind: "body" }] }));
    j.call("submit", junior.session, claim());
    expect(j.call<Verdict>("submit", senior.session, edit)).toMatchObject({ verdict: "reject", diagnostics: [{ code: "claim_wait", severity: "error" }] });
  });
});
