// The four Weft workflows (design §6.3–§6.6), written against StepLike + Deps so the same code
// runs as Cloudflare Workflows (src/index.ts) and under the Node tests (fake step, real git).
//
//   ProcessRevision  checkpoint push -> layered rebase onto trunk (git -> Mergiraf -> resolver
//                    agent -> bounce to the agent) -> tests in the sandbox -> evidence
//   LandChange       submit queue in the repo DO -> final rebase + presubmit -> CAS advance of
//                    trunk -> `land` (op log, claims released) -> close the task
//   RevertOperation  op log -> revert commit on trunk (CAS) -> `revert` -> task reopened with evidence
//   BestOfN          wait for N processed candidates -> rank -> approval when the risk tier requires
//                    it (waitForEvent) -> LandChange for the winner

import { bounceText, landOpId, needsApproval, rank, revertOpId, runJob, short, type Ranked } from "./common";
import { collectEvidence, maxRisk, testsSummary, xEvidenceFromRows, type XEvidence } from "./evidence";
import { revisionStatus, Store } from "./store";
import type { BatchItemResult, BestOfNParams, ChangeRow, Deps, JobRequest, JobResult, LandChangeParams, ProcessRevisionParams, QueueEntry, RepoConfig, RevertOperationParams, StepLike, TestsResult } from "./types";

type Ctx = {
  change: ChangeRow;
  trunk: { name: string; remote: string; branch: string };
  cfg: RepoConfig;
  title: string | null;
  risk: "low" | "medium" | "high";
  /** B10: the task's acceptance criteria (review agent). */
  criteria?: string[];
};

async function loadCtx(store: Store, repo: string, changeId: string): Promise<Ctx | { skip: string }> {
  const change = await store.change(repo, changeId);
  if (!change) return { skip: `unknown change ${changeId}` };
  const trunk = await store.trunk(repo);
  if (!trunk) return { skip: `repo ${repo} has no Artifacts trunk` };
  const task = await store.task(repo, change.task);
  return { change, trunk: { name: trunk.trunk, remote: trunk.remote, branch: trunk.default_branch }, cfg: trunk.cfg, title: task?.title ?? null, risk: task?.risk ?? "medium", criteria: task?.criteria ?? [] };
}

function jobFor(ctx: Ctx, job: "rebase" | "land", sha: string, extra: Record<string, unknown>, access: { trunk: "read" | "write"; fork: "read" | "write" }): JobRequest {
  const c = ctx.change;
  return {
    repo: c.repo,
    task: c.task,
    change: c.id,
    config: ctx.cfg,
    trunk: { ...ctx.trunk, access: access.trunk },
    fork: { name: c.fork, remote: c.remote, branch: c.default_branch, access: access.fork },
    spec: {
      job,
      trunk: { remote: ctx.trunk.remote, branch: ctx.trunk.branch },
      fork: { remote: c.remote, branch: c.default_branch, sha },
      tests: ctx.cfg.tests ?? null,
      resolver: ctx.cfg.resolver ?? null,
      ...(ctx.cfg.layers ? { layers: ctx.cfg.layers } : {}),
      ...(ctx.title ? { intent: ctx.title } : {}),
      identity: { name: "weft-landing-queue", email: "landing@agents.weft.dev" },
      ...extra,
    },
  };
}

/** Evidence row for a rebase-ish job (rebase/land). */
function rebaseEvidence(r: JobResult) {
  return {
    status: r.status,
    layer: r.layer ?? null,
    onto: r.onto ?? null,
    head: r.head ?? null,
    rebased: r.rebased ?? null,
    commits: (r.commits ?? []).map((c) => ({ orig: c.orig, new: c.new, layer: c.layer })),
    ...(r.conflicts ? { conflicts: r.conflicts.map((c) => ({ file: c.file, commit: c.commit, hunks: c.hunks.length })) } : {}),
    ...(r.resolver ? { resolver: r.resolver } : {}),
    ...(r.diffstat ? { diffstat: r.diffstat } : {}),
    ...(r.pushed ? { pushed: r.pushed } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.timings ? { timings: r.timings } : {}),
    ...(r.run ? { run: r.run } : {}),
  };
}
function testEvidence(r: JobResult) {
  const t = r.tests!;
  return { status: t.status === "pass" ? ("pass" as const) : t.status === "fail" ? ("fail" as const) : ("info" as const), data: { ...t, onto: r.onto ?? null, sha: r.rebased ?? null } };
}

/**
 * `test_selection` evidence: selected vs total tests, the fallback reason, and time saved
 * against the repo's latest passing full-suite run (land presubmit or a full checkpoint run).
 */
export function selectionEvidence(t: TestsResult, baseline: { ms: number; tests: number | null; sha: string; kind: string } | null) {
  const s = t.selection!;
  const selected = s.mode === "full" ? (s.total ?? null) : s.files.length;
  const testsMs = t.ms ?? 0;
  const ranMs = testsMs + (s.ms ?? 0);
  const saved = s.mode === "subset" && baseline ? Math.max(0, baseline.ms - ranMs) : null;
  return {
    stage: "checkpoint" as "checkpoint" | "presubmit",
    mode: s.mode,
    reason: s.reason,
    selected,
    total: s.total,
    files: s.files,
    ...(s.why ? { why: s.why } : {}),
    writes: (s.writes ?? []).slice(0, 50),
    graph: s.graph ?? null,
    tests_ms: testsMs,
    select_ms: s.ms ?? null,
    baseline: baseline ? { ms: baseline.ms, tests: baseline.tests, sha: baseline.sha, kind: baseline.kind } : null,
    saved_ms: saved,
    saved_fraction: saved !== null && baseline && baseline.ms > 0 ? Math.round((saved / baseline.ms) * 1000) / 1000 : null,
  };
}

