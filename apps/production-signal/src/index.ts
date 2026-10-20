import { detect, type D1Like, type ProductionError, type RevertWorkflow } from "./core";

export interface Env {
  WEFT_DB: D1Database;
  WEFT_REVERT_OPERATION: RevertWorkflow;
  WEFT_PROD_EVENTS: Queue<ProductionError>;
  WEFT_PROD: AnalyticsEngineDataset;
  WEFT_REPO: string;
  /** Optional JSON map of producer Worker script name -> Weft repo (one tail consumer, many repos). */
  WEFT_REPOS?: string;
  WEFT_SPIKE_WINDOW_SECONDS?: string;
  WEFT_SPIKE_THRESHOLD?: string;
}

/**
 * The subset of a Tail `TraceItem` the detector reads. Exceptions live at the top level of the
 * trace item (verified live on weft-demo: `{ name, message, stack: "    at priceOf (worker.js:17:27)…", timestamp }`);
 * `event` carries the request/response of a fetch invocation.
 */
type TailRecord = { exceptions?: unknown; event?: { request?: { url?: string; method?: string }; response?: { status?: number } } | null; outcome?: string; scriptName?: string; eventTimestamp?: number };

function intVar(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function stringifyException(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const e = value as { name?: unknown; message?: unknown; stack?: unknown };
    const head = [e.name, e.message].filter((v): v is string => typeof v === "string" && v.length > 0).join(": ");
    const stack = typeof e.stack === "string" ? e.stack.trimEnd() : "";
    // Workers report `stack` as frames only; prefix the `Name: message` line unless it is already there.
    const text = head && !stack.startsWith(head) ? [head, stack].filter(Boolean).join("\n") : stack || head;
    return text || null;
  }
  return null;
}

async function eventId(repo: string, at: number, stack: string, script?: string): Promise<string> {
  const input = new TextEncoder().encode(`${repo}\n${at}\n${script ?? ""}\n${stack}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** `WEFT_REPOS` parsed (script name -> repo); malformed JSON counts as no map. */
export function repoMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0));
  } catch {
    return {};
  }
}

/**
 * Convert Cloudflare Tail records into a minimal, non-secret error envelope. The repo is the
 * producer script's entry in `scripts` (WEFT_REPOS), else the default repo (WEFT_REPO).
 */
export async function errorsFromTail(events: TailRecord[], defaultRepo: string, scripts: Record<string, string> = {}): Promise<ProductionError[]> {
  const out: ProductionError[] = [];
  for (const record of events) {
    const exceptions = Array.isArray(record.exceptions) ? record.exceptions : [];
    const thrown = exceptions.map(stringifyException).find((v): v is string => Boolean(v));
    if (!thrown) continue; // Requests with a 5xx response but no exception are not auto-revert evidence.
    // Evidence names the failing request (method + path; the query string is dropped).
    const req = record.event?.request;
    let where = "";
    try {
      if (req?.url) where = `${req.method ?? "GET"} ${new URL(req.url).pathname}`;
    } catch {}
    const stack = where ? `${thrown}\n    (request: ${where})` : thrown;
    const occurred_at = typeof record.eventTimestamp === "number" ? record.eventTimestamp : Date.now();
    const script = typeof record.scriptName === "string" ? record.scriptName : undefined;
    const repo = (script && scripts[script]) || defaultRepo;
    out.push({ event_id: await eventId(repo, occurred_at, stack, script), repo, occurred_at, stack, script, status: record.event?.response?.status });
  }
  return out;
}

export async function handleTail(events: TailRecord[], env: Env): Promise<void> {
  const errors = await errorsFromTail(events, env.WEFT_REPO, repoMap(env.WEFT_REPOS));
  for (const error of errors) {
    // Analytics Engine allows exactly one index (sampling key): the repo. Live-verified: two
    // indexes throw "writeDataPoint(): Maximum of 1 indexes supported.". Metrics must never block
    // the detector, so a failed write is logged and the Queue send still happens.
    try {
      env.WEFT_PROD.writeDataPoint({ indexes: [error.repo], blobs: [error.script ?? "unknown", error.event_id, error.stack.slice(0, 1_000)], doubles: [error.occurred_at, error.status ?? 0] });
    } catch (cause) {
      console.error("weft_prod write failed", cause instanceof Error ? cause.message : String(cause));
    }
    await env.WEFT_PROD_EVENTS.send(error);
  }
}

export async function handleProductionBatch(batch: MessageBatch<ProductionError>, env: Env): Promise<void> {
  const windowMs = intVar(env.WEFT_SPIKE_WINDOW_SECONDS, 300, 1) * 1_000;
  const threshold = intVar(env.WEFT_SPIKE_THRESHOLD, 5, 1);
  for (const message of batch.messages) {
    try {
      await detect(message.body, { db: env.WEFT_DB as unknown as D1Like, revert: env.WEFT_REVERT_OPERATION, now: Date.now, windowMs, threshold });
      message.ack();
    } catch (error) {
      console.error("production signal detector failed", error instanceof Error ? error.message : String(error));
      message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
    }
  }
}

export default {
  tail(events: TraceItem[], env: Env, _ctx: ExecutionContext): Promise<void> { return handleTail(events as unknown as TailRecord[], env); },
  queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> { return handleProductionBatch(batch as MessageBatch<ProductionError>, env); },
} satisfies ExportedHandler<Env>;
