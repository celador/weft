// Node test harness for the workflows: real git + Mergiraf (weft-job.mjs), the git-backed
// Artifacts fake, D1 = node:sqlite with the gateway's migrations, the repo coordinator =
// a journaled SqlCoordinator (what the RepoCoordinator DO runs), and a fake durable step.

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitArtifacts } from "@weft/artifacts/git";
import { newChangeId, forkName } from "@weft/artifacts";
import { SqlCoordinator } from "@weft/sequencer/coordinator";
import { JournaledCoordinator } from "@weft/sequencer/journal";
import { nodeSql } from "@weft/sequencer/node-sqlite";
import { validate, type EventDraft, type EventRecord, type Hello } from "@weft/protocol";
import { runJob as runWeftJob } from "../../sandbox/image/weft-job.mjs";
import { bestOfN, landChange, processRevision, revertOperation } from "../src/core/workflows";
import type { CoordinatorClient, D1Like, D1Stmt, Deps, Duration, JobRequest, JobResult, JobRunner, LandChangeParams, OpRow, QueueEntry, RepoConfig, StepConfig, StepLike } from "../src/core/types";

const here = dirname(fileURLToPath(import.meta.url));
const ID = { GIT_AUTHOR_NAME: "agent", GIT_AUTHOR_EMAIL: "agent@t", GIT_COMMITTER_NAME: "agent", GIT_COMMITTER_EMAIL: "agent@t" };
export const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...ID }, encoding: "utf8" }).trim();

// ------------------------------------------------------------------ fake durable step

export class FakeStep implements StepLike {
  readonly cache = new Map<string, unknown>();
  readonly ran: string[] = [];
  readonly sleeps: string[] = [];
  readonly waits: string[] = [];
  readonly events: Array<{ type: string; payload: unknown }> = [];
  onSleep?: (name: string) => Promise<void> | void;
  onWait?: (name: string, type: string) => Promise<{ type: string; payload: unknown } | undefined> | { type: string; payload: unknown } | undefined;

  async do<T>(name: string, a: StepConfig | (() => Promise<T>), b?: () => Promise<T>): Promise<T> {
    const fn = typeof a === "function" ? a : b!;
    if (this.cache.has(name)) return this.cache.get(name) as T;
    if (this.ran.includes(name)) throw new Error(`duplicate step name ${name}`);
    this.ran.push(name);
    const v = await fn();
    // Workflows persist step output as JSON: anything non-serializable would break replay.
    const out = v === undefined ? (undefined as T) : (JSON.parse(JSON.stringify(v)) as T);
    this.cache.set(name, out);
    return out;
  }
  async sleep(name: string, _d: Duration): Promise<void> {
    this.sleeps.push(name);
    await this.onSleep?.(name);
  }
  async waitForEvent<T>(name: string, o: { type: string; timeout?: Duration }): Promise<{ payload: T; type: string; timestamp: Date }> {
    if (this.cache.has(`event:${name}`)) return this.cache.get(`event:${name}`) as { payload: T; type: string; timestamp: Date };
    this.waits.push(name);
    let i = this.events.findIndex((e) => e.type === o.type);
    if (i < 0 && this.onWait) {
      const e = await this.onWait(name, o.type);
      if (e) this.events.push(e);
      i = this.events.findIndex((e) => e.type === o.type);
    }
    if (i < 0) throw new Error(`waitForEvent ${name}: timed out`);
    const [e] = this.events.splice(i, 1);
    const out = { payload: e!.payload as T, type: e!.type, timestamp: new Date(0) };
    this.cache.set(`event:${name}`, out);
    return out;
  }
}

// ------------------------------------------------------------------ D1 over node:sqlite