function evidenceHint(ctx: Ctx, x: XEvidence): string {
  const bits = [
    x.tests ? `tests ${x.tests.passed}/${x.tests.total}` : null,
    x.preview_url ? "preview" : null,
    x.screenshots.length ? `${x.screenshots.length} screenshot${x.screenshots.length === 1 ? "" : "s"}` : null,
    x.review ? `review ${x.review.verdict}${typeof x.review.score === "number" ? ` ${x.review.score}` : ""}` : null,
    x.risk ? `risk ${x.risk}` : null,
  ].filter(Boolean);
  return `evidence ${ctx.change.agent ?? short(ctx.change.id)}: ${bits.join(", ") || "recorded"}`;
}

async function bounce(deps: Deps, ctx: Ctx, text: string, hint: string): Promise<number | null> {
  const coord = deps.coord(ctx.change.repo);
  const rec = await coord.system({
    kind: "message",
    base_seq: await coord.headSeq(),
    change: ctx.change.id,
    task: ctx.change.task,
    payload: { to: { change: ctx.change.id }, text, intent: "steer" },
    summary_hint: hint.slice(0, 140),
  });
  return rec.seq;
}

// =============================================================================== ProcessRevision

export type ProcessRevisionResult = { status: "skipped" | "processed" | "conflict" | "failed"; reason?: string; layer?: string; rebased?: string; onto?: string; tests?: string; bounced_seq?: number | null };

export async function processRevision(p: ProcessRevisionParams, step: StepLike, deps: Deps, instance: string): Promise<ProcessRevisionResult> {
  const store = new Store(deps.db, deps.now);
  const loaded = await step.do("load change", async () => {
    const ctx = await loadCtx(store, p.repo, p.change);
    if ("skip" in ctx) return ctx;
    if (ctx.change.status !== "open") return { skip: `change is ${ctx.change.status}` };
    // Coalesce bursts: only the newest head of a change is processed.
    if (ctx.change.head_sha && ctx.change.head_sha !== p.sha) {
      await store.setRevision(p.change, p.sha, { status: "superseded", workflow_id: instance });
      return { skip: `superseded by ${short(ctx.change.head_sha)}` };
    }
    await store.setRevision(p.change, p.sha, { status: "processing", workflow_id: instance });
    return ctx;
  });
  if ("skip" in loaded) return { status: "skipped", reason: loaded.skip };
  const ctx = loaded;

  // Checkpoint feedback runs only the affected tests when the repo opts in (tests.select);
  // the task's risk tier goes along (high = full suite). LandChange never selects.
  const r = await runJob(step, deps, instance, "rebase", jobFor(ctx, "rebase", p.sha, { push_rebased: true, select: { risk: ctx.risk } }, { trunk: "read", fork: "write" }));
  const status = revisionStatus(r);

  await step.do("record evidence", async () => {
    // Time-saved baseline: the latest full-suite run BEFORE this one is recorded.
    const baseline = r.tests?.selection ? await store.lastFullSuite(p.repo) : null;
    await store.setRevision(p.change, p.sha, { status, onto_sha: r.onto ?? null, rebased_sha: r.rebased ?? null, layer: r.layer ?? null, processed: true });
    const ok = r.status === "up_to_date" || r.status === "clean" || r.status === "resolved";
    await store.evidence(p.change, p.sha, "rebase", ok ? "pass" : "fail", rebaseEvidence(r));
    if (r.tests) {
      const t = testEvidence(r);
      await store.evidence(p.change, p.sha, "test", t.status, t.data);
      if (r.tests.selection) await store.evidence(p.change, p.sha, "test_selection", "info", selectionEvidence(r.tests, baseline));
    }
    return null;
  });

  // B10: preview, screenshots + visual diff, risk, review (skipped for a failing candidate:
  // it is bounced and ineligible, so spending a browser + two model calls on it buys nothing).
  const rebasedOk = r.status === "up_to_date" || r.status === "clean" || r.status === "resolved";
  let x: XEvidence | null = null;
  if (rebasedOk && deps.evidence && r.tests?.status !== "fail") {
    x = (await collectEvidence(step, store, deps.evidence, { repo: p.repo, change: p.change, sha: p.sha, result: r, title: ctx.title, criteria: ctx.criteria ?? [], fork: ctx.change.fork, trunk: ctx.trunk.name })).x;
  }
  // Vendor fields on a checkpoint record of the change (Hérmes Changes feed, video): the
  // gateway keeps `payload` verbatim, so x_task_title / x_evidence ride inside it.
  if (rebasedOk || r.tests) {
    await step.do("stamp evidence", async () => {
      const coord = deps.coord(p.repo);
      const xe: XEvidence = x ?? { preview_url: null, tests: testsSummary(r.tests), screenshots: [], review: null, cost_usd: null };
      const rec = await coord.system({
        kind: "checkpoint",
        base_seq: await coord.headSeq(),
        change: p.change,
        task: ctx.change.task,
        payload: { sha: p.sha, ref: "refs/weft/evidence", ...(ctx.title ? { x_task_title: ctx.title } : {}), x_evidence: xe },
        summary_hint: evidenceHint(ctx, xe).slice(0, 140),
      });
      return rec.seq;
    });
  }

  let bounced: number | null = null;
  if (r.status === "conflict")
    bounced = await step.do("bounce conflict to agent", () => bounce(deps, ctx, bounceText("conflict", r), `rebase conflict: ${(r.conflicts ?? []).map((c) => c.file).join(", ")}`));
  else if (r.tests?.status === "fail") bounced = await step.do("bounce failing tests to agent", () => bounce(deps, ctx, bounceText("tests", r), `tests fail after rebase onto ${short(r.onto)}`));

  await step.do("notify selection", async () => {
    await deps.launch.candidateReady(p.repo, ctx.change.task, { change: p.change, sha: p.sha, status }).catch(() => undefined);
    return null;
  });
  return {
    status,
    ...(r.layer ? { layer: r.layer } : {}),
    ...(r.rebased ? { rebased: r.rebased } : {}),
    ...(r.onto ? { onto: r.onto } : {}),
    ...(r.tests ? { tests: r.tests.status } : {}),
    ...(r.error ? { reason: r.error } : {}),
    bounced_seq: bounced,
  };
}

