// weft-workflows: the four Weft workflows as Cloudflare Workflows (B8).
//
//   ProcessRevision  (weft-process-revision)  gateway queue consumer, per pushed revision
//   LandChange       (weft-land-change)       POST /v1/repos/{repo}/changes/{change}/land, BestOfN
//   RevertOperation  (weft-revert-operation)  human `undo`, POST /v1/repos/{repo}/system/revert
//   BestOfN          (weft-best-of-n)         POST /v1/repos/{repo}/tasks/{task}/select; gets
//                                             `candidate` events (ProcessRevision) and `approval`
//                                             events (human `approve` action, via the gateway)
//
// Bindings: D1 (shared with the gateway), Artifacts (token minting; tokens never become step
// output), the sandbox runner (service RPC; jobs = weft-job.mjs in a container), the gateway
// (service; the repo coordinator over its system API with WEFT_SYSTEM_TOKEN).
//
// Operator HTTP API (Bearer WEFT_WORKFLOWS_TOKEN):
//   POST /v1/workflows/{process|land|revert|best-of-n}   {id?, params}  -> 201 {id}
//   GET  /v1/workflows/{kind}/{id}                                       -> instance status
//   POST /v1/workflows/{kind}/{id}/events                {type, payload} -> sendEvent

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { withRepo, type ArtifactsLike } from "@weft/artifacts";
import type { EventDraft, EventRecord } from "@weft/protocol";
import { bestOfN, landChange, processRevision, revertOperation } from "./core/workflows";
import { ids } from "./core/ids";
import { evidenceCaps, type EvidenceEnv } from "./evidence-cf";
import type { BestOfNParams, CoordinatorClient, Deps, JobRequest, JobResult, JobRunner, LandChangeParams, OpRow, ProcessRevisionParams, QueueEntry, RevertOperationParams, StepLike } from "./core/types";

export { ids };

/** The sandbox's `SandboxRunner` entrypoint (apps/sandbox/src/index.ts), as used here. */
interface SandboxRpc {
  start(req: Record<string, unknown>): Promise<{ run: string; ok: boolean; code?: number; errors?: string[]; status?: unknown }>;
  status(run: string): Promise<SandboxStatus | undefined>;
  destroy?(run: string): Promise<void>;
}
type SandboxStatus = { run: string; state: string; result?: { outcome?: { weft_job?: JobResult }; reason?: string; detail?: string; state?: string }; timings?: { cold_start_ms?: number }; error?: string };

export interface Env extends Omit<EvidenceEnv, "ARTIFACTS"> {
  WEFT_DB: D1Database;
  ARTIFACTS: ArtifactsLike;
  SANDBOX: SandboxRpc;
  GATEWAY: Fetcher;
  WEFT_GATEWAY_URL: string;
  WEFT_SYSTEM_TOKEN?: string;
  WEFT_WORKFLOWS_TOKEN?: string;
  PROCESS_REVISION: Workflow<ProcessRevisionParams>;
  LAND_CHANGE: Workflow<LandChangeParams>;
  REVERT_OPERATION: Workflow<RevertOperationParams>;
  BEST_OF_N: Workflow<BestOfNParams>;
  /** Land-queue metrics (batch size, presubmit runs saved, bisect steps). */
  WEFT_LAND?: AnalyticsEngineDataset;
}

const TERMINAL = new Set(["succeeded", "failed", "lost", "killed"]);
const TOKEN_TTL_S = 3600;

// ------------------------------------------------------------------ coordinator over the gateway

