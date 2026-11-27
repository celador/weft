// Artifacts integration (B6): candidate forks, repo-scoped tokens, Change-Ids, and the
// Artifacts `pushed` event consumer that turns pushes into WCP `checkpoint` events.
//
//   POST /v1/repos/{repo}/tasks/{task}/candidates   system  fork trunk -> weft-<repo>-<task>-<n>,
//                                                           mint write token, register Change-Id,
//                                                           subscribe the fork's pushes to the queue
//   GET  /v1/repos/{repo}/tasks/{task}/candidates   observe list candidates (no tokens)
//   GET  /v1/repos/{repo}/tasks                     observe board: tasks + candidates + evidence tally
//   GET  /v1/repos/{repo}/changes/{change}          observe change + revisions + evidence
//   POST /v1/repos/{repo}/changes/{change}/token    system  re-mint a fork token
//   DELETE /v1/repos/{repo}/changes/{change}        system  abandon: unsubscribe + delete fork, and tell the
//                                                           coordinator (releases dependency holds, WCP §6.7)
//   POST /v1/repos/{repo}/system/trunk-token        system  short-lived trunk token (landing, B8)
//   POST /v1/admin/artifacts/repos                  admin   bind (or create) a repo's Artifacts trunk
//   GET|POST /v1/admin/artifacts/subscriptions      admin   pending subscriptions (operator reconcile)
//
// Queue `weft-artifacts-events` <- per-fork Queues event subscriptions (`pushed`).

import { decodeEnvelope, forkName, newChangeId, parsePush, parseTrailers, withRepo, artifactsErrorCode, CloudflareEventSubscriber, type ArtifactsLike, type EventSubscriber, type Push, type TokenScope } from "@weft/artifacts";
import type { EventDraft, EventRecord } from "@weft/protocol";
import type { Grant, RepoCoordinator, Result } from "@weft/sequencer";
import { ids } from "@weft/workflows/ids";

export interface ArtifactsEnv {
  WEFT_REPO: DurableObjectNamespace<RepoCoordinator>;
  WEFT_DB?: D1Database;
  /** Artifacts binding (namespace = WEFT_ARTIFACTS_NAMESPACE). Tests inject a fake. */
  ARTIFACTS?: ArtifactsLike;
  WEFT_ARTIFACTS_NAMESPACE?: string;
  /** For per-fork event subscriptions (Cloudflare API). */
  WEFT_CF_ACCOUNT_ID?: string;
  WEFT_EVENTS_QUEUE_ID?: string;
  /** Secret: Cloudflare API token with Queues edit (event subscriptions). Absent => subscriptions stay `pending`. */
  WEFT_CF_API_TOKEN?: string;
  /** Test hook: injected subscriber. */
  WEFT_EVENT_SUBSCRIBER?: EventSubscriber;
  /** B8 workflows (script weft-workflows[-preview]). Absent => revisions stay `queued`. */
  WEFT_PROCESS_REVISION?: WorkflowLike;
  WEFT_LAND_CHANGE?: WorkflowLike;
  WEFT_REVERT_OPERATION?: WorkflowLike;
  WEFT_BEST_OF_N?: WorkflowLike;
}