// =============================================================================== LandChange

export type BatchSummary = {
  /** Queue id of the leader whose workflow landed the batch. */
  leader: number;
  size: number;
  rounds?: number;
  presubmit_runs?: number;
  /** Presubmit runs a one-at-a-time queue would have done minus the runs this batch did. */
  presubmit_runs_saved?: number;
  bisect_steps?: number;
  landed?: string[];
  culprits?: string[];
  conflicts?: string[];
};
export type LandChangeResult = { status: "landed" | "already_landed" | "failed" | "skipped"; reason?: string; op_id?: string; seq?: number | null; before?: string; after?: string; layer?: string; attempts?: number; queue_id?: number; batch?: BatchSummary };

const MAX_LAND_ATTEMPTS = 3;

/** Batch policy for the land queue (RepoConfig.land.batch). null = one change per presubmit. */
export function batchConfig(cfg: RepoConfig): { max: number; wait_s: number } | null {
  const b = cfg.land?.batch;
  if (b === false) return null;
  const max = Math.max(1, Math.min(16, Math.floor(Number(b?.max ?? 4)) || 4));
  const wait_s = Math.max(0, Math.min(600, Number(b?.wait_s ?? 30) || 0));
  return max >= 2 ? { max, wait_s } : null;
}

export async function landChange(p: LandChangeParams, step: StepLike, deps: Deps, instance: string): Promise<LandChangeResult> {
  const store = new Store(deps.db, deps.now);
  const loaded = await step.do("load change", async () => {
    const ctx = await loadCtx(store, p.repo, p.change);
    if ("skip" in ctx) return ctx;
    if (ctx.change.status === "landed") return { skip: "already_landed" };
    if (ctx.change.status !== "open") return { skip: `change is ${ctx.change.status}` };
    if (!ctx.change.head_sha) return { skip: "change has no pushed revision" };
    const rev = await store.revision(ctx.change.id, ctx.change.head_sha);
    return { ...ctx, rebased: rev?.rebased_sha && rev.onto_sha && rev.status === "processed" ? { sha: rev.rebased_sha, onto: rev.onto_sha, layer: rev.layer } : null };
  });
  if ("skip" in loaded) return loaded.skip === "already_landed" ? { status: "already_landed" } : { status: "skipped", reason: loaded.skip };
  const ctx = loaded;
  const coord = deps.coord(p.repo);

  // 1. Submit queue (the repo DO serializes landings): wait for our turn. A batch leader ahead
  //    of us may claim our entry (`batch` = its id): then we wait for its outcome instead.
  const entry = await step.do("enqueue", () => coord.enqueue(p.change, p.requested_by, p.note ?? `workflow ${instance}`));
  const qp = deps.queuePoll ?? { interval: "10 seconds", max: 360 };
  for (let i = 0; ; i++) {
    const head = await step.do(`queue turn ${i}`, async () => {
      const q = await coord.queue(["queued", "landing"]);
      const mine = q.find((e) => e.id === entry.id);
      if (!mine) {
        const done = (await coord.queue(["landed", "failed", "cancelled"])).find((e) => e.id === entry.id) ?? null;
        return { gone: true, first: null as number | null, claimed: null as number | null, done };
      }
      return { gone: false, first: q[0]?.id ?? null, claimed: mine.batch !== undefined && mine.batch !== null && mine.batch !== entry.id ? mine.batch : null, done: null };
    });
    if (head.gone) {
      const d = head.done as QueueEntry | null;
      if (d && d.batch !== undefined && d.batch !== null && d.batch !== entry.id) return step.do("batch outcome", () => batchOutcome(store, coord, p, d));
      return { status: "failed", reason: "queue entry was cancelled", queue_id: entry.id };
    }
    if (head.first === entry.id && head.claimed === null) break;
    if (i >= qp.max) {
      // A claimed entry belongs to its leader's workflow: leave its status alone.
      if (head.claimed !== null) return { status: "failed", reason: `timed out waiting for batch leader #${head.claimed}`, queue_id: entry.id, batch: { leader: head.claimed, size: 0 } };
      await step.do("queue timeout", () => coord.setQueueStatus(entry.id, "failed", "timed out waiting for the queue"));
      return { status: "failed", reason: "timed out waiting for the landing queue", queue_id: entry.id };
    }
    await step.sleep(`queue wait ${i}`, qp.interval);
  }
  await step.do("mark landing", () => coord.setQueueStatus(entry.id, "landing", `workflow ${instance}`));

  // 1b. Batched landing: with 2+ changes queued, the head lands up to `max` of them together.
  const bcfg = batchConfig(ctx.cfg);
  if (bcfg) {
    const members = await collectBatch(step, deps, store, p, entry.id, bcfg, instance);
    if (members.length > 1) return landBatch(step, deps, store, p, entry.id, members, instance);
  }

  // 2. Final rebase + presubmit + CAS push (retry when another landing won the race).
  let r: JobResult = { status: "error", error: "not run" };
  let attempt = 0;
  for (attempt = 1; attempt <= MAX_LAND_ATTEMPTS; attempt++) {
    r = await runJob(step, deps, instance, `land ${attempt}`, jobFor(ctx, "land", ctx.change.head_sha!, attempt === 1 && ctx.rebased ? { rebased: ctx.rebased } : {}, { trunk: "write", fork: "read" }));
    if (r.status !== "stale_trunk") break;
  }
  const sha = ctx.change.head_sha!;

  if (r.status !== "landed") {
    const reason = r.status === "tests_failed" ? "presubmit failed" : r.status === "conflict" ? "rebase conflict" : r.status === "stale_trunk" ? `trunk kept moving (${MAX_LAND_ATTEMPTS} attempts)` : (r.error ?? r.detail ?? r.status);
    await step.do("record failure", async () => {
      await store.evidence(p.change, sha, "land", "fail", { ...rebaseEvidence(r), attempts: attempt, reason });
      if (r.tests) {
        const t = testEvidence(r);
        await store.evidence(p.change, sha, "presubmit", t.status, t.data);
        if (r.tests.selection) await store.evidence(p.change, sha, "test_selection", "info", { ...selectionEvidence(r.tests, null), stage: "presubmit" });
      }
      await coord.setQueueStatus(entry.id, "failed", reason.slice(0, 300));
      return null;
    });
    if (r.status === "conflict") await step.do("bounce conflict to agent", () => bounce(deps, ctx, bounceText("conflict", r), "landing blocked: rebase conflict"));
    else if (r.status === "tests_failed") await step.do("bounce failing presubmit to agent", () => bounce(deps, ctx, bounceText("tests", r), "landing blocked: presubmit fails"));
    return { status: "failed", reason, attempts: attempt, queue_id: entry.id, ...(r.layer ? { layer: r.layer } : {}) };
  }

  // 3. Op log: `land` in the repo DO (releases claims, marks the queue entry, tells other agents).
  const logged = await step.do("append land", async () => {
    const opId = await landOpId(p.repo, p.change, r.after!);
    const existing = (await coord.ops()).find((o) => o.op_id === opId);
    if (existing) return { op_id: opId, seq: existing.seq, status: "accepted" };
    const xe = xEvidenceFromRows(await store.evidenceFor(p.change, sha));
    const tests = testsSummary(r.tests);
    if (tests) xe.tests = tests;
    const rec = await coord.system({
      kind: "land",
      base_seq: await coord.headSeq(),
      change: p.change,
      task: ctx.change.task,
      payload: { sha: r.after!, op_id: opId, trunk_ref: `refs/heads/${ctx.trunk.branch}`, ...(ctx.title ? { x_task_title: ctx.title } : {}), x_evidence: xe },
      summary_hint: `landed ${ctx.change.agent ?? short(p.change)}: ${ctx.title ?? ctx.change.task} (${short(r.after)})`.slice(0, 140),
    });
    return { op_id: opId, seq: rec.seq, status: rec.status };
  });

  // 4. Close the card: change landed, task landed, sibling candidates closed, evidence.
  await step.do("close task", async () => {
    await store.recordLanding({ op_id: logged.op_id, repo: p.repo, kind: "land", change_id: p.change, task: ctx.change.task, before: r.before!, after: r.after!, seq: logged.seq, status: "landed", layer: r.layer ?? null, requested_by: p.requested_by, workflow_id: instance });
    await store.evidence(p.change, sha, "land", "pass", { ...rebaseEvidence(r), op_id: logged.op_id, seq: logged.seq, before: r.before, after: r.after, attempts: attempt });
    if (r.tests) {
      const t = testEvidence(r);
      await store.evidence(p.change, sha, "presubmit", t.status, t.data);
      if (r.tests.selection) await store.evidence(p.change, sha, "test_selection", "info", { ...selectionEvidence(r.tests, null), stage: "presubmit" });
    }
    await store.setChangeStatus(p.change, "landed");
    await store.setTaskStatus(p.repo, ctx.change.task, "landed");
    await store.closeSiblings(p.repo, ctx.change.task, p.change);
    if (logged.status !== "accepted") await coord.setQueueStatus(entry.id, "landed", `git landed ${short(r.after)}; land record ${logged.status}`);
    return null;
  });
  return { status: "landed", op_id: logged.op_id, seq: logged.seq, before: r.before!, after: r.after!, ...(r.layer ? { layer: r.layer } : {}), attempts: attempt, queue_id: entry.id };
}

