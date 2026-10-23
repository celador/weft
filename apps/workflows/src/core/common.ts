// Helpers shared by the four workflows: durable job execution, ids, bounce messages, ranking.

import type { Candidate } from "./store";
import type { Conflict, Deps, JobRequest, JobResult, StepLike } from "./types";

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sandbox run id for a job: deterministic per (workflow instance, step) so a replayed start is idempotent. */
export async function jobRunId(instance: string, name: string): Promise<string> {
  return `wf-${(await sha256Hex(`${instance}/${name}`)).slice(0, 24)}`;
}

/** Deterministic op id for a landing (replays and retries never mint a second id). */
export async function landOpId(repo: string, change: string, after: string): Promise<string> {
  return `op-${(await sha256Hex(`land/${repo}/${change}/${after}`)).slice(0, 24)}`;
}
export async function revertOpId(repo: string, reverts: string, after: string): Promise<string> {
  return `op-${(await sha256Hex(`revert/${repo}/${reverts}/${after}`)).slice(0, 24)}`;
}

export { instanceId } from "./ids";

/**
 * Run one weft-job durably: a start step (mints tokens + starts the sandbox run; returns only
 * the run id), then sleep/poll steps until the run finishes.
 */
export async function runJob(step: StepLike, deps: Deps, instance: string, name: string, req: JobRequest, opts: { pollScale?: number } = {}): Promise<JobResult> {
  const id = await jobRunId(instance, name);
  const { run } = await step.do(`${name}: start job`, { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, () => deps.jobs.start(id, req));
  const base = deps.jobPoll ?? { interval: "5 seconds", max: 240 };
  // A batch job may run several presubmits (bisect): it gets proportionally more polls.
  const poll = { interval: base.interval, max: Math.ceil(base.max * Math.max(1, opts.pollScale ?? 1)) };
  for (let i = 0; ; i++) {
    const p = await step.do(`${name}: poll ${i}`, { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } }, () => deps.jobs.poll(run));
    if (p.done) return p.result ?? { status: "error", error: `job ${run} finished (${p.state ?? "?"}) without a result` };
    if (i >= poll.max) return { status: "error", error: `job ${run} still ${p.state ?? "running"} after ${poll.max} polls` };
    await step.sleep(`${name}: wait ${i}`, poll.interval);
  }
}

/** Human/agent-readable bounce text for a conflict or a failed presubmit. */
export function bounceText(kind: "conflict" | "tests" | "revert" | "land", r: Partial<JobResult> & { reason?: string; evidence?: string }): string {
  if (kind === "conflict") {
    const files = (r.conflicts ?? []).map((c: Conflict) => c.file);
    const hunks = (r.conflicts ?? [])
      .flatMap((c) => c.hunks.slice(0, 2).map((h) => `--- ${c.file}:${h.line}\n${h.text}`))
      .slice(0, 3)
      .join("\n");
    return [
      `Weft could not rebase your change onto trunk ${short(r.onto)}: ${files.join(", ") || "conflict"} conflict${files.length === 1 ? "s" : ""} after git, Mergiraf${r.layer === "resolver" ? " and the resolver agent" : ""}.`,
      `Fetch trunk, rebase (or merge) it into your branch, resolve, and push again.`,
      ...(r.resolver?.error ? [`Resolver: ${r.resolver.error}`] : []),
      ...(hunks ? ["", hunks] : []),
    ]
      .join("\n")
      .slice(0, 3800);
  }
  if (kind === "tests") {
    const s = r.tests?.summary;
    return [`Tests fail on your change rebased onto trunk ${short(r.onto)}${s ? ` (${s.fail ?? "?"} failed, ${s.pass ?? "?"} passed)` : ""}: \`${r.tests?.command ?? "tests"}\` exited ${r.tests?.exit ?? "?"}.`, "", (r.tests?.tail ?? "").slice(-2500)].join("\n").slice(0, 3800);
  }
  if (kind === "revert") return [`Your landed change was reverted: ${r.reason ?? "no reason given"}. The task is reopened.`, ...(r.evidence ? ["", r.evidence.slice(0, 3000)] : [])].join("\n").slice(0, 3800);
  return `Landing failed: ${r.reason ?? r.status ?? "unknown"}${r.detail ? ` (${r.detail.slice(0, 500)})` : ""}.`;
}

export const short = (s?: string | null) => (s ? s.slice(0, 12) : "(empty)");

// ------------------------------------------------------------------ ranking (BestOfN)

const LAYER_SCORE: Record<string, number> = { none: 120, reused: 110, git: 100, mergiraf: 80, resolver: 40 };

export type Ranked = { change: string; n: number; agent: string | null; score: number; reasons: string[]; eligible: boolean; layer: string };

/**
 * Rank processed candidates. Higher is better. Tests dominate (a failing candidate is never
 * eligible), then how cleanly it rebased (git > Mergiraf > resolver), then a small-diff bonus
 * and model cost. Ties go to the earlier candidate.
 */
export function rank(cands: Candidate[]): Ranked[] {
  const out = cands.map((c) => {
    const reasons: string[] = [];
    let score = 0;
    let eligible = c.revision?.status === "processed";
    if (!eligible) reasons.push(`revision ${c.revision?.status ?? "missing"}`);
    const t = c.test?.status;
    if (t === "pass") {
      score += 1000;
      reasons.push("tests pass");
    } else if (t === "fail") {
      eligible = false;
      reasons.push("tests fail");
    } else {
      score += 500;
      reasons.push("no tests");
    }
    const layer = String(c.rebase?.data?.layer ?? c.revision?.layer ?? "git");
    score += LAYER_SCORE[layer] ?? 0;
    reasons.push(`rebase: ${layer}`);
    const ds = c.rebase?.data?.diffstat as { insertions?: number; deletions?: number } | undefined;
    if (ds) {
      const churn = (ds.insertions ?? 0) + (ds.deletions ?? 0);
      score -= Math.min(200, Math.round(churn / 5));
      reasons.push(`churn ${churn}`);
    }
    // B10 review agent: a pass adds up to +60 by score; a fail sinks the candidate below every
    // reviewed-clean one (still eligible: a human may disagree with the model).
    const rv = c.review?.data as { verdict?: string; score?: number } | undefined;
    if (rv?.verdict === "pass") {
      score += Math.round((60 * Math.max(0, Math.min(100, Number(rv.score ?? 100)))) / 100);
      reasons.push(`review pass${rv.score !== undefined ? ` ${rv.score}` : ""}`);
    } else if (rv?.verdict === "fail") {
      score -= 300;
      reasons.push(`review fail${rv.score !== undefined ? ` ${rv.score}` : ""}`);
    } else if (rv?.verdict === "needs_human") reasons.push("review: needs human");
    const rk = (c.risk?.data as { risk?: string } | undefined)?.risk;
    if (rk) reasons.push(`risk ${rk}`);
    const cost = Number((c.cost?.data as { usd?: number } | undefined)?.usd ?? 0);
    if (cost > 0) {
      score -= Math.min(100, Math.round(cost * 20));
      reasons.push(`cost $${cost.toFixed(2)}`);
    }
    return { change: c.change, n: c.n, agent: c.agent, score: eligible ? score : -1, reasons, eligible, layer };
  });
  return out.sort((a, b) => b.score - a.score || a.n - b.n);
}

/** low = auto-land; medium/high need a human approve (WCP `control approve` → Workflows event). */
export function needsApproval(risk: string | undefined): boolean {
  return (risk ?? "low") !== "low";
}
