// Shared types for the Weft workflows (B8). Everything here is runtime-neutral: the Workflow
// classes (src/index.ts) bind it to Cloudflare (D1, Artifacts, the sandbox service, the repo
// coordinator over the gateway); the Node tests bind it to node:sqlite, the git-backed
// Artifacts fake, an in-process coordinator and weft-job.mjs run as a child process.

import type { EventDraft, EventRecord } from "@weft/protocol";
import type { EvidenceCapabilities } from "./evidence";

// ------------------------------------------------------------------ durable steps

export type Duration = number | `${number} ${"second" | "seconds" | "minute" | "minutes" | "hour" | "hours" | "day" | "days"}`;

/** The subset of Cloudflare's WorkflowStep the workflows use (a fake implements it in tests). */
export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: Duration): Promise<void>;
  waitForEvent<T>(name: string, opts: { type: string; timeout?: Duration }): Promise<{ payload: T; type: string; timestamp: Date }>;
}
export type StepConfig = { retries?: { limit: number; delay: Duration; backoff?: "constant" | "linear" | "exponential" }; timeout?: Duration };

// ------------------------------------------------------------------ D1 (structural)

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
}

// ------------------------------------------------------------------ coordinator

export type QueueEntry = { id: number; change: string; status: "queued" | "landing" | "landed" | "failed" | "cancelled"; requested_by: string; enqueued_seq: number | null; landed_seq: number | null; note: string | null; batch?: number | null; created_at: string; updated_at: string };
export type OpRow = { op_id: string; seq: number; kind: string; change_id: string | null; sha: string | null; trunk_ref: string | null; reverts_seq: number | null; reverts_op_id: string | null; at: string };

/** One repo's coordinator (THE ordered log), as the workflows need it. */
export interface CoordinatorClient {
  headSeq(): Promise<number>;
  system(draft: EventDraft): Promise<EventRecord>;
  enqueue(change: string, requestedBy: string, note?: string): Promise<QueueEntry>;
  setQueueStatus(id: number, status: QueueEntry["status"], note?: string): Promise<QueueEntry>;
  queue(statuses?: string[]): Promise<QueueEntry[]>;
  /** Batched landing: the leader (queue head, `landing`) claims queued entries behind it. */
  claimBatch(leader: number, ids: number[], note?: string): Promise<QueueEntry[]>;
  ops(): Promise<OpRow[]>;
}

// ------------------------------------------------------------------ jobs (weft-job.mjs)

export type Layer = "none" | "git" | "mergiraf" | "resolver" | "reused";
export type Conflict = { file: string; commit: string; hunks: Array<{ line: number; text: string }>; note?: string };
export type TestsResult = { status: "pass" | "fail" | "skipped"; exit?: number; timed_out?: boolean; ms?: number; command?: string; summary?: { pass?: number; fail?: number }; tail?: string; reason?: string; selection?: TestSelection };
/** Affected-test selection record (weft-job.mjs + packages/analyzer/src/testselect.ts). */
export type TestSelection = {
  mode: "subset" | "full";
  /** Why the full suite ran (null for a subset). */
  reason: string | null;
  /** Selected test files (capped at 100) and why each was picked. */
  files: string[];
  why?: Record<string, string>;
  /** Test files found in the tree (null when the selector was unavailable). */
  total: number | null;
  writes?: Array<{ key: string; kind: string }>;
  graph?: { files: number; parsed: number; cached: number; ms: number } | null;
  onto?: string;
  changed?: number;
  /** Selection time (ms), included in the job's `select_ms` timing. */
  ms?: number;
};
/** Opt-in per repo: `tests.select` (true or options). Without it every checkpoint runs the full suite. */
export type TestSelectConfig = {
  tests?: string[];
  infra?: string[];
  ignore?: string[];
  full_at_risk?: Risk;
  max_fraction?: number;
  /** Command for a subset; `{files}` is replaced by the selected test files (default: tests.command + files). */
  command?: string[] | string;
};
/** One change of a `land_batch` job, in queue order (weft-job.mjs). */
export type BatchItemResult = {
  change: string;
  /** landed | conflict (bounced before tests) | culprit (bisect isolated it) | pending (after the culprit, not landed this round) | ready (dry run) */
  status: "landed" | "conflict" | "culprit" | "pending" | "ready";
  head?: string;
  /** Trunk before/after this change on the stack: its own revertable range. */
  before?: string;
  after?: string;
  layer?: Layer;
  commits?: Array<{ orig: string; new: string; layer: Layer }>;
  conflicts?: Conflict[];
  resolver?: { kind: string; error?: string; model?: string; files?: string[] };
  diffstat?: { files: number; insertions: number; deletions: number };
};
export type BatchInfo = {
  size: number;
  /** Presubmit (full suite) runs this job did: 1 for the stacked tip + one per bisect step. */
  presubmit_runs: number;
  bisect_steps: number;
  /** Prefix lengths tested by bisect and their outcome. */
  tested: Array<{ prefix: number; status: "pass" | "fail"; ms?: number }>;
  culprit?: string | null;
  /** Number of changes (from the front) that passed together. */
  passing_prefix: number;
};
export interface JobResult {
  job?: "rebase" | "land" | "revert" | "land_batch";
  status: "up_to_date" | "clean" | "resolved" | "conflict" | "error" | "tests_failed" | "ready" | "noop" | "landed" | "stale_trunk" | "rejected" | "reverted" | "not_fast_forward";
  onto?: string;
  head?: string;
  base?: string | null;
  rebased?: string;
  layer?: Layer;
  commits?: Array<{ orig: string; new: string; layer: Layer; resolver?: unknown }>;
  conflicts?: Conflict[];
  resolver?: { kind: string; error?: string; model?: string; files?: string[] };
  diffstat?: { files: number; insertions: number; deletions: number };
  tests?: TestsResult;
  pushed?: { ref: string; sha?: string; error?: string };
  reused?: boolean;
  before?: string;
  after?: string;
  sha?: string;
  current?: string;
  expected?: string;
  detail?: string;
  error?: string;
  superseded?: string;
  timings?: Record<string, number>;
  /** B10: unified diff onto..rebased (capped at 48 KB) and changed files, for risk + review. */
  patch?: string;
  files?: Array<{ status: string; path: string }>;
  patch_truncated?: boolean;
  /** Added by the runner: where it ran (sandbox run id) + infra timings. */
  run?: { id: string; cold_start_ms?: number; state?: string };
  /** land_batch: per-change outcome, batch counters, the culprit's failing run. */
  items?: BatchItemResult[];
  batch?: BatchInfo;
  culprit_tests?: TestsResult;
  /** land_batch: the run that passed for the landed prefix (the tip run when nothing failed). */
  passing_tests?: TestsResult;
}