// ------------------------------------------------------------------------------- batched landing

type LandCtx = Ctx & { rebased: { sha: string; onto: string; layer: string | null } | null };
type Member = { id: number; ctx: LandCtx };

async function loadLandCtx(store: Store, repo: string, changeId: string): Promise<LandCtx | null> {
  const ctx = await loadCtx(store, repo, changeId);
  if ("skip" in ctx || ctx.change.status !== "open" || !ctx.change.head_sha) return null;
  const rev = await store.revision(ctx.change.id, ctx.change.head_sha);
  return { ...ctx, rebased: rev?.rebased_sha && rev.onto_sha && rev.status === "processed" ? { sha: rev.rebased_sha, onto: rev.onto_sha, layer: rev.layer } : null };
}

/**
 * The queue head collects the queued entries behind it (queue order, up to `max` in all).
 * A lone change never waits; with company it lingers up to `wait_s` for the batch to fill.
 * Then it claims them in the repo DO (atomic: only still-`queued`, unclaimed entries).
 */
async function collectBatch(step: StepLike, deps: Deps, store: Store, p: LandChangeParams, leader: number, cfg: { max: number; wait_s: number }, instance: string): Promise<Member[]> {
  const coord = deps.coord(p.repo);
  const t0 = await step.do("batch: start", async () => deps.now());
  let cands: Array<{ id: number; change: string }> = [];
  for (let k = 0; ; k++) {
    cands = await step.do(`batch: collect ${k}`, async () =>
      (await coord.queue(["queued"]))
        .filter((e) => e.id > leader && (e.batch ?? null) === null && e.change !== p.change)
        .slice(0, cfg.max - 1)
        .map((e) => ({ id: e.id, change: e.change })),
    );
    if (!cands.length || cands.length >= cfg.max - 1) break;
    const now = await step.do(`batch: clock ${k}`, async () => deps.now());
    if (now - t0 >= cfg.wait_s * 1000) break;
    await step.sleep(`batch: linger ${k}`, deps.batchPoll ?? "5 seconds");
  }
  if (!cands.length) return [];
  return step.do("batch: claim", async () => {
    const lead = await loadLandCtx(store, p.repo, p.change);
    if (!lead) return [];
    const ok: Member[] = [];
    for (const c of cands) {
      const ctx = await loadLandCtx(store, p.repo, c.change);
      if (ctx) ok.push({ id: c.id, ctx });
    }
    if (!ok.length) return [];
    const claimed = await coord.claimBatch(leader, ok.map((m) => m.id), `batch #${leader} (workflow ${instance})`);
    const got = new Set(claimed.filter((e) => e.batch === leader && e.status === "landing").map((e) => e.id));
    return [{ id: leader, ctx: lead }, ...ok.filter((m) => got.has(m.id))];
  });
}

