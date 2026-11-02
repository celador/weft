// RunController: the lifecycle of one agent run in one container, independent of the
// Workers runtime (the Durable Object in sandbox.ts plugs in the real container, storage and
// R2; tests plug in a local child_process container and in-memory sinks).
//
//   start(request) -> container start (cold) or reuse (warm) -> readiness probe -> outbound
//   intercepts -> write spec.json -> launch agent-run.mjs detached -> state "running"
//   tick()         -> ship new log bytes to R2 as numbered chunks -> on result.json: final
//                     status to R2, state "succeeded"/"failed", report callback
//   kill()         -> SIGTERM the run's process group
//
// Timings recorded per run (the cold-start measurement): requested_at, container_start_at,
// ready_at (cold_start_ms = ready_at - container_start_at, 0 when warm), launched_at,
// finished_at, plus agent-run's clone/adapter/agent/push durations.

import { randomRunId, redact, splitRequest, validateRunRequest, type ContainerSpec, type RunRequest, type RunSecrets } from "./spec";

export interface ExecOutputLike {
  stdout: ArrayBuffer;
  stderr: ArrayBuffer;
  exitCode: number;
}
export interface ExecProcessLike {
  exitCode: Promise<number>;
  output(): Promise<ExecOutputLike>;
}
export interface ExecOptionsLike {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: ReadableStream<Uint8Array> | "pipe";
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore" | "combined";
}
/** Structural subset of the Durable Object container API (`ctx.container`). */
export interface ContainerLike {
  readonly running: boolean;
  start(options: { image?: string; instance?: string; enableInternet: boolean; env?: Record<string, string>; labels?: Record<string, string> }): void;
  exec(cmd: string[], options?: ExecOptionsLike): Promise<ExecProcessLike>;
  destroy(): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
  /** Resolves when the container exits, rejects if it errors (e.g. fails to start). */
  monitor?(): Promise<void>;
}
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface LogSink {
  put(key: string, value: string | Uint8Array | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export type RunState = "starting" | "running" | "succeeded" | "failed" | "lost" | "killed";

export interface RunStatus {
  run: string;
  state: RunState;
  repo: string;
  task: string;
  change: string;
  agent: string;
  harness: string;
  instance: string;
  warm: boolean;
  timings: {
    requested_at: number;
    container_start_at?: number;
    ready_at?: number;
    cold_start_ms?: number;
    launched_at?: number;
    finished_at?: number;
    [k: string]: number | undefined;
  };
  result?: Record<string, unknown>;
  logs: { prefix: string; chunks: Record<string, number>; bytes: Record<string, number> };
  error?: string;
}

interface Persisted {
  status: RunStatus;
  spec: ContainerSpec;
  secrets: RunSecrets;
  offsets: Record<string, number>;
  report?: string;
}

export const STREAMS = ["runner.log", "agent.stdout.log", "agent.stderr.log"] as const;
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** Trust the Containers CA (HTTPS interception) in every tool the agent runs. */
export const TRUST_ENV: Record<string, string> = { NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, CURL_CA_BUNDLE: CA, SSL_CERT_FILE: CA };

// Start the command in its own process group (so kill() reaches the agent's children),
// record the group id, and survive the exec call returning.
// (`setsid` is util-linux; the fallback keeps local tests working on macOS.)
const LAUNCH = `dir=$1; shift
if command -v setsid >/dev/null 2>&1; then S=setsid; else S=; fi
$S sh -c 'echo $$ >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/launcher.log" 2>&1`;
const READ_FROM = `f=$1; o=$2; n=$3; [ -f "$f" ] || exit 0; tail -c +$((o+1)) "$f" | head -c "$n"`;

export interface ControllerDeps {
  container: ContainerLike;
  kv: KV;
  logs?: LogSink;
  image?: string;
  /** Called after the container is up, before anything runs in it (outbound intercepts). */
  prepare?: (props: { status: RunStatus; spec: ContainerSpec; secrets: RunSecrets }) => Promise<void>;
  report?: (url: string, status: RunStatus) => Promise<void>;
  aiGatewayBase?: string;
  /** Container paths. */
  workRoot?: string;
  agentRun?: string;
  node?: string;
  env?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  maxChunkBytes?: number;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

export class RunController {
  private readonly d: Required<Pick<ControllerDeps, "workRoot" | "agentRun" | "node" | "now" | "sleep" | "readyTimeoutMs" | "maxChunkBytes">> & ControllerDeps;
  constructor(deps: ControllerDeps) {
    this.d = {
      workRoot: "/workspace",
      agentRun: "/opt/weft/agent-run.mjs",
      node: "node",
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      readyTimeoutMs: 180_000,
      maxChunkBytes: 512 * 1024,
      ...deps,
    };
  }

  runDir(run: string) {
    return `${this.d.workRoot}/runs/${run}`;
  }

  private async load(): Promise<Persisted | undefined> {
    return this.d.kv.get<Persisted>("run");
  }
  private async save(p: Persisted) {
    await this.d.kv.put("run", p);
  }

  async start(req: RunRequest, defaultRun?: string): Promise<{ ok: true; status: RunStatus } | { ok: false; code: number; errors: string[] }> {
    const errs = validateRunRequest(req);
    if (errs.length) return { ok: false, code: 400, errors: errs };
    const existing = await this.load();
    if (existing && (existing.status.state === "starting" || existing.status.state === "running")) return { ok: false, code: 409, errors: [`run ${existing.status.run} is ${existing.status.state}`] };
    const run = req.run ?? defaultRun ?? randomRunId();
    const { spec, secrets } = splitRequest(req, run, this.d.aiGatewayBase);
    spec.work_root = this.d.workRoot;
    const instance = req.instance ?? "standard-1";
    const status: RunStatus = {
      run,
      state: "starting",
      repo: req.repo,
      task: req.task,
      change: req.change,
      agent: req.agent,
      harness: req.harness,
      instance,
      warm: this.d.container.running,
      timings: { requested_at: this.d.now() },
      logs: { prefix: `runs/${run}/`, chunks: {}, bytes: {} },
    };
    const p: Persisted = { status, spec, secrets, offsets: {}, ...(req.report ? { report: req.report.url } : {}) };
    await this.save(p);
    return { ok: true, status: publicStatus(status) };
  }

  /**
   * Boot the container and launch agent-run. Separate from start() because a cold start can
   * take longer than a request (or a blockConcurrencyWhile section) should wait: the DO calls
   * it from its alarm.
   */
  async boot(): Promise<RunStatus | undefined> {
    const p = await this.load();
    if (!p || p.status.state !== "starting") return p ? publicStatus(p.status) : undefined;
    const { status, spec, secrets } = p;
    try {
      status.warm = this.d.container.running;
      if (!this.d.container.running) {
        status.timings.container_start_at = this.d.now();
        this.d.container.start({
          ...(this.d.image ? { image: this.d.image } : {}),
          instance: status.instance,
          enableInternet: false,
          labels: { run: status.run.slice(0, 64), change: status.change.slice(0, 64) },
        });
      }
      await this.d.prepare?.({ status, spec, secrets });
      await this.waitReady(status);
      await this.d.container.setInactivityTimeout(30 * 60 * 1000);
      const dir = this.runDir(status.run);
      const w = await this.exec(["sh", "-c", 'mkdir -p "$1" && cat >"$1/spec.json"', "_", dir], { stdin: streamOf(JSON.stringify(spec)) });
      if (w.exitCode !== 0) throw new Error(`writing spec failed: ${dec.decode(w.stderr)}`);
      await this.d.container.exec(["/bin/sh", "-c", LAUNCH, "launch", dir, this.d.node, this.d.agentRun, dir], {
        env: { ...TRUST_ENV, HOME: "/root", ...(this.d.env ?? {}) },
        stdout: "ignore",
        stderr: "ignore",
      });
      status.timings.launched_at = this.d.now();
      status.state = "running";
    } catch (e) {
      status.state = "failed";
      status.error = redact(String((e as Error)?.message ?? e), [secrets.git_token, secrets.weft_token]);
      status.timings.finished_at = this.d.now();
      await this.save(p);
      await this.finalize(p);
      return publicStatus(status);
    }
    await this.save(p);
    return publicStatus(status);
  }

  private async waitReady(status: RunStatus) {
    const t0 = this.d.now();
    let last = "";
    let died: string | undefined;
    // A container that fails to start (bad image, instance too small) rejects monitor().
    this.d.container.monitor?.().then(
      () => void (died ??= "container exited during startup"),
      (e: unknown) => void (died = `container failed to start: ${String((e as Error)?.message ?? e)}`),
    );
    for (let i = 0; this.d.now() - t0 < this.d.readyTimeoutMs; i++) {
      if (died) throw new Error(died);
      try {
        const o = await this.exec(["true"]);
        if (o.exitCode === 0) {
          status.timings.ready_at = this.d.now();
          status.timings.cold_start_ms = status.timings.container_start_at ? status.timings.ready_at - status.timings.container_start_at : 0;
          return;
        }
      } catch (e) {
        last = String((e as Error)?.message ?? e);
      }
      await this.d.sleep(Math.min(250 * (i + 1), 2000));
    }
    throw new Error(`container not ready after ${this.d.readyTimeoutMs} ms${last ? `: ${last}` : ""}`);
  }

  private async exec(cmd: string[], opts: ExecOptionsLike = {}): Promise<ExecOutputLike> {
    const p = await this.d.container.exec(cmd, opts);
    return p.output();
  }

  /** Ship logs and detect completion. Returns ms until the next tick, or null when done. */
  async tick(): Promise<number | null> {
    const p = await this.load();
    if (!p) return null;
    const s = p.status;
    if (s.state === "starting") {
      await this.boot();
      return 2000;
    }
    if (s.state !== "running") return null;
    if (!this.d.container.running) {
      s.state = "lost";
      s.error = "container stopped before the run finished";
      s.timings.finished_at = this.d.now();
      await this.save(p);
      await this.finalize(p);
      return null;
    }
    const dir = this.runDir(s.run);
    await this.shipLogs(p, dir);
    const r = await this.exec(["sh", "-c", 'cat "$1/result.json" 2>/dev/null || true', "_", dir]);
    const text = dec.decode(r.stdout).trim();
    if (text) {
      await this.shipLogs(p, dir, true); // drain the tail written just before result.json
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(text) as Record<string, unknown>;
      } catch {
        await this.save(p);
        return 1000; // partially visible; next tick
      }
      s.result = JSON.parse(redact(JSON.stringify(result), [p.secrets.git_token, p.secrets.weft_token])) as Record<string, unknown>;
      s.state = result.state === "succeeded" ? "succeeded" : "failed";
      s.timings.finished_at = this.d.now();
      const t = (result.timings ?? {}) as Record<string, number>;
      for (const [k, v] of Object.entries(t)) if (typeof v === "number") s.timings[`agent_run.${k}`] = v;
      await this.save(p);
      await this.finalize(p);
      return null;
    }
    await this.save(p);
    return 5000;
  }

  /** Ship new bytes per stream. Normal ticks cap at 8 chunks per stream; `drain` (final flush) reads to EOF. */
  private async shipLogs(p: Persisted, dir: string, drain = false) {
    for (const stream of STREAMS) {
      for (let guard = 0; drain || guard < 8; guard++) {
        const off = p.offsets[stream] ?? 0;
        const o = await this.exec(["sh", "-c", READ_FROM, "_", `${dir}/${stream}`, String(off), String(this.d.maxChunkBytes)]);
        const n = o.stdout.byteLength;
        if (n === 0) break;
        const seq = p.status.logs.chunks[stream] ?? 0;
        const bytes = redact(dec.decode(o.stdout), [p.secrets.git_token, p.secrets.weft_token]);
        await this.d.logs?.put(`${p.status.logs.prefix}${stream}/${String(seq).padStart(6, "0")}`, enc.encode(bytes), { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
        p.offsets[stream] = off + n;
        p.status.logs.chunks[stream] = seq + 1;
        p.status.logs.bytes[stream] = off + n;
        if (n < this.d.maxChunkBytes) break;
      }
    }
  }

  private async finalize(p: Persisted) {
    const pub = publicStatus(p.status);
    await this.d.logs?.put(`${p.status.logs.prefix}status.json`, JSON.stringify(pub, null, 2), { httpMetadata: { contentType: "application/json" } });
    if (p.report && this.d.report) {
      try {
        await this.d.report(p.report, pub);
      } catch {
        /* best effort; status stays queryable */
      }
    }
  }

  async kill(): Promise<RunStatus | undefined> {
    const p = await this.load();
    if (!p) return undefined;
    if (p.status.state === "running" && this.d.container.running) {
      await this.exec(["sh", "-c", 'pid=$(cat "$1/pid" 2>/dev/null) && kill -TERM -"$pid" 2>/dev/null; true', "_", this.runDir(p.status.run)]);
      await this.shipLogs(p, this.runDir(p.status.run), true);
      p.status.state = "killed";
      p.status.timings.finished_at = this.d.now();
      await this.save(p);
      await this.finalize(p);
    }
    return publicStatus(p.status);
  }

  async status(): Promise<RunStatus | undefined> {
    const p = await this.load();
    return p ? publicStatus(p.status) : undefined;
  }
}

export function publicStatus(s: RunStatus): RunStatus {
  return JSON.parse(JSON.stringify(s)) as RunStatus;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = enc.encode(text);
  return new ReadableStream<Uint8Array>({
    type: "bytes",
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  } as UnderlyingByteSource as unknown as UnderlyingSource<Uint8Array>);
}