class HttpCoordinator implements CoordinatorClient {
  constructor(
    private readonly env: Env,
    private readonly repo: string,
  ) {}
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.env.WEFT_SYSTEM_TOKEN) throw new Error("WEFT_SYSTEM_TOKEN is not configured");
    const url = `${this.env.WEFT_GATEWAY_URL}/v1/repos/${encodeURIComponent(this.repo)}${path}`;
    const res = await this.env.GATEWAY.fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.env.WEFT_SYSTEM_TOKEN}`, "wcp-version": "0.1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`gateway ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text) as T;
  }
  async headSeq() {
    return (await this.call<{ head_seq: number }>("GET", "/events?tail=1&limit=1")).head_seq;
  }
  system(draft: EventDraft) {
    return this.call<EventRecord>("POST", "/system/events", draft);
  }
  enqueue(change: string, _by: string, note?: string) {
    return this.call<QueueEntry>("POST", "/system/queue", { change, ...(note ? { note } : {}) });
  }
  setQueueStatus(id: number, status: QueueEntry["status"], note?: string) {
    return this.call<QueueEntry>("POST", "/system/queue", { id, status, ...(note ? { note } : {}) });
  }
  async queue(statuses = ["queued", "landing"]) {
    return (await this.call<{ entries: QueueEntry[] }>("GET", `/system/queue?status=${statuses.join(",")}`)).entries;
  }
  async claimBatch(leader: number, ids: number[], note?: string) {
    return (await this.call<{ entries: QueueEntry[] }>("POST", "/system/queue", { claim: leader, ids, ...(note ? { note } : {}) })).entries;
  }
  async ops() {
    return (await this.call<{ ops: OpRow[] }>("GET", "/system/ops")).ops;
  }
}

// ------------------------------------------------------------------ jobs in the sandbox

class SandboxJobs implements JobRunner {
  constructor(private readonly env: Env) {}

  async start(run: string, req: JobRequest): Promise<{ run: string }> {
    // Replay-safe: if this run id exists, the job was already started by an earlier attempt.
    const existing = await this.env.SANDBOX.status(run).catch(() => undefined);
    if (existing) return { run };
    const remotes: Array<{ remote: string; token: string }> = [];
    const mint = async (name: string, remote: string, scope: "read" | "write") => {
      const t = await withRepo(this.env.ARTIFACTS, name, (r) => r.createToken(scope, TOKEN_TTL_S));
      remotes.push({ remote, token: t.plaintext });
    };
    await mint(req.trunk.name, req.trunk.remote, req.trunk.access);
    if (req.fork) await mint(req.fork.name, req.fork.remote, req.fork.access);
    for (const f of req.forks ?? []) if (!remotes.some((r) => r.remote === f.remote)) await mint(f.name, f.remote, f.access);
    const res = await this.env.SANDBOX.start({
      run,
      repo: req.repo,
      task: req.task,
      change: req.change,
      agent: "weft-workflows",
      title: `${req.spec.job} ${req.change}`.slice(0, 200),
      harness: "script",
      command: ["node", "/opt/weft/weft-job.mjs", JSON.stringify(req.spec)],
      remotes,
      push: false,
      timeout_s: req.config.job_timeout_s ?? 1800,
      instance: req.config.instance ?? "standard-1",
      ...(req.config.allow_hosts?.length ? { allow_hosts: req.config.allow_hosts } : {}),
    });
    if (!res.ok && res.code !== 409) throw new Error(`sandbox start ${run}: ${(res.errors ?? []).join("; ")}`);
    return { run };
  }

  async poll(run: string): Promise<{ done: boolean; state?: string; result?: JobResult }> {
    const st = await this.env.SANDBOX.status(run);
    if (!st) return { done: false, state: "unknown" };
    if (!TERMINAL.has(st.state)) return { done: false, state: st.state };
    const job = st.result?.outcome?.weft_job;
    const info = { id: run, state: st.state, ...(st.timings?.cold_start_ms !== undefined ? { cold_start_ms: st.timings.cold_start_ms } : {}) };
    // Free the container (best effort; it would idle out after 30 min anyway).
    await this.env.SANDBOX.destroy?.(run).catch(() => undefined);
    if (job) return { done: true, state: st.state, result: { ...job, run: info } };
    return { done: true, state: st.state, result: { status: "error", error: `sandbox run ${st.state}: ${st.result?.reason ?? st.error ?? "no job result"} ${st.result?.detail ?? ""}`.trim().slice(0, 1500), run: info } };
  }
}