function batchJobFor(members: Member[]): JobRequest {
  const lead = members[0]!.ctx;
  return {
    repo: lead.change.repo,
    task: lead.change.task,
    change: lead.change.id,
    config: lead.cfg,
    trunk: { ...lead.trunk, access: "write" },
    forks: members.map((m) => ({ name: m.ctx.change.fork, remote: m.ctx.change.remote, branch: m.ctx.change.default_branch, access: "read" as const })),
    spec: {
      job: "land_batch",
      trunk: { remote: lead.trunk.remote, branch: lead.trunk.branch },
      changes: members.map((m) => ({
        change: m.ctx.change.id,
        remote: m.ctx.change.remote,
        branch: m.ctx.change.default_branch,
        sha: m.ctx.change.head_sha,
        ...(m.ctx.title ? { intent: m.ctx.title } : {}),
        ...(m.ctx.rebased ? { rebased: m.ctx.rebased } : {}),
      })),
      tests: lead.cfg.tests ?? null,
      resolver: lead.cfg.resolver ?? null,
      ...(lead.cfg.layers ? { layers: lead.cfg.layers } : {}),
      identity: { name: "weft-landing-queue", email: "landing@agents.weft.dev" },
    },
  };
}

function itemEvidence(it: BatchItemResult) {
  return {
    status: it.status,
    layer: it.layer ?? null,
    head: it.head ?? null,
    before: it.before ?? null,
    after: it.after ?? null,
    commits: it.commits ?? [],
    ...(it.conflicts ? { conflicts: it.conflicts.map((c) => ({ file: c.file, commit: c.commit, hunks: c.hunks.length })) } : {}),
    ...(it.resolver ? { resolver: it.resolver } : {}),
    ...(it.diffstat ? { diffstat: it.diffstat } : {}),
  };
}

/**
 * Land a claimed batch (leader first, then queue order). Each round is one `land_batch` job:
 * stack, one presubmit, bisect on failure, one CAS push of the passing prefix. Landed changes
 * get their own `land` op (own before/after: revertable alone), a conflict or the culprit is
 * bounced to its agent with the evidence, and the changes after the culprit go again in the
 * next round (re-stacked without it). Stale trunk retries the round, as for a single landing.
 */