export function d1(db: DatabaseSync): D1Like {
  return {
    prepare(sql: string): D1Stmt {
      let args: unknown[] = [];
      const norm = () => args.map((v) => (v === undefined ? null : v)) as never[];
      const stmt: D1Stmt = {
        bind(...v: unknown[]) {
          args = v;
          return stmt;
        },
        async first<T>() {
          const r = db.prepare(sql).get(...norm());
          return (r ? { ...(r as object) } : null) as T | null;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...norm()).map((r) => ({ ...(r as object) })) as T[] };
        },
        async run() {
          const r = db.prepare(sql).run(...norm());
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  };
}

// ------------------------------------------------------------------ coordinator client

export class LocalCoord implements CoordinatorClient {
  constructor(readonly j: JournaledCoordinator) {}
  async headSeq() {
    return this.j.coord.summary().head_seq;
  }
  async system(d: EventDraft) {
    // The gateway validates every system draft against the WCP schema (spec §9.1); so do the tests.
    const v = validate("EventDraft", d);
    if (!v.ok) throw new Error(`invalid EventDraft: ${JSON.stringify(v.issues)}`);
    return this.j.call<EventRecord>("system", d, { type: "system", id: "workflows" });
  }
  async enqueue(change: string, by: string, note?: string) {
    return this.j.call<QueueEntry>("enqueue", change, by, note);
  }
  async setQueueStatus(id: number, status: QueueEntry["status"], note?: string) {
    return this.j.call<QueueEntry>("queue_status", id, status, note);
  }
  async queue(statuses?: string[]) {
    return this.j.coord.queue(statuses) as QueueEntry[];
  }
  async claimBatch(leader: number, ids: number[], note?: string) {
    return this.j.call<QueueEntry[]>("queue_claim", leader, ids, note);
  }
  async ops() {
    return this.j.coord.ops() as unknown as OpRow[];
  }
}

// ------------------------------------------------------------------ job runner (weft-job.mjs in-process)

export class LocalJobs implements JobRunner {
  readonly started: Array<{ run: string; req: JobRequest }> = [];
  private readonly results = new Map<string, { result: JobResult; polls: number }>();
  /** Hook to mutate the world while a job "runs" (e.g. a concurrent landing). */
  beforeJob?: (req: JobRequest) => Promise<void>;
  async start(run: string, req: JobRequest) {
    if (this.results.has(run)) return { run }; // idempotent restart
    this.started.push({ run, req });
    await this.beforeJob?.(req);
    const result = (await runWeftJob(req.spec, { log: () => {} })) as JobResult;
    this.results.set(run, { result: { ...result, run: { id: run, state: "succeeded" } }, polls: 0 });
    return { run };
  }
  async poll(run: string) {
    const r = this.results.get(run);
    if (!r) return { done: false, state: "unknown" };
    // First poll says "running" so the sleep/poll loop is exercised.
    if (r.polls++ === 0) return { done: false, state: "running" };
    return { done: true, state: "succeeded", result: r.result };
  }
}

// ------------------------------------------------------------------ world

const CAPS = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;

export const BASE: Record<string, string> = {
  "src/pricing.ts": "export const PRICES = {\n  apple: 1,\n  pear: 2,\n};\n\nexport function calcTotal(items: string[]): number {\n  return items.reduce((s, i) => s + (PRICES as Record<string, number>)[i]!, 0);\n}\n",
  "src/cart.ts": "export const cart: string[] = [];\n",
  "test/pricing.test.ts": "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { calcTotal } from '../src/pricing.ts';\ntest('total', () => assert.strictEqual(calcTotal(['apple', 'pear']) > 0, true));\n",
};
export const DEFAULT_CONFIG: RepoConfig = { tests: { command: ["node", "--test"], timeout_s: 120 } };

export type Cand = { change: string; fork: string; remote: string; session: string; agent: string; task: string; push(files: Record<string, string>, msg: string): Promise<string> };

export async function world(opts: { config?: RepoConfig; repo?: string } = {}) {
  const repo = opts.repo ?? "weft-demo";
  const art = await GitArtifacts.create();
  await art.create(repo);
  const seed = await mkdtemp(join(tmpdir(), "weft-seed-"));
  g(seed, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(BASE)) {
    await mkdir(dirname(join(seed, f)), { recursive: true });
    await writeFile(join(seed, f), c);
  }
  g(seed, "add", ".");
  g(seed, "commit", "-qm", "base");
  g(seed, "push", "-q", art.remote(repo), "HEAD:main");

  // D1 with the gateway's migrations.
  const db = new DatabaseSync(":memory:");
  const migDir = join(here, "../../gateway/migrations");
  for (const f of (await readdir(migDir)).filter((x) => x.endsWith(".sql")).sort()) db.exec(await readFile(join(migDir, f), "utf8"));
  let clock = Date.parse("2026-10-04T12:00:00Z");
  const now = () => (clock += 1000);
  db.prepare(`INSERT INTO artifacts_repos (repo, namespace, trunk, default_branch, remote, created_at, config) VALUES (?, 'weft-test', ?, 'main', ?, ?, ?)`).run(repo, repo, art.remote(repo), now(), JSON.stringify(opts.config ?? DEFAULT_CONFIG));

  // The repo coordinator (journaled SqlCoordinator, as in the DO).
  const sql = nodeSql();
  SqlCoordinator.init(sql, { repo });
  const j = new JournaledCoordinator(sql, now);
  const coord = new LocalCoord(j);

  const jobs = new LocalJobs();
  const landed: LandChangeParams[] = [];
  const signals: Array<{ repo: string; task: string; payload: unknown }> = [];
  const deps: Deps = {
    db: d1(db),
    coord: () => coord,
    jobs,
    now,
    jobPoll: { interval: "1 second", max: 5 },
    queuePoll: { interval: "1 second", max: 5 },
    launch: {
      async land(p) {
        landed.push(p);
        return `land-${p.change.slice(0, 8)}`;
      },
      async candidateReady(repo, task, payload) {
        signals.push({ repo, task, payload });
      },
    },
  };

  const counters = new Map<string, number>();
  async function candidate(task: string, agent: string, opts2: { title?: string; risk?: string } = {}): Promise<Cand> {
    const n = (counters.get(task) ?? 0) + 1;
    counters.set(task, n);
    db.prepare(`INSERT INTO tasks (repo, id, title, status, candidates, created_at, updated_at, risk) VALUES (?, ?, ?, 'open', ?, ?, ?, ?) ON CONFLICT (repo, id) DO UPDATE SET candidates = excluded.candidates`).run(repo, task, opts2.title ?? `task ${task}`, n, now(), now(), opts2.risk ?? "low");
    const name = forkName(repo, task, n);
    await (await art.get(repo)).fork(name, { defaultBranchOnly: true });
    const change = newChangeId();
    db.prepare(`INSERT INTO changes (id, repo, task, n, agent, namespace, fork, remote, default_branch, status, subscription_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'weft-test', ?, ?, 'main', 'open', 'active', ?, ?)`).run(change, repo, task, n, agent, name, art.remote(name), now(), now());
    const hello: Hello = { type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: CAPS, task: { id: task, priority: 0 }, change } as Hello;
    const s = j.call<{ session: string }>("hello", hello);
    const remote = art.remote(name);
    return {
      change,
      fork: name,
      remote,
      session: s.session,
      agent,
      task,
      async push(files, msg) {
        const d = await mkdtemp(join(tmpdir(), "weft-wc-"));
        g(d, "clone", "-q", remote, ".");
        for (const [f, c] of Object.entries(files)) {
          await mkdir(dirname(join(d, f)), { recursive: true });
          await writeFile(join(d, f), c);
        }
        g(d, "add", ".");
        g(d, "commit", "-qm", `${msg}\n\nChange-Id: ${change}\nTask-Id: ${task}\nAgent-Id: ${agent}`);
        g(d, "push", "-q", "origin", "HEAD:main");
        const sha = g(d, "rev-parse", "HEAD");
        // What the gateway's queue consumer does for an Artifacts `pushed` event (B6).
        const rec = j.call<EventRecord>("system", { kind: "checkpoint", base_seq: j.coord.summary().head_seq, change, task, payload: { sha, ref: "refs/heads/main" } }, { type: "system", id: "artifacts" });
        db.prepare(`INSERT INTO revisions (change_id, sha, ref, before_sha, commits, subject, status, seq, received_at) VALUES (?, ?, 'refs/heads/main', '', 1, ?, 'queued', ?, ?)`).run(change, sha, msg, rec.seq, now());
        db.prepare(`UPDATE changes SET head_sha = ?, updated_at = ? WHERE id = ?`).run(sha, now(), change);
        return sha;
      },
    };
  }

  /** Commit straight to trunk (someone else's landing). */
  async function trunkCommit(files: Record<string, string>, msg: string) {
    const d = await mkdtemp(join(tmpdir(), "weft-tr-"));
    g(d, "clone", "-q", art.remote(repo), ".");
    for (const [f, c] of Object.entries(files)) {
      await mkdir(dirname(join(d, f)), { recursive: true });
      await writeFile(join(d, f), c);
    }
    g(d, "add", ".");
    g(d, "commit", "-qm", msg);
    g(d, "push", "-q", "origin", "HEAD:main");
    return g(d, "rev-parse", "HEAD");
  }
  const tip = (remote = art.remote(repo), ref = "refs/heads/main") => execFileSync("git", ["ls-remote", remote, ref], { encoding: "utf8" }).split("\t")[0]!.trim();
  async function show(sha: string, file: string, remote = art.remote(repo)) {
    const d = await mkdtemp(join(tmpdir(), "weft-show-"));
    g(d, "init", "-q");
    g(d, "fetch", "-q", remote, sha);
    try {
      return g(d, "show", `${sha}:${file}`);
    } catch {
      return null;
    }
  }
  const q = <T = Record<string, unknown>>(s: string, ...a: unknown[]) => db.prepare(s).all(...(a as never[])).map((r) => ({ ...(r as object) })) as T[];

  const wf = {
    process: (c: Cand, sha: string, step = new FakeStep()) => processRevision({ repo, change: c.change, sha }, step, deps, `rev-${sha.slice(0, 8)}`),
    land: (c: Cand, step = new FakeStep()) => landChange({ repo, change: c.change, requested_by: "human:john" }, step, deps, `land-${c.change.slice(0, 8)}`),
  };
  return { repo, art, db, sql, q, j, coord, jobs, deps, landed, signals, candidate, trunkCommit, tip, show, wf, revertOperation, bestOfN };
}

export const sub = (s: string, from: string, to: string) => {
  if (!s.includes(from)) throw new Error(`no ${from}`);
  return s.replace(from, to);
};
