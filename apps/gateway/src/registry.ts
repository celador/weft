// Registry: a singleton Durable Object holding the repo list and API tokens (spec §3:
// "tokens are opaque bearer strings issued out of band by the gateway operator"). Tokens
// are stored as SHA-256 hashes; the plaintext is returned exactly once at issuance.

import { DurableObject } from "cloudflare:workers";
import { claimsPolicyError, type Scope } from "@weft/protocol";
import type { CoordinatorConfig, CoordinatorInit, Grant, RepoCoordinator, Result } from "@weft/sequencer";

export interface RegistryEnv {
  WEFT_REPO: DurableObjectNamespace<RepoCoordinator>;
}

export type RepoEntry = { repo: string; config: CoordinatorInit; created_at: string };
export type TokenSpec = { principal: string; scopes: Scope[]; repos: string[] | "*"; agent?: string; change?: string; label?: string };
export type TokenInfo = Grant & { label?: string; created_at: string; revoked_at?: string };

const SCOPES: Scope[] = ["agent", "observe", "human", "system"];
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return `weft_${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export class Registry extends DurableObject<RegistryEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: RegistryEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS repos (repo TEXT PRIMARY KEY, config TEXT NOT NULL, created_at TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, grant_json TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, revoked_at TEXT)`,
    );
  }

  async createRepo(init: CoordinatorInit): Promise<{ created: boolean; repo: RepoEntry } | { error: string }> {
    if (!REPO_NAME.test(init.repo)) return { error: "repo must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" };
    if (init.policy && init.policy !== "wound-wait" && init.policy !== "wait-die") return { error: "policy must be wound-wait or wait-die" };
    if (init.escalation && init.escalation !== "auto" && init.escalation !== "human") return { error: "escalation must be auto or human" };
    // claims: omitted = the defaults (spec §7.5); null = a legacy repo (tests and migrations).
    if (init.claims !== undefined && init.claims !== null && claimsPolicyError(init.claims)) return { error: claimsPolicyError(init.claims)! };
    if (init.enforcement !== undefined && init.enforcement !== "advise" && init.enforcement !== "block") return { error: "enforcement must be advise or block" };
    if (init.conflicts !== undefined && init.conflicts !== "hold" && init.conflicts !== "continue") return { error: "conflicts must be hold or continue" };
    const stub = this.env.WEFT_REPO.get(this.env.WEFT_REPO.idFromName(init.repo));
    const r = (await stub.init(init)) as unknown as Result<{ created: boolean; config: CoordinatorConfig }>;
    if (!r.ok) return { error: r.error.error.message };
    // An existing repo keeps its stored config. Asking for a different conflicts or enforcement mode must fail, not be ignored.
    if (!r.value.created && (init.conflicts ?? "hold") !== (r.value.config.conflicts ?? "hold")) {
      return { error: `repo ${init.repo} already exists with conflicts=${r.value.config.conflicts ?? "hold"}; create it with the mode you want` };
    }
    if (!r.value.created && (init.enforcement ?? "advise") !== (r.value.config.enforcement ?? "advise")) {
      return { error: `repo ${init.repo} already exists with enforcement=${r.value.config.enforcement ?? "advise"}; create it with the mode you want` };
    }
    const now = new Date().toISOString();
    this.sql.exec(`INSERT OR IGNORE INTO repos (repo, config, created_at) VALUES (?, ?, ?)`, init.repo, JSON.stringify(init), now);
    return { created: r.value.created, repo: (await this.listRepos()).find((x) => x.repo === init.repo)! };
  }

  async listRepos(): Promise<RepoEntry[]> {
    return this.sql
      .exec<{ repo: string; config: string; created_at: string }>(`SELECT * FROM repos ORDER BY repo`)
      .toArray()
      .map((r) => ({ repo: r.repo, config: JSON.parse(r.config) as CoordinatorInit, created_at: r.created_at }));
  }

  async issueToken(spec: TokenSpec): Promise<{ token: string; info: TokenInfo } | { error: string }> {
    if (!spec.principal || typeof spec.principal !== "string") return { error: "principal is required" };
    if (!Array.isArray(spec.scopes) || !spec.scopes.length || spec.scopes.some((s) => !SCOPES.includes(s))) return { error: `scopes must be a non-empty subset of ${SCOPES.join(",")}` };
    if (spec.repos !== "*" && (!Array.isArray(spec.repos) || spec.repos.some((r) => !REPO_NAME.test(r)))) return { error: "repos must be \"*\" or a list of repo names" };
    if (spec.scopes.includes("agent")) {
      // Agent tokens are repo-scoped, one per (repo, agent) (spec §3).
      if (!spec.agent) return { error: "agent tokens need `agent`" };
      if (spec.repos === "*" || spec.repos.length !== 1) return { error: "agent tokens must name exactly one repo" };
      if (spec.scopes.some((s) => s === "human" || s === "system")) return { error: "agent tokens cannot carry human or system scope" };
    }
    if (spec.scopes.includes("observe") && spec.scopes.length === 1 && spec.agent) return { error: "observer tokens are not bound to an agent" };
    const token = randomToken();
    const id = `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const grant: Grant = {
      id,
      principal: spec.principal,
      scopes: [...new Set(spec.scopes)],
      repos: spec.repos,
      ...(spec.agent ? { agent: spec.agent } : {}),
      ...(spec.change ? { change: spec.change } : {}),
    };
    const created_at = new Date().toISOString();
    this.sql.exec(`INSERT INTO tokens (id, hash, grant_json, label, created_at) VALUES (?, ?, ?, ?, ?)`, id, await sha256Hex(token), JSON.stringify(grant), spec.label ?? null, created_at);
    return { token, info: { ...grant, ...(spec.label ? { label: spec.label } : {}), created_at } };
  }

  /** Token -> grant, with hosted-space semantics (see verifySpace below). Also used by RepoCoordinator for socket auth frames. */
  async verify(token: string): Promise<Grant | null> {
    return this.verifySpace(token);
  }

  private async verifyRaw(token: string): Promise<Grant | null> {
    const h = await sha256Hex(token);
    const r = this.sql.exec<{ grant_json: string }>(`SELECT grant_json FROM tokens WHERE hash = ? AND revoked_at IS NULL`, h).toArray()[0];
    return r ? (JSON.parse(r.grant_json) as Grant) : null;
  }

  async listTokens(): Promise<TokenInfo[]> {
    return this.sql
      .exec<{ grant_json: string; label: string | null; created_at: string; revoked_at: string | null }>(`SELECT grant_json, label, created_at, revoked_at FROM tokens ORDER BY created_at`)
      .toArray()
      .map((r) => ({
        ...(JSON.parse(r.grant_json) as Grant),
        ...(r.label ? { label: r.label } : {}),
        created_at: r.created_at,
        ...(r.revoked_at ? { revoked_at: r.revoked_at } : {}),
      }));
  }

  async revoke(id: string): Promise<boolean> {
    const n = this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, new Date().toISOString(), id).rowsWritten;
    return n > 0;
  }

  // ------------------------------------------------------------------ hosted spaces
  //
  // A space is an anonymous tenant on a hosted gateway (`npx weft`): no login, no account.
  // POST /v1/spaces mints a space; its owner token can only create repos named
  // `<space>-<name>` and mint tokens bound to those repos. Every token minted for a space
  // carries `space` in its grant (rate limits) and in the `space` column (quota + revoke).
  // A viewer token's repo list is expanded at verify time to the space's current repos, so
  // a feed link keeps working as repos are added, and never sees another space's repo.

  private spacesReady = false;

  private ensureSpaces(): void {
    if (this.spacesReady) return;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', label TEXT, created_at TEXT NOT NULL, deleted_at TEXT)`,
    );
    // Migration: spaces used to carry ip_hash (a plain SHA-256 of the creator's IP) and the signup
    // counters were keyed by it. Blank and drop the column, and drop the old counter table, the
    // first time this Registry touches spaces after the deploy.
    if (this.sql.exec<{ name: string }>(`PRAGMA table_info(spaces)`).toArray().some((c) => c.name === "ip_hash")) {
      this.sql.exec(`UPDATE spaces SET ip_hash = NULL`);
      this.sql.exec(`ALTER TABLE spaces DROP COLUMN ip_hash`);
    }
    this.sql.exec(`DROP TABLE IF EXISTS signup_counts`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Per-day signup counters keyed by a daily-rotating HMAC of the network address (spaces.ts
    // networkKey); deleted within 48 hours (pruneSignupCounters, also on the alarm).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS signup_counters (day TEXT NOT NULL, net_key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, net_key))`);
    this.pruneSignupCounters();
    for (const [table, col] of [
      ["repos", "space"],
      ["tokens", "space"],
    ] as const) {
      const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((c) => c.name);
      if (!cols.includes(col)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS repos_space ON repos(space)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS tokens_space ON tokens(space)`);
    this.spacesReady = true;
  }

  /**
   * Delete signup counters older than 48 hours. A row for UTC day D holds signups made during D, so
   * it goes once `now` reaches D+2 00:00 UTC (48 h after D began). Returns the oldest day left.
   */
  pruneSignupCounters(now = Date.now()): string | undefined {
    const keepFrom = new Date(now - 86_400_000).toISOString().slice(0, 10);
    this.sql.exec(`DELETE FROM signup_counters WHERE day < ?`, keepFrom);
    return this.sql.exec<{ day: string | null }>(`SELECT MIN(day) AS day FROM signup_counters`).one().day ?? undefined;
  }

  /** Make sure an alarm fires when the oldest counter left turns 48 hours old, even with no traffic. */
  private async scheduleCounterPrune(oldest: string | undefined): Promise<void> {
    if (!oldest) return;
    const due = Date.parse(`${oldest}T00:00:00Z`) + 2 * 86_400_000;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > due) await this.ctx.storage.setAlarm(due);
  }

  override async alarm(): Promise<void> {
    this.ensureSpaces();
    await this.scheduleCounterPrune(this.pruneSignupCounters());
  }

  /** Operator kill switch: `open` (default), `no-signups` (existing spaces keep working), `off` (every space token refused). */
  async hostedMode(): Promise<HostedMode> {
    this.ensureSpaces();
    const v = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'hosted'`).toArray()[0]?.value;
    return v === "off" || v === "no-signups" ? v : "open";
  }

  async setHostedMode(mode: HostedMode): Promise<HostedMode> {
    this.ensureSpaces();
    this.sql.exec(`INSERT INTO settings (key, value) VALUES ('hosted', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, mode);
    return mode;
  }

  async createSpace(req: { networkKey: string; day?: string; label?: string; limits: SignupLimits; bypassQuota?: boolean }): Promise<{ space: SpaceInfo; token: string } | { error: string; code: "quota" | "closed" }> {
    this.ensureSpaces();
    const mode = await this.hostedMode();
    if (mode !== "open" && !req.bypassQuota) return { error: "new spaces are paused on this gateway; try again later", code: "closed" };
    const day = req.day ?? new Date().toISOString().slice(0, 10);
    if (!req.bypassQuota) {
      const total = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM spaces WHERE status = 'active'`).one().n;
      if (total >= req.limits.maxSpaces) return { error: "this gateway is full; try again later or run your own (`npx @celador/weft deploy`)", code: "quota" };
      const today = this.sql.exec<{ n: number }>(`SELECT COALESCE(SUM(n), 0) AS n FROM signup_counters WHERE day = ?`, day).one().n;
      if (today >= req.limits.perDay) return { error: "too many new spaces today; try again tomorrow", code: "quota" };
      const mine = this.sql.exec<{ n: number }>(`SELECT n FROM signup_counters WHERE day = ? AND net_key = ?`, day, req.networkKey).toArray()[0]?.n ?? 0;
      if (mine >= req.limits.perIpDay) return { error: "too many new spaces from your network today; reuse the one you have (it is in ~/.config/weft)", code: "quota" };
    }
    this.sql.exec(`INSERT INTO signup_counters (day, net_key, n) VALUES (?, ?, 1) ON CONFLICT(day, net_key) DO UPDATE SET n = n + 1`, day, req.networkKey);
    await this.scheduleCounterPrune(this.pruneSignupCounters());
    const id = spaceId();
    const created_at = new Date().toISOString();
    const label = typeof req.label === "string" ? req.label.slice(0, 80) : null;
    this.sql.exec(`INSERT INTO spaces (id, status, label, created_at) VALUES (?, 'active', ?, ?)`, id, label, created_at);
    const token = randomToken();
    const grant: SpaceGrant = { id: `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, principal: `space:${id}`, scopes: [], repos: [], space: id, role: "owner" };
    this.sql.exec(
      `INSERT INTO tokens (id, hash, grant_json, label, created_at, space) VALUES (?, ?, ?, ?, ?, ?)`,
      grant.id,
      await sha256Hex(token),
      JSON.stringify(grant),
      "space owner",
      created_at,
      id,
    );
    return { space: { id, status: "active", created_at, ...(label ? { label } : {}) }, token };
  }

  /** The space's own repos: [{name (as the user calls it), repo (full name on the gateway)}]. */
  private spaceRepos(space: string): Array<{ name: string; repo: string; created_at: string }> {
    return this.sql
      .exec<{ repo: string; created_at: string }>(`SELECT repo, created_at FROM repos WHERE space = ? ORDER BY repo`, space)
      .toArray()
      .map((r) => ({ repo: r.repo, name: r.repo.slice(space.length + 1), created_at: r.created_at }));
  }

  private activeSpace(space: string): SpaceInfo | undefined {
    this.ensureSpaces();
    const r = this.sql.exec<{ id: string; status: string; label: string | null; created_at: string }>(`SELECT id, status, label, created_at FROM spaces WHERE id = ?`, space).toArray()[0];
    if (!r || r.status !== "active") return undefined;
    return { id: r.id, status: "active", created_at: r.created_at, ...(r.label ? { label: r.label } : {}) };
  }

  async spaceInfo(space: string): Promise<(SpaceInfo & { repos: Array<{ name: string; repo: string; created_at: string }>; tokens: number }) | undefined> {
    const s = this.activeSpace(space);
    if (!s) return undefined;
    const tokens = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ? AND revoked_at IS NULL`, space).one().n;
    return { ...s, repos: this.spaceRepos(space), tokens };
  }

  async spaceCreateRepo(space: string, name: string, maxRepos: number): Promise<{ created: boolean; name: string; repo: string } | { error: string; code: "invalid" | "quota" | "gone" }> {
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    if (!SPACE_REPO_NAME.test(name)) return { error: "repo name must be 1-48 chars of a-z, 0-9, '.', '_' or '-', starting with a letter or digit", code: "invalid" };
    const repo = `${space}-${name}`;
    const existing = this.sql.exec<{ space: string | null }>(`SELECT space FROM repos WHERE repo = ?`, repo).toArray()[0];
    if (existing) {
      if (existing.space !== space) return { error: "repo name not available", code: "invalid" };
      return { created: false, name, repo };
    }
    if (this.spaceRepos(space).length >= maxRepos) return { error: `a space holds at most ${maxRepos} repos`, code: "quota" };
    const r = await this.createRepo({ repo });
    if ("error" in r) return { error: r.error, code: "invalid" };
    this.sql.exec(`UPDATE repos SET space = ? WHERE repo = ?`, space, repo);
    return { created: r.created, name, repo };
  }

  async spaceIssueToken(
    space: string,
    spec: { kind: "agent" | "system" | "viewer"; repo?: string; agent?: string; label?: string },
    maxTokens: number,
  ): Promise<{ token: string; info: TokenInfo } | { error: string; code: "invalid" | "quota" | "gone" | "repo" }> {
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    const n = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ? AND revoked_at IS NULL`, space).one().n;
    if (n >= maxTokens) return { error: `a space holds at most ${maxTokens} active tokens; run \`npx @celador/weft uninstall\` in checkouts you no longer use`, code: "quota" };
    let grant: SpaceGrant;
    const id = `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (spec.kind === "viewer") {
      grant = { id, principal: `space:${space}:viewer`, scopes: ["observe"], repos: [], space, role: "viewer" };
    } else {
      const repo = spec.repo ?? "";
      if (!this.spaceRepos(space).some((r) => r.repo === repo)) return { error: `repo ${repo} not found in this space`, code: "repo" };
      if (spec.kind === "agent") {
        if (!spec.agent || !AGENT_ID.test(spec.agent)) return { error: "agent must be 1-64 chars of letters, digits, '.', '_' or '-'", code: "invalid" };
        grant = { id, principal: spec.agent, scopes: ["agent", "observe"], repos: [repo], agent: spec.agent, space, role: "agent" };
      } else if (spec.kind === "system") {
        grant = { id, principal: `space:${space}:lander`, scopes: ["system", "observe"], repos: [repo], space, role: "system" };
      } else return { error: "kind must be agent, system or viewer", code: "invalid" };
    }
    const token = randomToken();
    const created_at = new Date().toISOString();
    const label = spec.label?.slice(0, 120) ?? null;
    this.sql.exec(`INSERT INTO tokens (id, hash, grant_json, label, created_at, space) VALUES (?, ?, ?, ?, ?, ?)`, id, await sha256Hex(token), JSON.stringify(grant), label, created_at, space);
    return { token, info: { ...grant, ...(label ? { label } : {}), created_at } };
  }

  /** Revoke one of the space's own tokens (never the owner token, never another space's). */
  async spaceRevoke(space: string, tokenId: string): Promise<boolean> {
    const r = this.sql.exec<{ grant_json: string }>(`SELECT grant_json FROM tokens WHERE id = ? AND space = ? AND revoked_at IS NULL`, tokenId, space).toArray()[0];
    if (!r || (JSON.parse(r.grant_json) as SpaceGrant).role === "owner") return false;
    return this.revoke(tokenId);
  }

  /** Delete a space: every token (owner included) is revoked at once; its repos stop being reachable. */
  async deleteSpace(space: string, status: "deleted" | "suspended" = "deleted"): Promise<boolean> {
    this.ensureSpaces();
    const n = this.sql.exec(`UPDATE spaces SET status = ?, deleted_at = ? WHERE id = ? AND status = 'active'`, status, new Date().toISOString(), space).rowsWritten;
    this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE space = ? AND revoked_at IS NULL`, new Date().toISOString(), space);
    return n > 0;
  }

  async listSpaces(): Promise<Array<SpaceInfo & { repos: number; tokens: number }>> {
    this.ensureSpaces();
    return this.sql
      .exec<{ id: string; status: string; label: string | null; created_at: string; repos: number; tokens: number }>(
        `SELECT s.id, s.status, s.label, s.created_at,
           (SELECT COUNT(*) FROM repos r WHERE r.space = s.id) AS repos,
           (SELECT COUNT(*) FROM tokens t WHERE t.space = s.id AND t.revoked_at IS NULL) AS tokens
         FROM spaces s ORDER BY s.created_at`,
      )
      .toArray()
      .map((r) => ({ id: r.id, status: r.status as SpaceInfo["status"], created_at: r.created_at, ...(r.label ? { label: r.label } : {}), repos: r.repos, tokens: r.tokens }));
  }

  /** First runs per day (spaces created), the last `days` days: the funnel's last step. */
  async signupStats(days = 30): Promise<Array<{ day: string; spaces: number }>> {
    this.ensureSpaces();
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return this.sql
      .exec<{ day: string; n: number }>(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM spaces WHERE created_at >= ? GROUP BY day ORDER BY day`, since)
      .toArray()
      .map((r) => ({ day: r.day, spaces: r.n }));
  }

  /** verify() plus space semantics: suspended/deleted spaces and `off` mode refuse; viewers see the space's current repos. */
  async verifySpace(token: string): Promise<SpaceGrant | null> {
    const g = (await this.verifyRaw(token)) as SpaceGrant | null;
    if (!g || !g.space) return g;
    if (!this.activeSpace(g.space)) return null;
    if ((await this.hostedMode()) === "off") return null;
    if (g.role === "viewer") return { ...g, repos: this.spaceRepos(g.space).map((r) => r.repo) };
    return g;
  }
}

export type HostedMode = "open" | "no-signups" | "off";
export type SignupLimits = { perIpDay: number; perDay: number; maxSpaces: number };
export type SpaceInfo = { id: string; status: "active" | "deleted" | "suspended"; label?: string; created_at: string };
/** A grant minted for a hosted space. `role` owner = the space API only (no WCP scopes). */
export type SpaceGrant = Grant & { space?: string; role?: "owner" | "agent" | "system" | "viewer" };

export const SPACE_REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `sp` + 10 base-36 chars: short enough for repo names (`<space>-<name>` <= 64 chars), ~51 bits. */
function spaceId(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return `sp${[...b].map((x) => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("")}`;
}