async function landBatch(step: StepLike, deps: Deps, store: Store, p: LandChangeParams, leader: number, members: Member[], instance: string): Promise<LandChangeResult> {
  const coord = deps.coord(p.repo);
  const sum: Required<BatchSummary> = { leader, size: members.length, rounds: 0, presubmit_runs: 0, presubmit_runs_saved: 0, bisect_steps: 0, landed: [], culprits: [], conflicts: [] };
  const outcome = new Map<string, { status: "landed" | "failed"; reason?: string; op_id?: string; seq?: number | null; before?: string; after?: string; layer?: string }>();
  let pending = members;
  let attemptsTotal = 0;
  while (pending.length) {
    const round = ++sum.rounds;
    let r: JobResult = { status: "error", error: "not run" };
    let attempt = 0;
    for (attempt = 1; attempt <= MAX_LAND_ATTEMPTS; attempt++) {
      r = await runJob(step, deps, instance, `batch ${round} land ${attempt}`, batchJobFor(pending), { pollScale: 1 + Math.ceil(Math.log2(pending.length)) });
      if (r.status !== "stale_trunk") break;
    }
    attemptsTotal += attempt;
    const items = r.items ?? [];
    const runs = r.batch?.presubmit_runs ?? 0;
    sum.presubmit_runs += runs;
    sum.bisect_steps += r.batch?.bisect_steps ?? 0;
    const pushed = r.status === "landed" || r.status === "noop";
    const tested = items.filter((i) => (i.status === "landed" && pushed) || i.status === "culprit").length;
    sum.presubmit_runs_saved += tested - runs;

    // The whole round failed outright (job error, trunk kept moving, push rejected): every
    // pending change fails with the same reason, like a failed single landing.
    if (!pushed && !items.some((i) => i.status === "culprit" || i.status === "conflict")) {
      const reason = r.status === "stale_trunk" ? `trunk kept moving (${MAX_LAND_ATTEMPTS} attempts)` : (r.error ?? r.detail ?? r.status);
      await step.do(`batch ${round}: record failure`, async () => {
        for (const m of pending) {
          await store.evidence(m.ctx.change.id, m.ctx.change.head_sha!, "land", "fail", { reason, attempts: attempt, batch: { leader, round, size: pending.length }, ...rebaseEvidence(r) });
          await coord.setQueueStatus(m.id, "failed", `batch #${leader}: ${reason}`.slice(0, 300));
        }
        metric(deps, p.repo, "failed", leader, { round, size: pending.length, runs, bisect: r.batch?.bisect_steps ?? 0, landed: 0, culprits: 0, conflicts: 0 });
        return null;
      });
      for (const m of pending) outcome.set(m.ctx.change.id, { status: "failed", reason });
      break;
    }

    // Landed: one op per change, in stack order.
    for (const it of items.filter((i) => i.status === "landed" && pushed)) {
      const m = pending.find((x) => x.ctx.change.id === it.change)!;
      const ctx = m.ctx;
      const sha = ctx.change.head_sha!;
      const position = members.findIndex((x) => x.id === m.id) + 1;
      const info = { leader, round, position, size: members.length, round_size: pending.length, presubmit_runs: runs, bisect_steps: r.batch?.bisect_steps ?? 0, tested: r.batch?.tested ?? [] };
      const logged = await step.do(`batch ${round}: append land ${short(it.change)}`, async () => {
        const opId = await landOpId(p.repo, it.change, it.after!);
        const existing = (await coord.ops()).find((o) => o.op_id === opId);
        if (existing) return { op_id: opId, seq: existing.seq, status: "accepted" };
        const xe = xEvidenceFromRows(await store.evidenceFor(it.change, sha));
        const tests = testsSummary(r.passing_tests);
        if (tests) xe.tests = tests;
        const rec = await coord.system({
          kind: "land",
          base_seq: await coord.headSeq(),
          change: it.change,
          task: ctx.change.task,
          payload: { sha: it.after!, op_id: opId, trunk_ref: `refs/heads/${ctx.trunk.branch}`, ...(ctx.title ? { x_task_title: ctx.title } : {}), x_evidence: xe, x_batch: { leader, position, size: members.length, round } },
          summary_hint: `landed ${ctx.change.agent ?? short(it.change)}: ${ctx.title ?? ctx.change.task} (${short(it.after)}, batch of ${pending.length})`.slice(0, 140),
        });
        return { op_id: opId, seq: rec.seq, status: rec.status };
      });
      await step.do(`batch ${round}: close ${short(it.change)}`, async () => {
        await store.recordLanding({ op_id: logged.op_id, repo: p.repo, kind: "land", change_id: it.change, task: ctx.change.task, before: it.before!, after: it.after!, seq: logged.seq, status: "landed", layer: it.layer ?? null, requested_by: p.requested_by, workflow_id: instance });
        await store.evidence(it.change, sha, "land", "pass", { ...itemEvidence(it), op_id: logged.op_id, seq: logged.seq, attempts: attempt, batch: info });
        if (r.passing_tests) {
          const t = testEvidence({ ...r, tests: r.passing_tests, rebased: it.after! });
          await store.evidence(it.change, sha, "presubmit", t.status, { ...t.data, batch: info });
        }
        await store.setChangeStatus(it.change, "landed");
        await store.setTaskStatus(p.repo, ctx.change.task, "landed");
        await store.closeSiblings(p.repo, ctx.change.task, it.change);
        if (logged.status !== "accepted") await coord.setQueueStatus(m.id, "landed", `git landed ${short(it.after)} in batch #${leader}; land record ${logged.status}`);
        return null;
      });
      sum.landed.push(it.change);
      outcome.set(it.change, { status: "landed", op_id: logged.op_id, seq: logged.seq, before: it.before!, after: it.after!, ...(it.layer ? { layer: it.layer } : {}) });
    }

    // Bounced: conflicts (dropped from the stack) and the culprit bisect isolated.
    for (const it of items.filter((i) => i.status === "conflict" || i.status === "culprit")) {
      const m = pending.find((x) => x.ctx.change.id === it.change)!;
      const ctx = m.ctx;
      const sha = ctx.change.head_sha!;
      const culprit = it.status === "culprit";
      const reason = culprit ? `presubmit failed (isolated by bisect in a batch of ${pending.length})` : "rebase conflict (while stacking a batch)";
      await step.do(`batch ${round}: record ${it.status} ${short(it.change)}`, async () => {
        await store.evidence(it.change, sha, "land", "fail", { ...itemEvidence(it), reason, batch: { leader, round, size: pending.length, tested: r.batch?.tested ?? [], bisect_steps: r.batch?.bisect_steps ?? 0 } });
        if (culprit && r.culprit_tests) {
          const t = testEvidence({ ...r, tests: r.culprit_tests, rebased: it.after! });
          await store.evidence(it.change, sha, "presubmit", t.status, { ...t.data, batch: { leader, round } });
        }
        await coord.setQueueStatus(m.id, "failed", reason.slice(0, 300));
        return null;
      });
      const text = culprit
        ? bounceText("tests", { tests: r.culprit_tests!, onto: it.before! })
        : bounceText("conflict", { conflicts: it.conflicts ?? [], onto: it.before ?? r.onto!, ...(it.layer ? { layer: it.layer } : {}), ...(it.resolver ? { resolver: it.resolver } : {}) });
      await step.do(`batch ${round}: bounce ${short(it.change)}`, () => bounce(deps, ctx, text, culprit ? "landing blocked: presubmit fails (bisect)" : "landing blocked: rebase conflict"));
      (culprit ? sum.culprits : sum.conflicts).push(it.change);
      outcome.set(it.change, { status: "failed", reason, ...(it.layer ? { layer: it.layer } : {}) });
    }

    const landedN = items.filter((i) => i.status === "landed" && pushed).length;
    await step.do(`batch ${round}: metrics`, async () => {
      metric(deps, p.repo, "ok", leader, { round, size: pending.length, runs, bisect: r.batch?.bisect_steps ?? 0, landed: landedN, culprits: items.filter((i) => i.status === "culprit").length, conflicts: items.filter((i) => i.status === "conflict").length });
      return null;
    });
    const next = pending.filter((m) => items.find((i) => i.change === m.ctx.change.id)?.status === "pending" || (!pushed && items.find((i) => i.change === m.ctx.change.id)?.status === "landed"));
    if (next.length === pending.length) {
      // No progress (should not happen): fail the rest rather than loop.
      await step.do(`batch ${round}: stuck`, async () => {
        for (const m of next) await coord.setQueueStatus(m.id, "failed", `batch #${leader}: no progress in round ${round}`);
        return null;
      });
      for (const m of next) outcome.set(m.ctx.change.id, { status: "failed", reason: "batch made no progress" });
      break;
    }
    pending = next;
  }

  const mine = outcome.get(p.change) ?? { status: "failed" as const, reason: "not landed by its batch" };
  return { ...mine, attempts: attemptsTotal, queue_id: leader, batch: sum };
}

