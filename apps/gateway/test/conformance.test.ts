// WCP conformance (spec §12) through the real stack: HTTP gateway → auth → RepoCoordinator
// Durable Object (SQLite). Every scenario must pass its expectations AND produce exactly the
// reference coordinator's output at every step. Then the DO's input journal is replayed into
// a fresh DO and must reproduce the log and all state (replay determinism, spec §5.1).

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ReferenceCoordinator,
  runScenario,
  scenarioClock,
  scenarioInit,
  type ConformanceTarget,
  type EventPage,
  type EventRecord,
  type Scenario,
  type Welcome,
} from "@weft/protocol";
import type { JournalEntry, RepoCoordinator, Result } from "@weft/sequencer";
import { ADMIN, agentToken, createRepo, humanToken, observerToken, systemToken, uniqueRepo, wcp } from "./helpers";

const files = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, unknown> }).glob("../../../packages/protocol/fixtures/scenarios/*.json", { eager: true, import: "default" }) as Record<string, Scenario>;
const scenarios = Object.entries(files)
  .map(([p, data]) => ({ name: p.split("/").pop()!.replace(/\.json$/, ""), data }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Rename the scenario's repo (storage is shared across tests) everywhere it appears. */
function renamed(sc: Scenario, repo: string): Scenario {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "repo" && x === sc.repo ? repo : walk(x)]));
    return v;
  };
  return walk(sc) as Scenario;
}

const stubOf = (repo: string) => env.WEFT_REPO.get(env.WEFT_REPO.idFromName(repo));
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function httpTarget(repo: string): Promise<ConformanceTarget> {
  const agents = new Map<string, string>(); // agent id → token
  const sessions = new Map<string, string>(); // session → token
  const humans = new Map<string, string>();
  const systems = new Map<string, string>();
  const observer = await observerToken([repo]);
  const agentTok = async (id: string) => agents.get(id) ?? (agents.set(id, await agentToken(repo, id)), agents.get(id)!);
  const base = `/v1/repos/${repo}`;
  const tokOf = (sid: string) => sessions.get(sid) ?? agents.values().next().value!;
  return {
    async hello(h) {
      const t = await agentTok(h.agent.id);
      const w = await wcp<Welcome>("POST", `${base}/sessions`, t, h);
      sessions.set(w.session, t);
      return w;
    },
    submit: (s, m) => wcp("POST", `${base}/sessions/${s}/events`, tokOf(s), m),
    drain: (s, ack) => wcp("POST", `${base}/sessions/${s}/inbox`, tokOf(s), { type: "inbox.drain", ...(ack !== undefined ? { ack } : {}) }),
    gate: (s, g) => wcp("POST", `${base}/sessions/${s}/gate`, tokOf(s), g),
    heartbeat: (s) => wcp("POST", `${base}/sessions/${s}/heartbeat`, tokOf(s), { type: "heartbeat" }),
    bye: (s, reason) => wcp("DELETE", `${base}/sessions/${s}`, tokOf(s), { type: "bye", ...(reason ? { reason } : {}) }),
    async action(human, a) {
      const t = humans.get(human) ?? (humans.set(human, await humanToken([repo], human)), humans.get(human)!);
      return wcp("POST", `${base}/actions`, t, a);
    },
    async system(draft, actor) {
      const who = actor?.id ?? "coordinator";
      const t = systems.get(who) ?? (systems.set(who, await systemToken([repo], who)), systems.get(who)!);
      return wcp("POST", `${base}/system/events`, t, draft);
    },
    tick: async () => unwrap(await stubOf(repo).tick()),
    events: (after, limit, o = {}) => {
      const q = new URLSearchParams();
      if (after !== undefined) q.set("after", String(after));
      if (limit !== undefined) q.set("limit", String(limit));
      if (o.include_diff) q.set("include", "diff");
      if (o.tail) q.set("tail", "1");
      if (o.before !== undefined) q.set("before", String(o.before));
      return wcp<EventPage>("GET", `${base}/events?${q}`, observer);
    },
    event: (seq) => wcp<EventRecord>("GET", `${base}/events/${seq}`, observer),
    policy: (p) => wcp("POST", `/v1/admin/repos/${repo}/policy`, ADMIN, p),
  };
}

async function runViaGateway(sc0: Scenario) {
  const repo = uniqueRepo(sc0.name);
  const sc = renamed(sc0, repo);
  const { repo: _r, ...init } = scenarioInit(sc);
  await createRepo(repo, init);
  const clock = scenarioClock(sc.start);
  await runInDurableObject(stubOf(repo), (inst: RepoCoordinator) => inst.setClock(clock.now));
  const results = await runScenario(sc, await httpTarget(repo), clock);
  const refClock = scenarioClock(sc.start);
  const ref = new ReferenceCoordinator({ ...scenarioInit(sc), now: refClock.now });
  const refResults = await runScenario(sc, ref, refClock);
  return { repo, sc, results, refResults, ref };
}

describe("WCP conformance through gateway + RepoCoordinator DO", () => {
  it("found every scenario fixture", () => expect(scenarios.length).toBeGreaterThanOrEqual(11));

  it.each(scenarios)("$name: passes and matches the reference step by step", async ({ data }) => {
    const { repo, results, refResults, ref } = await runViaGateway(data);
    const failed = results.filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(results.map((r) => r.actual)).toEqual(refResults.map((r) => r.actual));
    // The stored log equals the reference log record for record.
    const log = (unwrap((await stubOf(repo).events({ limit: 500, include_diff: true })) as unknown as Result<EventPage>)).events;
    expect(log).toEqual(ref.log);
  });

  it.each(scenarios)("$name: journal replay into a fresh Durable Object reproduces the log and all state", async ({ data }) => {
    const { repo, sc } = await runViaGateway(data);
    const live = stubOf(repo);
    const journal = unwrap(await live.journal()) as JournalEntry[];
    expect(journal.length).toBeGreaterThan(0);
    const replica = stubOf(`${repo}-replay`);
    const init = scenarioInit(sc);
    unwrap(await replica.init(init));
    await runInDurableObject(replica, async (inst: RepoCoordinator) => {
      let t = 0;
      inst.setClock(() => t);
      for (const e of journal) {
        t = e.at;
        await inst.op(e.op, e.args as unknown[]);
      }
    });
    const a = unwrap(await live.dump());
    const b = unwrap(await replica.dump());
    // The replica's journal is its own; everything else must be identical.
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