/** Structural view of a Workflow binding (tests inject a fake). */
export interface WorkflowLike {
  create(o: { id?: string; params?: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string; sendEvent(e: { type: string; payload: unknown }): Promise<void>; status(): Promise<{ status: string }> }>;
}

/** Helpers owned by index.ts (auth, errors, JSON). */
export interface Kit {
  fail(code: "invalid_message" | "not_found" | "forbidden" | "repo_not_found" | "invalid_reference" | "unavailable" | "internal", message: string, details?: Record<string, unknown>): never;
  json(body: unknown, status?: number): Response;
  authenticate(req: Request): Promise<Grant>;
  authorize(g: Grant, scope: "agent" | "observe" | "human" | "system", repo?: string): void;
  readJson(req: Request, optional?: boolean): Promise<unknown>;
}

const DEFAULT_TOKEN_TTL = 3600;
const MAX_CANDIDATES = 10;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

type ChangeRow = {
  id: string;
  repo: string;
  task: string;
  n: number;
  agent: string | null;
  namespace: string;
  fork: string;
  remote: string;
  default_branch: string;
  base_sha: string | null;
  head_sha: string | null;
  status: string;
  subscription_id: string | null;
  subscription_status: string;
  subscription_error: string | null;
  created_at: number;
  updated_at: number;
};
type TrunkRow = { repo: string; namespace: string; trunk: string; default_branch: string; remote: string; created_at: number };

function db(env: ArtifactsEnv, k: Kit): D1Database {
  if (!env.WEFT_DB) k.fail("internal", "D1 binding WEFT_DB is not configured");
  return env.WEFT_DB!;
}
function artifacts(env: ArtifactsEnv, k: Kit): ArtifactsLike {
  if (!env.ARTIFACTS) k.fail("internal", "Artifacts binding ARTIFACTS is not configured");
  return env.ARTIFACTS!;
}
const ns = (env: ArtifactsEnv) => env.WEFT_ARTIFACTS_NAMESPACE ?? "weft";

export function subscriber(env: ArtifactsEnv): EventSubscriber | null {
  if (env.WEFT_EVENT_SUBSCRIBER) return env.WEFT_EVENT_SUBSCRIBER;
  if (env.WEFT_CF_API_TOKEN && env.WEFT_CF_ACCOUNT_ID && env.WEFT_EVENTS_QUEUE_ID)
    return new CloudflareEventSubscriber({ accountId: env.WEFT_CF_ACCOUNT_ID, apiToken: env.WEFT_CF_API_TOKEN, queueId: env.WEFT_EVENTS_QUEUE_ID });
  return null;
}

async function trunkOf(env: ArtifactsEnv, k: Kit, repo: string): Promise<TrunkRow> {
  const t = await db(env, k).prepare(`SELECT * FROM artifacts_repos WHERE repo = ?`).bind(repo).first<TrunkRow>();
  if (!t) k.fail("not_found", `repo ${repo} has no Artifacts trunk (POST /v1/admin/artifacts/repos)`);
  return t!;
}

function publicChange(c: ChangeRow) {
  return {
    change: c.id,
    repo: c.repo,
    task: c.task,
    n: c.n,
    ...(c.agent ? { agent: c.agent } : {}),
    status: c.status,
    fork: { namespace: c.namespace, name: c.fork, remote: c.remote, default_branch: c.default_branch },
    ...(c.base_sha ? { base_sha: c.base_sha } : {}),
    ...(c.head_sha ? { head_sha: c.head_sha } : {}),
    subscription: { status: c.subscription_status, ...(c.subscription_id ? { id: c.subscription_id } : {}), ...(c.subscription_error ? { error: c.subscription_error } : {}) },
    trailers: { "Change-Id": c.id, "Task-Id": c.task, ...(c.agent ? { "Agent-Id": c.agent } : {}) },
    created_at: new Date(c.created_at).toISOString(),
  };
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
function ttlOf(k: Kit, v: unknown, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 60 || v > 86_400) k.fail("invalid_message", "ttl must be an integer 60..86400 seconds", { issues: [{ path: "/ttl", message: "60..86400" }] });
  return v as number;
}

// ---------------------------------------------------------------------------- routes

/** Returns a Response if the path belongs to this module, else null. */
export async function artifactsRoute(req: Request, env: ArtifactsEnv, k: Kit, repo: string, rest: string): Promise<Response | null> {
  const m = req.method;
  const sm = /^\/tasks\/([^/]+)\/select$/.exec(rest);
  if (sm && m === "POST") {
    const task = decodeURIComponent(sm[1]!);
    if (!TASK_ID.test(task)) k.fail("invalid_message", "bad task id", { issues: [{ path: "/task", message: TASK_ID.source }] });
    const g = await k.authenticate(req);
    authorizeAny(k, g, repo);
    return selectBest(req, env, k, repo, task, g);
  }
  if (rest === "/tasks" && m === "GET") {
    const g = await k.authenticate(req);
    k.authorize(g, "observe", repo);
    return k.json({ type: "tasks", repo, tasks: await listTasks(db(env, k), repo) });
  }
  const tm = /^\/tasks\/([^/]+)\/candidates$/.exec(rest);
  if (tm) {
    const task = decodeURIComponent(tm[1]!);
    if (!TASK_ID.test(task)) k.fail("invalid_message", "bad task id", { issues: [{ path: "/task", message: TASK_ID.source }] });
    const g = await k.authenticate(req);
    if (m === "POST") {
      k.authorize(g, "system", repo);
      return createCandidates(req, env, k, repo, task);
    }
    if (m === "GET") {
      k.authorize(g, "observe", repo);
      const rows = await db(env, k).prepare(`SELECT * FROM changes WHERE repo = ? AND task = ? ORDER BY n`).bind(repo, task).all<ChangeRow>();
      return k.json({ type: "candidates", repo, task, candidates: rows.results.map(publicChange) });
    }
    return null;
  }
  const cm = /^\/changes\/([^/]+)(\/token|\/land)?$/.exec(rest);
  if (cm) {
    const id = decodeURIComponent(cm[1]!);
    const g = await k.authenticate(req);
    const row = await db(env, k).prepare(`SELECT * FROM changes WHERE id = ? AND repo = ?`).bind(id, repo).first<ChangeRow>();
    if (cm[2] === "/land") {
      if (m !== "POST") return null;
      authorizeAny(k, g, repo);
      if (!row) k.fail("not_found", `change ${id} not found`);
      if (row!.status !== "open") k.fail("invalid_reference", `change ${id} is ${row!.status}`);
      if (!row!.head_sha) k.fail("invalid_reference", `change ${id} has no pushed revision`);
      const wf = workflow(env, k, "WEFT_LAND_CHANGE");
      const body = ((await k.readJson(req, true)) ?? {}) as { note?: unknown };
      const inst = await wf.create({ id: ids.land(id, Date.now()), params: { repo, change: id, requested_by: g.principal, ...(str(body.note, 300) ? { note: str(body.note, 300) } : {}) } });
      return k.json({ type: "landing", change: id, workflow: inst.id }, 202);
    }
    if (cm[2]) {
      if (m !== "POST") return null;
      k.authorize(g, "system", repo);
      if (!row) k.fail("not_found", `change ${id} not found`);
      if (row!.status !== "open") k.fail("invalid_reference", `change ${id} is ${row!.status}`);
      const body = ((await k.readJson(req, true)) ?? {}) as { scope?: unknown; ttl?: unknown };
      const scope: TokenScope = body.scope === "read" ? "read" : "write";
      const ttl = ttlOf(k, body.ttl, DEFAULT_TOKEN_TTL);
      const t = await withRepo(artifacts(env, k), row!.fork, (r) => r.createToken(scope, ttl));
      return k.json({ type: "token", change: id, remote: row!.remote, token: { plaintext: t.plaintext, scope, expires_at: t.expiresAt } }, 201);
    }
    if (m === "GET") {
      k.authorize(g, "observe", repo);
      if (!row) k.fail("not_found", `change ${id} not found`);
      const d = db(env, k);
      const [revs, ev] = await Promise.all([
        d.prepare(`SELECT sha, ref, before_sha, commits, subject, trailer_change_id, seq, status, pushed_at, received_at, onto_sha, rebased_sha, layer, workflow_id, processed_at FROM revisions WHERE change_id = ? ORDER BY received_at, rowid`).bind(id).all(),
        d.prepare(`SELECT id, sha, kind, status, uri, data, created_at FROM evidence WHERE change_id = ? ORDER BY id`).bind(id).all(),
      ]);
      return k.json({ type: "change", ...publicChange(row!), revisions: revs.results, evidence: ev.results });
    }
    if (m === "DELETE") {
      k.authorize(g, "system", repo);
      if (!row) k.fail("not_found", `change ${id} not found`);
      const notes: string[] = [];
      const sub = subscriber(env);
      if (row!.subscription_id && sub) await sub.unsubscribe(row!.subscription_id).catch((e) => notes.push(`unsubscribe: ${(e as Error).message}`));
      const deleted = await artifacts(env, k).delete(row!.fork).catch((e) => (notes.push(`delete fork: ${(e as Error).message}`), false));
      await db(env, k)
        .prepare(`UPDATE changes SET status = 'abandoned', subscription_status = CASE WHEN subscription_id IS NULL THEN subscription_status ELSE 'deleted' END, updated_at = ? WHERE id = ?`)
        .bind(Date.now(), id)
        .run();
      // Tell the coordinator (spec §6.7): a system `release` with reason `abandoned` and no keys gives up the
      // change's claims and releases the landing hold of every change that relies on it (each owner gets a message).
      const abandoned = await abandonInCoordinator(env, row!.repo, id).catch((e) => (notes.push(`coordinator: ${(e as Error).message}`), null));
      return k.json({ type: "change.abandoned", change: id, fork_deleted: deleted, ...(abandoned ? { seq: abandoned } : {}), ...(notes.length ? { notes } : {}) });
    }
    return null;
  }
  if (rest === "/system/revert" && m === "POST") {
    const g = await k.authenticate(req);
    k.authorize(g, "system", repo);
    const body = (await k.readJson(req)) as { op_id?: unknown; seq?: unknown; reason?: unknown; evidence?: unknown };
    const reason = str(body.reason, 500);
    if (!reason || (str(body.op_id, 100) === undefined && typeof body.seq !== "number")) k.fail("invalid_message", "op_id or seq, and reason, required", { issues: [{ path: "", message: "op_id|seq, reason" }] });
    const inst = await startRevert(env, k, { repo, ...(str(body.op_id, 100) ? { op_id: str(body.op_id, 100) } : { seq: body.seq as number }), reason: reason!, requested_by: g.principal, requested_by_type: "system", ...(body.evidence && typeof body.evidence === "object" ? { evidence: body.evidence } : {}) });
    return k.json({ type: "revert", workflow: inst }, 202);
  }
  if (rest === "/system/trunk-token" && m === "POST") {
    const g = await k.authenticate(req);
    k.authorize(g, "system", repo);
    const t = await trunkOf(env, k, repo);
    const body = ((await k.readJson(req, true)) ?? {}) as { scope?: unknown; ttl?: unknown };
    const scope: TokenScope = body.scope === "read" ? "read" : "write";
    const ttl = ttlOf(k, body.ttl, 600);
    const tok = await withRepo(artifacts(env, k), t.trunk, (r) => r.createToken(scope, ttl));
    return k.json({ type: "token", repo, trunk: t.trunk, remote: t.remote, branch: t.default_branch, token: { plaintext: tok.plaintext, scope, expires_at: tok.expiresAt } }, 201);
  }
  return null;
}

function authorizeAny(k: Kit, g: Grant, repo: string) {
  try {
    k.authorize(g, "system", repo);
  } catch {
    k.authorize(g, "human", repo);
  }
}

function workflow(env: ArtifactsEnv, k: Kit, name: "WEFT_PROCESS_REVISION" | "WEFT_LAND_CHANGE" | "WEFT_REVERT_OPERATION" | "WEFT_BEST_OF_N"): WorkflowLike {
  const wf = env[name];
  if (!wf) k.fail("unavailable", `workflow binding ${name} is not configured`);
  return wf!;
}

export async function startRevert(env: ArtifactsEnv, k: Kit, params: { repo: string; op_id?: string; seq?: number; reason: string; requested_by: string; requested_by_type: "human" | "system"; evidence?: unknown }): Promise<string> {
  const inst = await workflow(env, k, "WEFT_REVERT_OPERATION").create({ id: ids.revert(params.repo, params.op_id ?? String(params.seq), Date.now()), params });
  return inst.id;
}

/** Forward a human `approve` to the task's BestOfN (if one is waiting). Returns the instance id or null. */
export async function forwardApproval(env: ArtifactsEnv, repo: string, change: string, by: string): Promise<string | null> {
  if (!env.WEFT_BEST_OF_N || !env.WEFT_DB) return null;
  const row = await env.WEFT_DB.prepare(`SELECT task FROM changes WHERE id = ? AND repo = ?`).bind(change, repo).first<{ task: string }>();
  if (!row) return null;
  try {
    const inst = await env.WEFT_BEST_OF_N.get(ids.bestOfN(repo, row.task));
    await inst.sendEvent({ type: "approve", payload: { repo, task: row.task, change, by } });
    return inst.id;
  } catch {
    return null;
  }
}

async function selectBest(req: Request, env: ArtifactsEnv, k: Kit, repo: string, task: string, _g: Grant): Promise<Response> {
  const body = ((await k.readJson(req, true)) ?? {}) as { n?: unknown; risk?: unknown; collect_timeout_s?: unknown; approval_timeout_s?: unknown; poll_s?: unknown };
  const t = await db(env, k).prepare(`SELECT id, candidates, risk FROM tasks WHERE repo = ? AND id = ?`).bind(repo, task).first<{ id: string; candidates: number; risk: string }>();
  if (!t) k.fail("not_found", `task ${task} not found`);
  const n = body.n === undefined ? t!.candidates : body.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_CANDIDATES) k.fail("invalid_message", `n must be 1..${MAX_CANDIDATES}`, { issues: [{ path: "/n", message: "int" }] });
  const risk = body.risk === undefined ? t!.risk : body.risk;
  if (!["low", "medium", "high"].includes(risk as string)) k.fail("invalid_message", "risk must be low|medium|high", { issues: [{ path: "/risk", message: "enum" }] });
  await db(env, k).prepare(`UPDATE tasks SET risk = ?, updated_at = ? WHERE repo = ? AND id = ?`).bind(risk, Date.now(), repo, task).run();
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  const params = { repo, task, n, risk, ...(num(body.collect_timeout_s) ? { collect_timeout_s: num(body.collect_timeout_s) } : {}), ...(num(body.approval_timeout_s) ? { approval_timeout_s: num(body.approval_timeout_s) } : {}), ...(num(body.poll_s) ? { poll_s: num(body.poll_s) } : {}) };
  let inst;
  try {
    inst = await workflow(env, k, "WEFT_BEST_OF_N").create({ id: ids.bestOfN(repo, task), params });
  } catch (e) {
    k.fail("invalid_reference", `selection for ${task} already exists: ${(e as Error).message.slice(0, 200)}`);
  }
  return k.json({ type: "selection", task, n, risk, workflow: inst!.id }, 202);
}