function deps(env: Env): Deps {
  const evidence = evidenceCaps(env);
  return {
    db: env.WEFT_DB as unknown as Deps["db"],
    coord: (repo) => new HttpCoordinator(env, repo),
    jobs: new SandboxJobs(env),
    now: () => Date.now(),
    ...(evidence ? { evidence } : {}),
    ...(env.WEFT_LAND ? { metrics: env.WEFT_LAND } : {}),
    launch: {
      async land(p) {
        const id = ids.land(p.change, Date.now());
        await env.LAND_CHANGE.create({ id, params: p });
        return id;
      },
      async candidateReady(repo, task, payload) {
        try {
          const inst = await env.BEST_OF_N.get(ids.bestOfN(repo, task));
          const s = await inst.status();
          if (s.status === "running" || s.status === "waiting" || s.status === "queued") await inst.sendEvent({ type: "candidate", payload });
        } catch {
          /* no selection running for this task */
        }
      },
    },
  };
}

const asStep = (s: WorkflowStep) => s as unknown as StepLike;

export class ProcessRevision extends WorkflowEntrypoint<Env, ProcessRevisionParams> {
  override async run(event: Readonly<WorkflowEvent<ProcessRevisionParams>>, step: WorkflowStep) {
    return processRevision(event.payload, asStep(step), deps(this.env), event.instanceId);
  }
}
export class LandChange extends WorkflowEntrypoint<Env, LandChangeParams> {
  override async run(event: Readonly<WorkflowEvent<LandChangeParams>>, step: WorkflowStep) {
    return landChange(event.payload, asStep(step), deps(this.env), event.instanceId);
  }
}
export class RevertOperation extends WorkflowEntrypoint<Env, RevertOperationParams> {
  override async run(event: Readonly<WorkflowEvent<RevertOperationParams>>, step: WorkflowStep) {
    return revertOperation(event.payload, asStep(step), deps(this.env), event.instanceId);
  }
}
export class BestOfN extends WorkflowEntrypoint<Env, BestOfNParams> {
  override async run(event: Readonly<WorkflowEvent<BestOfNParams>>, step: WorkflowStep) {
    return bestOfN(event.payload, asStep(step), deps(this.env), event.instanceId);
  }
}

// ------------------------------------------------------------------ operator API

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

function binding(env: Env, kind: string): Workflow<unknown> | null {
  const m: Record<string, Workflow<unknown>> = { process: env.PROCESS_REVISION, land: env.LAND_CHANGE, revert: env.REVERT_OPERATION, "best-of-n": env.BEST_OF_N };
  return m[kind] ?? null;
}

function defaultId(kind: string, p: Record<string, unknown>): string | undefined {
  const s = (k: string) => String(p[k] ?? "");
  if (kind === "process") return ids.process(s("change"), s("sha"));
  if (kind === "land") return ids.land(s("change"), Date.now());
  if (kind === "revert") return ids.revert(s("repo"), s("op_id") || s("seq"), Date.now());
  if (kind === "best-of-n") return ids.bestOfN(s("repo"), s("task"));
  return undefined;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/v1/health") return Response.json({ ok: true, service: "weft-workflows" });
    const auth = req.headers.get("authorization") ?? "";
    if (!env.WEFT_WORKFLOWS_TOKEN || !timingSafeEqual(auth, `Bearer ${env.WEFT_WORKFLOWS_TOKEN}`)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const m = /^\/v1\/workflows\/(process|land|revert|best-of-n)(?:\/([A-Za-z0-9_-]{1,100})(\/events)?)?$/.exec(url.pathname);
    if (!m) return Response.json({ error: "not found" }, { status: 404 });
    const wf = binding(env, m[1]!)!;
    try {
      if (!m[2] && req.method === "POST") {
        const body = (await req.json()) as { id?: string; params?: Record<string, unknown> };
        const params = body.params ?? {};
        const id = body.id ?? defaultId(m[1]!, params);
        const inst = await wf.create({ ...(id ? { id } : {}), params });
        return Response.json({ id: inst.id }, { status: 201 });
      }
      if (m[2] && !m[3] && req.method === "GET") {
        const inst = await wf.get(m[2]);
        return Response.json({ id: inst.id, ...(await inst.status()) });
      }
      if (m[2] && m[3] && req.method === "POST") {
        const body = (await req.json()) as { type: string; payload?: unknown };
        await (await wf.get(m[2])).sendEvent({ type: body.type, payload: body.payload ?? {} });
        return Response.json({ ok: true });
      }
    } catch (e) {
      return Response.json({ error: String((e as Error).message ?? e) }, { status: 400 });
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  },
} satisfies ExportedHandler<Env>;