/** Workers Analytics Engine point per batch round (no-op without the binding). */
function metric(deps: Deps, repo: string, outcome: string, leader: number, m: { round: number; size: number; runs: number; bisect: number; landed: number; culprits: number; conflicts: number }) {
  try {
    deps.metrics?.writeDataPoint({
      indexes: [repo],
      blobs: ["land.batch", outcome, `#${leader}`],
      // round size, presubmit runs, presubmit runs saved (vs one presubmit per tested change), bisect steps, landed, culprits, conflicts, round
      doubles: [m.size, m.runs, m.landed + m.culprits - m.runs, m.bisect, m.landed, m.culprits, m.conflicts, m.round],
    });
  } catch {
    /* metrics are best effort */
  }
}

/** A follower's result once its batch leader has landed (or bounced) it. */
async function batchOutcome(store: Store, coord: ReturnType<Deps["coord"]>, p: LandChangeParams, d: QueueEntry): Promise<LandChangeResult> {
  const batch = { leader: d.batch!, size: 0 };
  if (d.status !== "landed") return { status: "failed", reason: d.note ?? `${d.status} in batch #${d.batch}`, queue_id: d.id, batch };
  const op = (await coord.ops()).filter((o) => o.kind === "land" && o.change_id === p.change).pop();
  const landing = op ? await store.landing(op.op_id) : null;
  return { status: "landed", queue_id: d.id, batch, ...(op ? { op_id: op.op_id, seq: op.seq } : {}), ...(landing ? { before: landing.before_sha ?? undefined, after: landing.after_sha ?? undefined } : op?.sha ? { after: op.sha } : {}) };
}

// =============================================================================== RevertOperation

export type RevertResult = { status: "reverted" | "already_reverted" | "failed"; reason?: string; op_id?: string; reverts_op_id?: string; seq?: number; sha?: string };