/**
 * Board view (B9 web UI): every task of the repo with its candidates (no tokens) and an
 * evidence tally per candidate. Newest activity first; capped at 500 tasks.
 */
async function listTasks(d: D1Database, repo: string) {
  const [tasks, changes, evidence] = await Promise.all([
    d.prepare(`SELECT id, title, status, candidates, acceptance, created_at, updated_at FROM tasks WHERE repo = ? ORDER BY updated_at DESC LIMIT 500`).bind(repo).all<{ id: string; title: string | null; status: string; candidates: number; acceptance: string | null; created_at: number; updated_at: number }>(),
    d.prepare(`SELECT id, task, n, agent, status, head_sha, updated_at FROM changes WHERE repo = ? ORDER BY task, n`).bind(repo).all<{ id: string; task: string; n: number; agent: string | null; status: string; head_sha: string | null; updated_at: number }>(),
    d
      .prepare(`SELECT e.change_id AS change_id, e.status AS status, COUNT(*) AS n FROM evidence e JOIN changes c ON c.id = e.change_id WHERE c.repo = ? GROUP BY e.change_id, e.status`)
      .bind(repo)
      .all<{ change_id: string; status: string; n: number }>(),
  ]);
  const tally = new Map<string, Record<string, number>>();
  for (const e of evidence.results) tally.set(e.change_id, { ...(tally.get(e.change_id) ?? {}), [e.status]: e.n });
  const byTask = new Map<string, unknown[]>();
  for (const c of changes.results) {
    const list = byTask.get(c.task) ?? [];
    list.push({ change: c.id, n: c.n, ...(c.agent ? { agent: c.agent } : {}), status: c.status, ...(c.head_sha ? { head_sha: c.head_sha } : {}), evidence: tally.get(c.id) ?? {}, updated_at: new Date(c.updated_at).toISOString() });
    byTask.set(c.task, list);
  }
  return tasks.results.map((t) => ({
    task: t.id,
    ...(t.title ? { title: t.title } : {}),
    ...(t.acceptance ? { acceptance: parseList(t.acceptance) } : {}),
    status: t.status,
    candidate_count: t.candidates,
    candidates: byTask.get(t.id) ?? [],
    created_at: new Date(t.created_at).toISOString(),
    updated_at: new Date(t.updated_at).toISOString(),
  }));
}