/** What a workflow asks the job runner for. Tokens are minted by the runner inside the start step (never step output). */
export interface JobRequest {
  repo: string;
  task: string;
  change: string;
  /** weft-job spec without auth; trunk/fork remotes are filled from `trunk`/`fork`. */
  spec: Record<string, unknown> & { job: "rebase" | "land" | "revert" | "land_batch" };
  trunk: { name: string; remote: string; branch: string; access: "read" | "write" };
  fork?: { name: string; remote: string; branch: string; access: "read" | "write" };
  /** land_batch: one fork per change (read tokens minted for each). */
  forks?: Array<{ name: string; remote: string; branch: string; access: "read" | "write" }>;
  config: RepoConfig;
}

export interface JobRunner {
  start(run: string, req: JobRequest): Promise<{ run: string }>;
  poll(run: string): Promise<{ done: boolean; state?: string; result?: JobResult }>;
}

// ------------------------------------------------------------------ config / params

export interface RepoConfig {
  tests?: { command: string[] | string; timeout_s?: number; select?: true | TestSelectConfig } | null;
  resolver?: { kind: "llm"; model?: string } | { kind: "command"; argv: string[]; timeout_s?: number } | null;
  layers?: Array<"git" | "mergiraf" | "resolver">;
  allow_hosts?: string[];
  instance?: string;
  job_timeout_s?: number;
  /**
   * Land queue. `batch` (default on: max 4, wait_s 30): when 2+ changes are queued, the head
   * stacks up to `max` of them, runs presubmit once and bisects on failure. `false` = one
   * change per presubmit (pre-batching behaviour). A lone change never waits.
   */
  land?: { batch?: false | { max?: number; wait_s?: number } } | null;
}

export type Risk = "low" | "medium" | "high";

export interface ProcessRevisionParams {
  repo: string;
  change: string;
  sha: string;
}
export interface LandChangeParams {
  repo: string;
  change: string;
  requested_by: string;
  note?: string;
}
export interface RevertOperationParams {
  repo: string;
  op_id?: string;
  seq?: number;
  reason: string;
  /** Principal that asked for the revert (token principal). */
  requested_by?: string;
  /** human (`undo` action) | system (auto-revert, e.g. a Tail Worker error spike). Default human. */
  requested_by_type?: "human" | "system";
  /** Evidence that motivated the revert (stack trace, error-rate sample, URL). */
  evidence?: { kind?: string; text?: string; uri?: string; data?: unknown };
}
export interface BestOfNParams {
  repo: string;
  task: string;
  n: number;
  risk?: Risk;
  /** How long to wait for N processed candidates (default 2 hours). */
  collect_timeout_s?: number;
  /** How long a human has to approve (default 24 hours). */
  approval_timeout_s?: number;
  /** Poll/backstop interval while collecting (default 60 s). */
  poll_s?: number;
}

/** Side effects that start or signal other workflow instances. */
export interface Launcher {
  land(p: LandChangeParams): Promise<string>;
  /** Tell a running BestOfN for (repo, task) that a candidate finished processing. Best effort. */
  candidateReady(repo: string, task: string, payload: { change: string; sha: string; status: string }): Promise<void>;
}

export interface Deps {
  db: D1Like;
  coord(repo: string): CoordinatorClient;
  jobs: JobRunner;
  launch: Launcher;
  now(): number;
  /** Poll interval for sandbox jobs (default 5 s) and max polls (default 240 = 20 min). */
  jobPoll?: { interval: Duration; max: number };
  /** Landing queue: how long to wait between turn checks and how many checks (default 10 s × 360). */
  queuePoll?: { interval: Duration; max: number };
  /** B10: preview, Browser Rendering + R2, Workers AI risk and AI Gateway review capabilities. */
  evidence?: EvidenceCapabilities;
  /** Workers Analytics Engine dataset for land-queue metrics (batch size, presubmits saved, bisect steps). */
  metrics?: { writeDataPoint(p: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void };
  /** Batch linger poll interval (default 5 s). */
  batchPoll?: Duration;
}

export type ChangeRow = {
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
};
export type TrunkRow = { repo: string; namespace: string; trunk: string; default_branch: string; remote: string; config: string | null };
export type RevisionRow = { change_id: string; sha: string; status: string; seq: number | null; onto_sha: string | null; rebased_sha: string | null; layer: string | null; received_at: number; processed_at: number | null };