export async function revertOperation(p: RevertOperationParams, step: StepLike, deps: Deps, instance: string): Promise<RevertResult> {
  const store = new Store(deps.db, deps.now);
  const coord = deps.coord(p.repo);
  const target = await step.do("find op", async () => {
    const ops = await coord.ops();
    const op = ops.find((o) => o.kind === "land" && (p.op_id ? o.op_id === p.op_id : o.seq === p.seq));
    if (!op) return { missing: `no land op ${p.op_id ?? `#${p.seq}`} in the op log` };
    if (ops.some((o) => o.kind === "revert" && (o.reverts_op_id === op.op_id || o.reverts_seq === op.seq))) return { done: op.op_id };
    const landing = await store.landing(op.op_id);
    const trunk = await store.trunk(p.repo);
    if (!trunk) return { missing: `repo ${p.repo} has no Artifacts trunk` };
    const change = op.change_id ? await store.change(p.repo, op.change_id) : null;
    return { op, before: landing?.before_sha ?? null, after: landing?.after_sha ?? op.sha!, trunk: { name: trunk.trunk, remote: trunk.remote, branch: trunk.default_branch }, cfg: trunk.cfg, task: change?.task ?? landing?.task ?? null, agent: change?.agent ?? null };
  });
  if ("missing" in target) return { status: "failed", reason: target.missing };
  if ("done" in target) return { status: "already_reverted", reverts_op_id: target.done };

  let r: JobResult = { status: "error" };
  for (let attempt = 1; attempt <= MAX_LAND_ATTEMPTS; attempt++) {
    r = await runJob(step, deps, instance, `revert ${attempt}`, {
      repo: p.repo,
      task: target.task ?? "revert",
      change: target.op.change_id ?? "revert",
      config: target.cfg,
      trunk: { ...target.trunk, access: "write" },
      spec: {
        job: "revert",
        trunk: { remote: target.trunk.remote, branch: target.trunk.branch },
        revert: { before: target.before, after: target.after, op_id: target.op.op_id, change: target.op.change_id, reason: p.reason },
        layers: ["git", "mergiraf"],
        identity: { name: "weft-revert", email: "revert@agents.weft.dev" },
      },
    });
    if (r.status !== "stale_trunk") break;
  }
  if (r.status !== "reverted") {
    const reason = r.status === "conflict" ? `revert conflicts with later trunk changes in ${(r.conflicts ?? []).map((c) => c.file).join(", ")}` : (r.error ?? r.detail ?? r.status);
    await step.do("record failure", async () => {
      if (target.op.change_id) await store.evidence(target.op.change_id, target.after, "revert", "fail", { reason, requested: p.reason, op_id: target.op.op_id, ...rebaseEvidence(r) });
      return null;
    });
    return { status: "failed", reason };
  }

  const logged = await step.do("append revert", async () => {
    const opId = await revertOpId(p.repo, target.op.op_id, r.after!);
    const existing = (await coord.ops()).find((o) => o.op_id === opId);
    if (existing) return { op_id: opId, seq: existing.seq };
    const rec = await coord.system({
      kind: "revert",
      base_seq: await coord.headSeq(),
      ...(target.op.change_id ? { change: target.op.change_id } : {}),
      ...(target.task ? { task: target.task } : {}),
      payload: { op_id: opId, reverts_op_id: target.op.op_id, reverts_seq: target.op.seq, sha: r.after!, reason: p.reason, ...(p.requested_by ? { requested_by: { type: p.requested_by_type ?? "human", id: p.requested_by } } : {}) },
      summary_hint: `reverted #${target.op.seq}: ${p.reason}`.slice(0, 140),
    });
    return { op_id: opId, seq: rec.seq };
  });

  await step.do("reopen task", async () => {
    await store.recordLanding({ op_id: logged.op_id, repo: p.repo, kind: "revert", change_id: target.op.change_id, task: target.task, before: r.before!, after: r.after!, seq: logged.seq, status: "done", requested_by: p.requested_by ?? null, workflow_id: instance, reverts_op_id: target.op.op_id, reason: p.reason });
    await store.setLandingStatus(target.op.op_id, "reverted");
    if (target.op.change_id) {
      await store.setChangeStatus(target.op.change_id, "reverted");
      await store.evidence(target.op.change_id, target.after, p.evidence?.kind ?? "revert", "fail", { reason: p.reason, op_id: logged.op_id, reverts_op_id: target.op.op_id, revert_sha: r.after, requested_by: p.requested_by ?? null, ...(p.evidence ? { evidence: p.evidence } : {}) }, p.evidence?.uri);
    }
    if (target.task) await store.setTaskStatus(p.repo, target.task, "open");
    return null;
  });
  if (target.op.change_id) {
    const change = await step.do("load reverted change", () => store.change(p.repo, target.op.change_id!));
    if (change)
      await step.do("tell the agent", () =>
        bounce(deps, { change, trunk: target.trunk, cfg: target.cfg, title: null, risk: "medium" }, bounceText("revert", { reason: p.reason, ...(p.evidence?.text ? { evidence: p.evidence.text } : {}) }), `reverted: ${p.reason}`),
      );
  }
  return { status: "reverted", op_id: logged.op_id, reverts_op_id: target.op.op_id, seq: logged.seq, sha: r.after! };
}

// =============================================================================== BestOfN

export type BestOfNResult = { status: "landing" | "approval_timeout" | "no_candidates" | "rejected"; winner?: string; ranking?: Ranked[]; approved_by?: string; land_instance?: string; waited?: number };

export async function bestOfN(p: BestOfNParams, step: StepLike, deps: Deps, instance: string): Promise<BestOfNResult> {
  const store = new Store(deps.db, deps.now);
  const t0 = await step.do("start", async () => ({ at: deps.now(), risk: p.risk ?? (await store.task(p.repo, p.task))?.risk ?? "low" }));
  const deadline = t0.at + (p.collect_timeout_s ?? 7200) * 1000;
  const poll = `${p.poll_s ?? 60} seconds` as const;

  // 1. Wait until N candidates are processed (or all open ones are, or the deadline passes).
  let snapshot = await step.do("collect 0", () => store.candidates(p.repo, p.task));
  let i = 0;
  const settled = (s: typeof snapshot) => s.filter((c) => c.revision && ["processed", "conflict", "failed"].includes(c.revision.status));
  // N candidates = N settled revisions (processed, or bounced as conflict/failed): a bounced one is ranked ineligible.
  while (settled(snapshot).length < p.n) {
    const now = await step.do(`clock ${i}`, async () => deps.now());
    if (now >= deadline) break;
    try {
      await step.waitForEvent(`candidate ${i}`, { type: "candidate", timeout: poll });
    } catch {
      /* timeout: re-check D1 (events may arrive before the instance waits) */
    }
    i++;
    snapshot = await step.do(`collect ${i}`, () => store.candidates(p.repo, p.task));
  }

  // 2. Rank.
  const ranking = rank(snapshot);
  await step.do("record ranking", async () => {
    let pos = 0;
    for (const r of ranking) {
      const c = snapshot.find((x) => x.change === r.change)!;
      if (c.head) await store.evidence(r.change, c.head, "rank", r.eligible ? "info" : "fail", { position: ++pos, of: ranking.length, score: r.score, reasons: r.reasons, eligible: r.eligible, risk: t0.risk, workflow: instance });
    }
    return null;
  });
  const eligible = ranking.filter((r) => r.eligible);
  if (!eligible.length) return { status: "no_candidates", ranking, waited: i };

  // 3. Risk tier: low lands the top candidate; medium/high wait for a human approve. A top
  //    candidate that only rebased through the resolver agent (an LLM merged code) always does.
  let winner = eligible[0]!.change;
  let approvedBy: string | undefined;
  // B10: the classified risk of the top candidate (heuristic + Workers AI) can raise the tier,
  // and a review agent that did not pass it asks for a human too.
  const top = snapshot.find((c) => c.change === eligible[0]!.change);
  const topRisk = maxRisk(t0.risk as "low" | "medium" | "high", (top?.risk?.data?.risk as "low" | "medium" | "high" | undefined) ?? null);
  const reviewVerdict = top?.review?.data?.verdict as string | undefined;
  if (needsApproval(topRisk) || eligible[0]!.layer === "resolver" || (reviewVerdict !== undefined && reviewVerdict !== "pass")) {
    let ev: { payload: { change?: string; by?: string; reject?: boolean } };
    try {
      ev = await step.waitForEvent<{ change?: string; by?: string; reject?: boolean }>("approval", { type: "approve", timeout: `${p.approval_timeout_s ?? 86_400} seconds` });
    } catch {
      return { status: "approval_timeout", ranking, waited: i };
    }
    if (ev.payload.reject) return { status: "rejected", ranking, ...(ev.payload.by ? { approved_by: ev.payload.by } : {}), waited: i };
    if (ev.payload.change && ranking.some((r) => r.change === ev.payload.change)) winner = ev.payload.change;
    approvedBy = ev.payload.by ?? "human";
  }

  // 4. Land it.
  const land = await step.do("start landing", () => deps.launch.land({ repo: p.repo, change: winner, requested_by: approvedBy ? `human:${approvedBy}` : `workflow:${instance}`, note: `best-of-${p.n} winner` }));
  return { status: "landing", winner, ranking, ...(approvedBy ? { approved_by: approvedBy } : {}), land_instance: land, waited: i };
}

export { ids } from "./ids";