function parseList(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function createCandidates(req: Request, env: ArtifactsEnv, k: Kit, repo: string, task: string): Promise<Response> {
  const body = ((await k.readJson(req, true)) ?? {}) as { agent?: unknown; agents?: unknown; title?: unknown; count?: unknown; ttl?: unknown; acceptance?: unknown };
  // B10: acceptance criteria the review agent scores candidates against (array of strings).
  let acceptance: string | null = null;
  if (body.acceptance !== undefined) {
    if (!Array.isArray(body.acceptance) || body.acceptance.length > 20 || !body.acceptance.every((a) => typeof a === "string" && a.trim().length > 0 && a.length <= 500))
      k.fail("invalid_message", "acceptance must be 1..20 non-empty strings (<= 500 chars)", { issues: [{ path: "/acceptance", message: "string[]" }] });
    acceptance = JSON.stringify((body.acceptance as string[]).map((a) => a.trim()));
  }
  const count = body.count === undefined ? 1 : body.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_CANDIDATES)
    k.fail("invalid_message", `count must be 1..${MAX_CANDIDATES}`, { issues: [{ path: "/count", message: `1..${MAX_CANDIDATES}` }] });
  const agents: (string | undefined)[] = Array.isArray(body.agents) ? body.agents.map((a) => str(a, 128)) : Array.from({ length: count as number }, () => str(body.agent, 128));
  if (Array.isArray(body.agents) && agents.length !== count) k.fail("invalid_message", "agents[] length must equal count", { issues: [{ path: "/agents", message: "length" }] });
  for (const a of agents) if (a !== undefined && !AGENT_ID.test(a)) k.fail("invalid_message", "bad agent id", { issues: [{ path: "/agent", message: AGENT_ID.source }] });
  const ttl = ttlOf(k, body.ttl, DEFAULT_TOKEN_TTL);
  const trunk = await trunkOf(env, k, repo);
  const d = db(env, k);
  const a = artifacts(env, k);
  const now = Date.now();
  await d
    .prepare(
      `INSERT INTO tasks (repo, id, title, status, candidates, created_at, updated_at, acceptance) VALUES (?, ?, ?, 'open', 0, ?, ?, ?) ON CONFLICT (repo, id) DO UPDATE SET title = COALESCE(excluded.title, tasks.title), acceptance = COALESCE(excluded.acceptance, tasks.acceptance), updated_at = excluded.updated_at`,
    )
    .bind(repo, task, str(body.title, 500) ?? null, now, now, acceptance)
    .run();
  const sub = subscriber(env);
  const out = [];
  for (let i = 0; i < (count as number); i++) {
    // Monotonic candidate number per task (D1 serializes writes; RETURNING gives the new value).
    const r = await d.prepare(`UPDATE tasks SET candidates = candidates + 1, updated_at = ? WHERE repo = ? AND id = ? RETURNING candidates`).bind(Date.now(), repo, task).first<{ candidates: number }>();
    const n = r!.candidates;
    const name = forkName(repo, task, n);
    let fork;
    try {
      fork = await withRepo(a, trunk.trunk, (t) => t.fork(name, { defaultBranchOnly: true, description: `Weft candidate ${n} for ${repo}/${task}` }));
    } catch (e) {
      const code = artifactsErrorCode(e);
      k.fail(code === "ALREADY_EXISTS" ? "invalid_reference" : "unavailable", `fork ${trunk.trunk} -> ${name} failed: ${code ?? (e as Error).message}`);
    }
    let fresh = { plaintext: fork!.token, expiresAt: fork!.tokenExpiresAt ?? "" };
    // The fork's initial token has Artifacts' default TTL; mint one with ours when the fork is ready.
    try {
      const t = await withRepo(a, name, (f) => f.createToken("write", ttl));
      await withRepo(a, name, (f) => f.revokeToken(fork!.token)).catch(() => false);
      fresh = { plaintext: t.plaintext, expiresAt: t.expiresAt };
    } catch {
      /* FORK_IN_PROGRESS: keep the fork's initial token */
    }
    let subId: string | null = null;
    let subStatus = "pending";
    let subErr: string | null = null;
    if (sub) {
      try {
        subId = (await sub.subscribePushes(trunk.namespace, name)).id;
        subStatus = "active";
      } catch (e) {
        subStatus = "failed";
        subErr = (e as Error).message.slice(0, 500);
      }
    }
    const changeId = newChangeId();
    const agent = agents[i] ?? null;
    const t = Date.now();
    await d
      .prepare(
        `INSERT INTO changes (id, repo, task, n, agent, namespace, fork, remote, default_branch, status, subscription_id, subscription_status, subscription_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      )
      .bind(changeId, repo, task, n, agent, trunk.namespace, name, fork!.remote, fork!.defaultBranch, subId, subStatus, subErr, t, t)
      .run();
    const row = (await d.prepare(`SELECT * FROM changes WHERE id = ?`).bind(changeId).first<ChangeRow>())!;
    out.push({ ...publicChange(row), token: { plaintext: fresh.plaintext, scope: "write", expires_at: fresh.expiresAt } });
  }
  return k.json({ type: "candidates", repo, task, candidates: out }, 201);
}

// ---------------------------------------------------------------------------- admin

export async function artifactsAdmin(req: Request, env: ArtifactsEnv, k: Kit, path: string): Promise<Response | null> {
  const m = req.method;
  if (path === "/v1/admin/artifacts/repos" && m === "POST") {
    const body = (await k.readJson(req)) as { repo?: unknown; trunk?: unknown; create?: unknown; default_branch?: unknown; config?: unknown };
    if (body.config !== undefined && (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)))
      k.fail("invalid_message", "config must be an object", { issues: [{ path: "/config", message: "object" }] });
    const repo = str(body.repo, 64);
    if (!repo) k.fail("invalid_message", "repo required", { issues: [{ path: "/repo", message: "string" }] });
    const trunk = str(body.trunk, 63) ?? repo!;
    const a = artifacts(env, k);
    let info: { defaultBranch: string; remote: string };
    if (body.create === true) {
      try {
        const c = await a.create(trunk, { setDefaultBranch: str(body.default_branch, 100) ?? "main", description: `Weft trunk for ${repo}` });
        info = { defaultBranch: c.defaultBranch, remote: c.remote };
      } catch (e) {
        if (artifactsErrorCode(e) !== "ALREADY_EXISTS") throw e;
        info = await withRepo(a, trunk, (r) => r.info());
      }
    } else {
      try {
        info = await withRepo(a, trunk, (r) => r.info());
      } catch (e) {
        if (artifactsErrorCode(e) === "NOT_FOUND") k.fail("not_found", `Artifacts repo ${trunk} not found in namespace ${ns(env)} (pass create:true)`);
        throw e;
      }
    }
    await db(env, k)
      .prepare(
        `INSERT INTO artifacts_repos (repo, namespace, trunk, default_branch, remote, created_at, config) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET namespace = excluded.namespace, trunk = excluded.trunk, default_branch = excluded.default_branch, remote = excluded.remote,
           config = COALESCE(excluded.config, artifacts_repos.config)`,
      )
      .bind(repo, ns(env), trunk, info!.defaultBranch, info!.remote, Date.now(), body.config === undefined ? null : JSON.stringify(body.config))
      .run();
    return k.json({ type: "artifacts.repo", repo, namespace: ns(env), trunk, default_branch: info!.defaultBranch, remote: info!.remote, ...(body.config !== undefined ? { config: body.config } : {}) }, 201);
  }
  if (path === "/v1/admin/artifacts/subscriptions" && m === "GET") {
    const rows = await db(env, k).prepare(`SELECT * FROM changes WHERE status = 'open' AND subscription_status IN ('pending', 'failed') ORDER BY created_at`).all<ChangeRow>();
    return k.json({ type: "subscriptions.pending", changes: rows.results.map(publicChange) });
  }
  if (path === "/v1/admin/artifacts/subscriptions" && m === "POST") {
    const body = (await k.readJson(req)) as { change?: unknown; subscription_id?: unknown };
    const change = str(body.change, 64);
    const id = str(body.subscription_id, 64);
    if (!change || !id) k.fail("invalid_message", "change and subscription_id required", { issues: [{ path: "", message: "change, subscription_id" }] });
    const r = await db(env, k).prepare(`UPDATE changes SET subscription_id = ?, subscription_status = 'active', subscription_error = NULL, updated_at = ? WHERE id = ?`).bind(id, Date.now(), change).run();
    if (!r.meta.changes) k.fail("not_found", `change ${change} not found`);
    return k.json({ type: "subscription", change, subscription_id: id, status: "active" });
  }
  return null;
}

// ---------------------------------------------------------------------------- queue consumer

export type IngestOutcome = { key: string; status: "recorded" | "duplicate" | "trunk" | "unmatched" | "ignored"; seq?: number; change?: string };

const MAX_ATTEMPTS = 8;

/** Queue consumer for `weft-artifacts-events`. Idempotent per event key. */
export async function handleArtifactsBatch(batch: MessageBatch<unknown>, env: ArtifactsEnv): Promise<IngestOutcome[]> {
  const out: IngestOutcome[] = [];
  for (const msg of batch.messages) {
    try {
      out.push(await ingest(msg.body, env, msg.attempts));
      msg.ack();
    } catch (e) {
      console.error("artifacts event failed", (e as Error).message);
      if (msg.attempts >= MAX_ATTEMPTS) msg.ack();
      else msg.retry({ delaySeconds: Math.min(60, 2 ** msg.attempts) });
    }
  }
  return out;
}

/** Process one Artifacts event: record the push as a revision and a WCP `checkpoint`. */
export async function ingest(body: unknown, env: ArtifactsEnv, attempts = 1): Promise<IngestOutcome> {
  if (!env.WEFT_DB) throw new Error("WEFT_DB not configured");
  const d = env.WEFT_DB;
  const now = Date.now();
  const envlp = decodeEnvelope(body);
  if (!envlp) {
    console.warn("artifacts: undecodable message");
    return { key: "undecodable", status: "ignored" };
  }
  const push = parsePush(envlp);
  if (!push) {
    const key = `${envlp.type}:${envlp.source.namespace ?? ""}/${envlp.source.repoName ?? ""}:${envlp.metadata.eventTimestamp ?? now}`;
    await d
      .prepare(`INSERT OR IGNORE INTO artifact_events (key, type, namespace, repo_name, status, event_ts, received_at) VALUES (?, ?, ?, ?, 'ignored', ?, ?)`)
      .bind(key, envlp.type, envlp.source.namespace ?? null, envlp.source.repoName ?? null, envlp.metadata.eventTimestamp ?? null, now)
      .run();
    return { key, status: "ignored" };
  }
  const latency = push.eventTimestamp ? now - Date.parse(push.eventTimestamp) : null;
  await d
    .prepare(`INSERT OR IGNORE INTO artifact_events (key, type, namespace, repo_name, status, event_ts, received_at, latency_ms) VALUES (?, ?, ?, ?, 'received', ?, ?, ?)`)
    .bind(push.key, envlp.type, push.namespace, push.repo, push.eventTimestamp ?? null, now, Number.isFinite(latency) ? latency : null)
    .run();
  const prior = await d.prepare(`SELECT status, seq, change_id FROM artifact_events WHERE key = ?`).bind(push.key).first<{ status: string; seq: number | null; change_id: string | null }>();
  if (prior && prior.status !== "received" && prior.status !== "error")
    return { key: push.key, status: "duplicate", ...(prior.seq !== null ? { seq: prior.seq } : {}), ...(prior.change_id ? { change: prior.change_id } : {}) };
  await d.prepare(`UPDATE artifact_events SET attempts = ? WHERE key = ?`).bind(attempts, push.key).run();
  try {
    const res = await record(push, env, d);
    await d
      .prepare(`UPDATE artifact_events SET status = ?, change_id = ?, seq = ?, error = NULL WHERE key = ?`)
      .bind(res.status, res.change ?? null, res.seq ?? null, push.key)
      .run();
    return res;
  } catch (e) {
    await d.prepare(`UPDATE artifact_events SET status = 'error', error = ? WHERE key = ?`).bind((e as Error).message.slice(0, 500), push.key).run();
    throw e;
  }
}

async function record(push: Push, env: ArtifactsEnv, d: D1Database): Promise<IngestOutcome> {
  const change = await d.prepare(`SELECT * FROM changes WHERE namespace = ? AND fork = ?`).bind(push.namespace, push.repo).first<ChangeRow>();
  if (!change) {
    const trunk = await d.prepare(`SELECT repo FROM artifacts_repos WHERE namespace = ? AND trunk = ?`).bind(push.namespace, push.repo).first<{ repo: string }>();
    // Trunk pushes are landings; B8's landing queue records them (it knows the op/change).
    return { key: push.key, status: trunk ? "trunk" : "unmatched" };
  }
  if (push.deleted) return { key: push.key, status: "ignored", change: change.id };
  // Only the change's branch is a revision; refs/heads/weft/* are written by the workflows (rebased results).
  if (push.ref !== `refs/heads/${change.default_branch}`) return { key: push.key, status: "ignored", change: change.id };

  const head = push.commits.find((c) => c.id === push.after) ?? push.commits[push.commits.length - 1];
  const subject = head?.message.split("\n")[0]?.slice(0, 200) ?? null;
  const trailer = head ? (parseTrailers(head.message)["Change-Id"] ?? null) : null;
  const now = Date.now();
  await d
    .prepare(
      `INSERT OR IGNORE INTO revisions (change_id, sha, ref, before_sha, commits, subject, trailer_change_id, status, pushed_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)`,
    )
    .bind(change.id, push.after, push.ref, push.before, push.totalCommits, subject, trailer, push.eventTimestamp ?? null, now)
    .run();
  const rev = await d.prepare(`SELECT seq FROM revisions WHERE change_id = ? AND sha = ?`).bind(change.id, push.after).first<{ seq: number | null }>();
  let seq = rev?.seq ?? undefined;
  if (seq === undefined || seq === null) {
    const stub = env.WEFT_REPO.get(env.WEFT_REPO.idFromName(change.repo));
    const sum = (await stub.summary()) as unknown as Result<{ head_seq: number }>;
    if (!sum.ok) throw new Error(`coordinator ${change.repo}: ${sum.error.error.message}`);
    const draft: EventDraft = {
      kind: "checkpoint",
      base_seq: sum.value.head_seq,
      change: change.id,
      task: change.task,
      payload: { sha: push.after, ref: push.ref },
      ...(subject ? { intent: subject } : {}),
      summary_hint: `${change.agent ? `${change.agent}: ` : ""}${subject ?? change.fork}${push.totalCommits > 1 ? ` (+${push.totalCommits - 1} more)` : ""}`.slice(0, 140),
    };
    const r = (await stub.op("system", [draft, { type: "system", id: "artifacts" }])) as unknown as Result<EventRecord>;
    if (!r.ok) throw new Error(`checkpoint append failed: ${r.error.error.message}`);
    seq = r.value.seq;
    await d.prepare(`UPDATE revisions SET seq = ? WHERE change_id = ? AND sha = ?`).bind(seq, change.id, push.after).run();
  }
  await d
    .prepare(`UPDATE changes SET head_sha = ?, base_sha = COALESCE(base_sha, ?), updated_at = ? WHERE id = ?`)
    .bind(push.after, push.before === "0000000000000000000000000000000000000000" ? null : push.before, now, change.id)
    .run();
  await triggerProcessing(env, d, change, push.after);
  return { key: push.key, status: "recorded", seq, change: change.id };
}

/**
 * An abandoned change, told to its repo's coordinator (spec §6.7): a system `release` with reason
 * `abandoned` and no keys. Returns its seq, or null when the coordinator does not know the change
 * (no agent session ever named it, so nothing relies on it).
 */
export async function abandonInCoordinator(env: ArtifactsEnv, repo: string, change: string): Promise<number | null> {
  const stub = env.WEFT_REPO.get(env.WEFT_REPO.idFromName(repo));
  // A change no agent session ever named is unknown to the coordinator: nothing relies on it, nothing to log.
  const known = (await stub.dependencies(change)) as unknown as Result<unknown>;
  if (!known.ok) return null;
  const sum = (await stub.summary()) as unknown as Result<{ head_seq: number }>;
  if (!sum.ok) throw new Error(sum.error.error.message);
  const draft: EventDraft = { kind: "release", base_seq: sum.value.head_seq, change, payload: { reason: "abandoned" } };
  const r = (await stub.op("system", [draft, { type: "system", id: "artifacts" }])) as unknown as Result<EventRecord>;
  if (!r.ok) throw new Error(r.error.error.message);
  return r.value.seq;
}

/**
 * Continuous-sync hook (design §6.3): start ProcessRevision for this revision (rebase onto trunk
 * with the layered merge, tests in the sandbox, evidence). The instance id is derived from
 * (change, sha), so a redelivered push event does not start a second run.
 */
export async function triggerProcessing(env: ArtifactsEnv, d: D1Database, change: { id: string; repo: string }, sha: string): Promise<void> {
  await d.prepare(`UPDATE revisions SET status = 'queued' WHERE change_id = ? AND sha = ? AND status = 'recorded'`).bind(change.id, sha).run();
  if (!env.WEFT_PROCESS_REVISION) return;
  const id = ids.process(change.id, sha);
  try {
    await env.WEFT_PROCESS_REVISION.create({ id, params: { repo: change.repo, change: change.id, sha } });
  } catch (e) {
    if (!/already exists|already_exists|duplicate/i.test((e as Error).message)) throw e;
  }
  await d.prepare(`UPDATE revisions SET workflow_id = ? WHERE change_id = ? AND sha = ?`).bind(id, change.id, sha).run();
}
