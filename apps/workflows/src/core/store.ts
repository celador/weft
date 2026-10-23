// D1 access for the workflows (tables from apps/gateway/migrations 0001 + 0002).

import type { ChangeRow, D1Like, JobResult, RepoConfig, RevisionRow, Risk, TrunkRow } from "./types";

export class Store {
  constructor(
    private readonly db: D1Like,
    private readonly now: () => number,
  ) {}

  async change(repo: string, id: string): Promise<ChangeRow | null> {
    return this.db.prepare(`SELECT * FROM changes WHERE id = ? AND repo = ?`).bind(id, repo).first<ChangeRow>();
  }

  async trunk(repo: string): Promise<(TrunkRow & { cfg: RepoConfig }) | null> {
    const t = await this.db.prepare(`SELECT repo, namespace, trunk, default_branch, remote, config FROM artifacts_repos WHERE repo = ?`).bind(repo).first<TrunkRow>();
    if (!t) return null;
    let cfg: RepoConfig = {};
    try {
      cfg = t.config ? (JSON.parse(t.config) as RepoConfig) : {};
    } catch {
      cfg = {};
    }
    return { ...t, cfg };
  }

  async task(repo: string, id: string): Promise<{ id: string; title: string | null; status: string; risk: Risk; criteria: string[] } | null> {
    const t = await this.db.prepare(`SELECT id, title, status, risk, acceptance FROM tasks WHERE repo = ? AND id = ?`).bind(repo, id).first<{ id: string; title: string | null; status: string; risk: Risk; acceptance: string | null }>();
    if (!t) return null;
    let criteria: string[] = [];
    try {
      const v = t.acceptance ? (JSON.parse(t.acceptance) as unknown) : [];
      criteria = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      criteria = [];
    }
    return { id: t.id, title: t.title, status: t.status, risk: t.risk, criteria };
  }

  async revision(change: string, sha: string): Promise<RevisionRow | null> {
    return this.db.prepare(`SELECT change_id, sha, status, seq, onto_sha, rebased_sha, layer, received_at, processed_at FROM revisions WHERE change_id = ? AND sha = ?`).bind(change, sha).first<RevisionRow>();
  }

  async setRevision(change: string, sha: string, f: { status: string; onto_sha?: string | null; rebased_sha?: string | null; layer?: string | null; workflow_id?: string; processed?: boolean }): Promise<void> {
    // Upsert: the workflow may run for a sha the queue consumer has not recorded (manual trigger).
    await this.db
      .prepare(
        `INSERT INTO revisions (change_id, sha, ref, before_sha, commits, status, received_at, onto_sha, rebased_sha, layer, workflow_id, processed_at)
         VALUES (?, ?, 'refs/heads/main', '', 0, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (change_id, sha) DO UPDATE SET status = excluded.status,
           onto_sha = COALESCE(excluded.onto_sha, revisions.onto_sha), rebased_sha = COALESCE(excluded.rebased_sha, revisions.rebased_sha),
           layer = COALESCE(excluded.layer, revisions.layer), workflow_id = COALESCE(excluded.workflow_id, revisions.workflow_id),
           processed_at = COALESCE(excluded.processed_at, revisions.processed_at)`,
      )
      .bind(change, sha, f.status, this.now(), f.onto_sha ?? null, f.rebased_sha ?? null, f.layer ?? null, f.workflow_id ?? null, f.processed ? this.now() : null)
      .run();
  }

  async evidence(change: string, sha: string, kind: string, status: "pass" | "fail" | "info" | "pending", data: unknown, uri?: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO evidence (change_id, sha, kind, status, uri, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(change, sha, kind, status, uri ?? null, JSON.stringify(data).slice(0, 60_000), this.now())
      .run();
  }

  async evidenceFor(change: string, sha?: string): Promise<EvidenceRow[]> {
    const q = sha
      ? this.db.prepare(`SELECT id, sha, kind, status, uri, data, created_at FROM evidence WHERE change_id = ? AND sha = ? ORDER BY id`).bind(change, sha)
      : this.db.prepare(`SELECT id, sha, kind, status, uri, data, created_at FROM evidence WHERE change_id = ? ORDER BY id`).bind(change);
    return (await q.all<EvidenceRow>()).results;
  }

  /**
   * Latest passing full-suite run in this repo (land presubmit, or a checkpoint that ran the
   * full suite): the baseline for "time saved" by affected-test selection. Null when none yet.
   */
  async lastFullSuite(repo: string): Promise<{ ms: number; tests: number | null; sha: string; kind: string } | null> {
    const rows = (
      await this.db
        .prepare(`SELECT e.kind, e.sha, e.data FROM evidence e JOIN changes c ON c.id = e.change_id WHERE c.repo = ? AND e.kind IN ('presubmit', 'test') AND e.status = 'pass' ORDER BY e.id DESC LIMIT 50`)
        .bind(repo)
        .all<{ kind: string; sha: string; data: string | null }>()
    ).results;
    for (const r of rows) {
      let d: { ms?: unknown; selection?: { mode?: string; total?: number | null } };
      try {
        d = r.data ? (JSON.parse(r.data) as typeof d) : {};
      } catch {
        continue;
      }
      if (typeof d.ms !== "number" || d.ms <= 0) continue;
      if (d.selection && d.selection.mode !== "full") continue;
      return { ms: d.ms, tests: d.selection?.total ?? null, sha: r.sha, kind: r.kind };
    }
    return null;
  }

  async setChangeStatus(id: string, status: string): Promise<void> {
    await this.db.prepare(`UPDATE changes SET status = ?, updated_at = ? WHERE id = ?`).bind(status, this.now(), id).run();
  }

  async setTaskStatus(repo: string, task: string, status: string): Promise<void> {
    await this.db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE repo = ? AND id = ?`).bind(status, this.now(), repo, task).run();
  }

  /** Close the task's other open candidates once one landed (forks + evidence are kept). */
  async closeSiblings(repo: string, task: string, winner: string): Promise<number> {
    const r = await this.db.prepare(`UPDATE changes SET status = 'closed', updated_at = ? WHERE repo = ? AND task = ? AND id != ? AND status = 'open'`).bind(this.now(), repo, task, winner).run();
    return r.meta.changes ?? 0;
  }

  /** Open candidates of a task with their head revision's processing result + evidence. */
  async candidates(repo: string, task: string): Promise<Candidate[]> {
    const rows = (await this.db.prepare(`SELECT * FROM changes WHERE repo = ? AND task = ? AND status = 'open' ORDER BY n`).bind(repo, task).all<ChangeRow>()).results;
    const out: Candidate[] = [];
    for (const c of rows) {
      const rev = c.head_sha ? await this.revision(c.id, c.head_sha) : null;
      const ev = rev ? await this.evidenceFor(c.id, rev.sha) : [];
      const last = (kind: string) => {
        const e = [...ev].reverse().find((x) => x.kind === kind);
        return e ? { status: e.status, data: e.data ? (JSON.parse(e.data) as Record<string, unknown>) : {} } : null;
      };
      out.push({ change: c.id, n: c.n, agent: c.agent, head: c.head_sha, revision: rev, rebase: last("rebase"), test: last("test"), cost: last("cost"), review: last("review"), risk: last("risk") });
    }
    return out;
  }

  async recordLanding(r: { op_id: string; repo: string; kind: "land" | "revert"; change_id: string | null; task: string | null; before: string; after: string; seq: number | null; status: string; layer?: string | null; requested_by?: string | null; workflow_id?: string | null; reverts_op_id?: string | null; reason?: string | null }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO landings (op_id, repo, kind, change_id, task, before_sha, after_sha, seq, status, layer, requested_by, workflow_id, reverts_op_id, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (op_id) DO UPDATE SET seq = COALESCE(excluded.seq, landings.seq), status = excluded.status, updated_at = excluded.updated_at`,
      )
      .bind(r.op_id, r.repo, r.kind, r.change_id, r.task, r.before, r.after, r.seq, r.status, r.layer ?? null, r.requested_by ?? null, r.workflow_id ?? null, r.reverts_op_id ?? null, r.reason ?? null, this.now(), this.now())
      .run();
  }

  async landing(opId: string): Promise<LandingRow | null> {
    return this.db.prepare(`SELECT * FROM landings WHERE op_id = ?`).bind(opId).first<LandingRow>();
  }

  async setLandingStatus(opId: string, status: string): Promise<void> {
    await this.db.prepare(`UPDATE landings SET status = ?, updated_at = ? WHERE op_id = ?`).bind(status, this.now(), opId).run();
  }
}

export type LandingRow = { op_id: string; repo: string; kind: string; change_id: string | null; task: string | null; before_sha: string; after_sha: string; seq: number | null; status: string; layer: string | null; reverts_op_id: string | null };

export type EvidenceRow = { id: number; sha: string; kind: string; status: string; uri: string | null; data: string | null; created_at: number };

export type Candidate = {
  change: string;
  n: number;
  agent: string | null;
  head: string | null;
  revision: RevisionRow | null;
  rebase: { status: string; data: Record<string, unknown> } | null;
  test: { status: string; data: Record<string, unknown> } | null;
  cost: { status: string; data: Record<string, unknown> } | null;
  /** B10 review agent verdict + score, and the classified risk tier (optional in older callers). */
  review?: { status: string; data: Record<string, unknown> } | null;
  risk?: { status: string; data: Record<string, unknown> } | null;
};

/** Revision status after a ProcessRevision job. */
export function revisionStatus(r: JobResult): "processed" | "conflict" | "failed" {
  if (r.status === "conflict") return "conflict";
  if (r.status === "error") return "failed";
  return "processed";
}
