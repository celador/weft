// Registry: a singleton Durable Object holding the repo list and API tokens (spec §3:
// "tokens are opaque bearer strings issued out of band by the gateway operator"). Tokens
// are stored as SHA-256 hashes; the plaintext is returned exactly once at issuance.

import { DurableObject } from "cloudflare:workers";
import { claimsPolicyError, type Scope } from "@weft/protocol";
import type { CoordinatorConfig, CoordinatorInit, Grant, RepoCoordinator, Result } from "@weft/sequencer";
import { cancelCustomerSubscriptions, stripeConfig, stripeRequest, type StripeEnv } from "./stripe";
import { freeEvents, monthKey, type Plan, type UsageState } from "./usage";

export interface RegistryEnv extends StripeEnv {
  WEFT_REPO: DurableObjectNamespace<RepoCoordinator>;
  /** Free events per space per month (default 5000, docs/pricing.md). */
  WEFT_FREE_EVENTS?: string;
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
    // Device sessions (paired viewers): kind = 'device', a sliding expiry, an absolute cap, last use.
    // Plain tokens leave these NULL, which means "no expiry". verifyRaw reads them, so they exist
    // before any token is checked.
    const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info(tokens)`).toArray().map((c) => c.name);
    for (const col of ["kind", "expires_at", "hard_expires_at", "last_seen_at"]) if (!cols.includes(col)) this.sql.exec(`ALTER TABLE tokens ADD COLUMN ${col} TEXT`);
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
    const r = this.sql
      .exec<{ id: string; grant_json: string; kind: string | null; expires_at: string | null; hard_expires_at: string | null; last_seen_at: string | null }>(
        `SELECT id, grant_json, kind, expires_at, hard_expires_at, last_seen_at FROM tokens WHERE hash = ? AND revoked_at IS NULL`,
        h,
      )
      .toArray()[0];
    if (!r) return null;
    const now = Date.now();
    if (r.expires_at && Date.parse(r.expires_at) <= now) return null;
    if (r.kind === "device") {
      // Sliding expiry: a device that keeps using the feed stays paired, up to the absolute cap.
      // Written at most once a minute (the feed page polls every 2 s).
      if (!r.last_seen_at || now - Date.parse(r.last_seen_at) >= TOUCH_EVERY_MS) {
        const hard = r.hard_expires_at ? Date.parse(r.hard_expires_at) : Infinity;
        const exp = new Date(Math.min(now + SESSION_TTL_MS, hard)).toISOString();
        this.sql.exec(`UPDATE tokens SET last_seen_at = ?, expires_at = ? WHERE id = ?`, new Date(now).toISOString(), exp, r.id);
      }
    }
    return JSON.parse(r.grant_json) as Grant;
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
  // A paired device's repo list is expanded at verify time to the space's current repos, so
  // the feed keeps working as repos are added, and never sees another space's repo.

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
    // One-time pairing codes for the feed page: stored as salted hashes, deleted on use or expiry.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, space TEXT NOT NULL, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS pairings_space ON pairings(space)`);
    // Per-day signup counters keyed by a daily-rotating HMAC of the network address (spaces.ts
    // networkKey); deleted within 48 hours (pruneSignupCounters, also on the alarm).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS signup_counters (day TEXT NOT NULL, net_key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, net_key))`);
    this.pruneSignupCounters();
    // Retention metrics, counts only (see recordSpaceEvent): when a space last sent an event, how many
    // events per UTC day (day rows older than ACTIVITY_DAYS are deleted), and the operator's `internal` tag.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS space_activity (space TEXT PRIMARY KEY, last_event_at TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS space_days (space TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (space, day))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS space_tags (space TEXT PRIMARY KEY, internal INTEGER NOT NULL DEFAULT 1)`);
    for (const [table, col] of [
      ["repos", "space"],
      ["tokens", "space"],
    ] as const) {
      const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((c) => c.name);
      if (!cols.includes(col)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS repos_space ON repos(space)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS tokens_space ON tokens(space)`);
    // Usage-based billing (docs/pricing.md). A space's plan, allowance override and Stripe customer id: no email,
    // no card data (Stripe Checkout collects and keeps those). One usage row per space per UTC month.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS space_billing (space TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'free', allowance INTEGER, stripe_customer_id TEXT, billing_event_at INTEGER NOT NULL DEFAULT 0)`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS space_billing_customer ON space_billing(stripe_customer_id)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS usage (space TEXT NOT NULL, month TEXT NOT NULL, events INTEGER NOT NULL DEFAULT 0, reported INTEGER NOT NULL DEFAULT 0, pending_from INTEGER, pending_to INTEGER, PRIMARY KEY (space, month))`,
    );
    // Stripe event ids already applied (idempotency); nothing else from the event is kept.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);

    this.retireViewerLinks();
    this.spacesReady = true;
    // Spaces the owner deleted before real erasure existed (status 'deleted') and erasures that were
    // interrupted ('erasing') still hold data: erase them from the alarm, shortly after this wakes.
    if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM spaces WHERE status IN ('erasing', 'deleted')`).one().n > 0) void this.scheduleAlarmAt(Date.now() + 1_000);
  }

  /**
   * Migration, once per Registry: the long-lived `viewer` tokens that used to ride in `/feed#t=...`
   * are revoked. A forwarded or screenshotted link of that kind carried a bearer that never
   * expired; from here on the feed is read by paired devices (expiring, revocable sessions).
   */
  private retireViewerLinks(): void {
    const done = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'viewer_links_retired'`).toArray()[0];
    if (done) return;
    const now = new Date().toISOString();
    this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL AND kind IS NULL AND json_extract(grant_json, '$.role') = 'viewer'`, now);
    this.sql.exec(`INSERT INTO settings (key, value) VALUES ('viewer_links_retired', ?)`, now);
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

  /** Set the alarm to `due` unless one is already pending at or before it. */
  private async scheduleAlarmAt(due: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > due) await this.ctx.storage.setAlarm(due);
  }

  /** Make sure an alarm fires when the oldest counter left turns 48 hours old, even with no traffic. */
  private async scheduleCounterPrune(oldest: string | undefined): Promise<void> {
    if (!oldest) return;
    await this.scheduleAlarmAt(Date.parse(`${oldest}T00:00:00Z`) + 2 * 86_400_000);
  }

  override async alarm(): Promise<void> {
    this.ensureSpaces();
    await this.scheduleCounterPrune(this.pruneSignupCounters());
    this.pruneActivity();
    await this.resumeErasures();
    await this.maintainBilling();
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

  async spaceInfo(space: string): Promise<(SpaceInfo & { repos: Array<{ name: string; repo: string; created_at: string }>; tokens: number; devices: number }) | undefined> {
    const s = this.activeSpace(space);
    if (!s) return undefined;
    const tokens = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ? AND revoked_at IS NULL AND kind IS NOT 'device'`, space).one().n;
    return { ...s, repos: this.spaceRepos(space), tokens, devices: this.deviceRows(space).length };
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
    if (!this.activeSpace(space)) {
      // The space was erased or suspended while this repo was being created: do not leave a repo behind.
      await this.env.WEFT_REPO.get(this.env.WEFT_REPO.idFromName(repo)).erase();
      this.sql.exec(`DELETE FROM repos WHERE repo = ? AND space IS NULL`, repo);
      return { error: "space not found", code: "gone" };
    }
    this.sql.exec(`UPDATE repos SET space = ? WHERE repo = ?`, space, repo);
    return { created: r.created, name, repo };
  }

  async spaceIssueToken(
    space: string,
    spec: { kind: "agent" | "system"; repo?: string; agent?: string; label?: string },
    maxTokens: number,
  ): Promise<{ token: string; info: TokenInfo } | { error: string; code: "invalid" | "quota" | "gone" | "repo" }> {
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    const n = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ? AND revoked_at IS NULL AND kind IS NOT 'device'`, space).one().n;
    if (n >= maxTokens) return { error: `a space holds at most ${maxTokens} active tokens; run \`npx @celador/weft uninstall\` in checkouts you no longer use`, code: "quota" };
    const id = `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    // The copyable feed link is gone: people read the feed as paired devices (pairingCreate / deviceCreate).
    if ((spec.kind as string) === "viewer") return { error: "viewer links were retired: pair a device instead (`npx @celador/weft pair`), or update the CLI (`npx @celador/weft@latest`)", code: "invalid" };
    const repo = spec.repo ?? "";
    if (!this.spaceRepos(space).some((r) => r.repo === repo)) return { error: `repo ${repo} not found in this space`, code: "repo" };
    let grant: SpaceGrant;
    if (spec.kind === "agent") {
      if (!spec.agent || !AGENT_ID.test(spec.agent)) return { error: "agent must be 1-64 chars of letters, digits, '.', '_' or '-'", code: "invalid" };
      grant = { id, principal: spec.agent, scopes: ["agent", "observe"], repos: [repo], agent: spec.agent, space, role: "agent" };
    } else if (spec.kind === "system") {
      grant = { id, principal: `space:${space}:lander`, scopes: ["system", "observe"], repos: [repo], space, role: "system" };
    } else return { error: "kind must be agent or system", code: "invalid" };
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

  /** Suspend a space (operator ban): every token (owner included) is revoked at once; its data is kept until the operator erases it. */
  async suspendSpace(space: string): Promise<boolean> {
    this.ensureSpaces();
    const now = new Date().toISOString();
    const n = this.sql.exec(`UPDATE spaces SET status = 'suspended', deleted_at = ? WHERE id = ? AND status = 'active'`, now, space).rowsWritten;
    this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE space = ? AND revoked_at IS NULL`, now, space);
    this.sql.exec(`DELETE FROM pairings WHERE space = ?`, space);
    return n > 0;
  }

  /** The repos an erasure of `space` removes: those recorded for it, plus one whose row never got its space column (a crash between createRepo and the UPDATE). */
  private erasableRepos(space: string): string[] {
    return this.sql
      .exec<{ repo: string }>(`SELECT repo FROM repos WHERE space = ? OR (space IS NULL AND substr(repo, 1, ?) = ?) ORDER BY repo`, space, space.length + 1, `${space}-`)
      .toArray()
      .map((r) => r.repo);
  }

  /**
   * Erase a space for good (owner request, operator request, or a leftover soft delete). Order:
   *   1. status -> 'erasing' and every token revoked: from this point nothing can read or write the space;
   *   2. every repo Durable Object of the space is erased (RepoCoordinator.erase: sockets closed,
   *      alarm cleared, all storage deleted);
   *   3. only when all of them are gone: the space's repos and tokens rows are deleted and the space
   *      row is cut down to a tombstone (id, status 'erased', deleted_at, created_at as a date).
   * If a repo fails to erase, the space stays 'erasing' (unreachable) and the alarm retries every
   * minute; the operator can also call this again. A space that is already erased returns the same
   * answer with already_erased. Works for active, suspended and 'deleted' (legacy) spaces.
   */
  async eraseSpace(space: string): Promise<EraseReport | { error: string; code: "incomplete" } | undefined> {
    this.ensureSpaces();
    const row = this.sql.exec<{ status: string }>(`SELECT status FROM spaces WHERE id = ?`, space).toArray()[0];
    if (!row) return undefined;
    if (row.status === "erased") return { space, status: "erased", already_erased: true, erased: { repos: [], events: 0, tokens: 0 } };
    this.sql.exec(`UPDATE spaces SET status = 'erasing' WHERE id = ?`, space);
    this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE space = ? AND revoked_at IS NULL`, new Date().toISOString(), space);
    this.sql.exec(`DELETE FROM pairings WHERE space = ?`, space); // open pairing codes die with the space
    // A paying space settles with Stripe BEFORE anything is deleted: its last usage is reported and its subscription cancelled.
    const billingError = await this.settleBilling(space);
    if (billingError) {
      await this.scheduleAlarmAt(Date.now() + 60_000);
      return { error: `${billingError}; the space is already unreachable and the erase is retried automatically`, code: "incomplete" };
    }
    const repos = this.erasableRepos(space);
    const results = await Promise.allSettled(repos.map((repo) => this.env.WEFT_REPO.get(this.env.WEFT_REPO.idFromName(repo)).erase()));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      await this.scheduleAlarmAt(Date.now() + 60_000);
      return { error: `${failed} of ${repos.length} repos could not be erased yet; the space is already unreachable and the erase is retried automatically`, code: "incomplete" };
    }
    const events = results.reduce((n, r) => n + (r.status === "fulfilled" ? r.value.events : 0), 0);
    const tokens = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ?`, space).one().n;
    this.sql.exec(`DELETE FROM repos WHERE space = ? OR (space IS NULL AND substr(repo, 1, ?) = ?)`, space, space.length + 1, `${space}-`);
    this.sql.exec(`DELETE FROM tokens WHERE space = ?`, space);
    // Retention counts (last event time, events per day) go with the space; the operator's internal tag stays so the first-run counts keep leaving it out.
    this.sql.exec(`DELETE FROM space_activity WHERE space = ?`, space);
    this.sql.exec(`DELETE FROM space_days WHERE space = ?`, space);
    // Billing rows (plan, Stripe customer id, monthly usage) go too. The Stripe customer record itself stays with Stripe (it holds invoices).
    this.sql.exec(`DELETE FROM usage WHERE space = ?`, space);
    this.sql.exec(`DELETE FROM space_billing WHERE space = ?`, space);
    this.sql.exec(`UPDATE spaces SET status = 'erased', label = NULL, created_at = substr(created_at, 1, 10), deleted_at = ? WHERE id = ?`, new Date().toISOString(), space);
    return { space, status: "erased", already_erased: false, erased: { repos: repos.map((r) => r.slice(space.length + 1)), events, tokens } };
  }

  /** Erase every space left 'erasing' (interrupted) or 'deleted' (soft-deleted before real erasure existed). Called from the alarm. */
  private async resumeErasures(): Promise<void> {
    const ids = this.sql.exec<{ id: string }>(`SELECT id FROM spaces WHERE status IN ('erasing', 'deleted') ORDER BY created_at LIMIT 25`).toArray();
    let more = ids.length === 25;
    for (const { id } of ids) {
      const r = await this.eraseSpace(id);
      if (r && "error" in r) more = true;
    }
    if (more) await this.scheduleAlarmAt(Date.now() + 60_000);
  }

  async listSpaces(): Promise<Array<SpaceInfo & { repos: number; tokens: number; internal?: true }>> {
    this.ensureSpaces();
    return this.sql
      .exec<{ id: string; status: string; label: string | null; created_at: string; repos: number; tokens: number; internal: number }>(
        `SELECT s.id, s.status, s.label, s.created_at,
           (SELECT COUNT(*) FROM repos r WHERE r.space = s.id) AS repos,
           (SELECT COUNT(*) FROM tokens t WHERE t.space = s.id AND t.revoked_at IS NULL) AS tokens,
           COALESCE((SELECT internal FROM space_tags g WHERE g.space = s.id), 0) AS internal
         FROM spaces s ORDER BY s.created_at`,
      )
      .toArray()
      .map((r) => ({ id: r.id, status: r.status as SpaceInfo["status"], created_at: r.created_at, ...(r.label ? { label: r.label } : {}), repos: r.repos, tokens: r.tokens, ...(r.internal ? { internal: true } : {}) }));
  }

  /** First runs per day (spaces created, internal spaces excluded), the last `days` days: the funnel's last step. */
  async signupStats(days = 30): Promise<Array<{ day: string; spaces: number }>> {
    this.ensureSpaces();
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return this.sql
      .exec<{ day: string; n: number }>(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM spaces WHERE created_at >= ? AND id NOT IN (SELECT space FROM space_tags WHERE internal = 1) GROUP BY day ORDER BY day`,
        since,
      )
      .toArray()
      .map((r) => ({ day: r.day, spaces: r.n }));
  }

  // ------------------------------------------------------------------ retention metrics (counts only)

  private prunedDay = "";

  /** Delete per-day activity rows older than ACTIVITY_DAYS (today included in the window). */
  pruneActivity(now = Date.now()): void {
    this.ensureSpaces();
    this.sql.exec(`DELETE FROM space_days WHERE day < ?`, utcDay(now - (ACTIVITY_DAYS - 1) * 86_400_000));
  }

  /**
   * One accepted event from a space: bumps last_event_at and today's (UTC) event count. Stores only the
   * space id, a timestamp and a number. Unknown or non-active spaces are ignored.
   */
  async recordSpaceEvent(space: string, now = Date.now()): Promise<void> {
    if (!this.activeSpace(space)) return;
    const day = utcDay(now);
    this.sql.exec(`INSERT INTO space_activity (space, last_event_at) VALUES (?, ?) ON CONFLICT(space) DO UPDATE SET last_event_at = MAX(last_event_at, excluded.last_event_at)`, space, new Date(now).toISOString());
    this.sql.exec(`INSERT INTO space_days (space, day, n) VALUES (?, ?, 1) ON CONFLICT(space, day) DO UPDATE SET n = n + 1`, space, day);
    if (this.prunedDay !== day) {
      this.pruneActivity(now);
      this.prunedDay = day;
    }
  }

  /** Operator tag: internal spaces (our own tests and demos) are left out of the headline numbers. False when the space does not exist. */
  async setSpaceInternal(space: string, internal: boolean): Promise<boolean> {
    this.ensureSpaces();
    if (!this.sql.exec<{ id: string }>(`SELECT id FROM spaces WHERE id = ?`, space).toArray()[0]) return false;
    if (internal) this.sql.exec(`INSERT INTO space_tags (space, internal) VALUES (?, 1) ON CONFLICT(space) DO UPDATE SET internal = 1`, space);
    else this.sql.exec(`DELETE FROM space_tags WHERE space = ?`, space);
    return true;
  }

  /**
   * Retention numbers for GET /v1/admin/stats. Headline counts leave internal spaces out. Windows are UTC
   * days ending today: 7 days = today and the 6 before. Active = at least one event in the window;
   * retained = events on at least two distinct days (within ACTIVITY_DAYS) and at least one in the last 7.
   */
  async retentionStats(now = Date.now()): Promise<RetentionStats> {
    this.ensureSpaces();
    this.pruneActivity(now);
    const from7 = utcDay(now - 6 * 86_400_000);
    const from30 = utcDay(now - 29 * 86_400_000);
    const rows = this.sql
      .exec<{ id: string; status: string; label: string | null; created_at: string; internal: number; last_event_at: string | null; active_days_30: number; days: number; active7: number }>(
        `SELECT s.id, s.status, s.label, s.created_at,
           COALESCE((SELECT internal FROM space_tags g WHERE g.space = s.id), 0) AS internal,
           (SELECT last_event_at FROM space_activity a WHERE a.space = s.id) AS last_event_at,
           (SELECT COUNT(*) FROM space_days d WHERE d.space = s.id AND d.day >= ?) AS active_days_30,
           (SELECT COUNT(*) FROM space_days d WHERE d.space = s.id) AS days,
           (SELECT COUNT(*) FROM space_days d WHERE d.space = s.id AND d.day >= ?) AS active7
         FROM spaces s WHERE s.status NOT IN ('deleted', 'erasing', 'erased')
         ORDER BY (last_event_at IS NULL), last_event_at DESC, s.created_at DESC`,
        from30,
        from7,
      )
      .toArray();
    const real = rows.filter((r) => !r.internal);
    const events = this.sql
      .exec<{ day: string; n: number }>(`SELECT day, SUM(n) AS n FROM space_days WHERE day >= ? AND space NOT IN (SELECT space FROM space_tags WHERE internal = 1) GROUP BY day ORDER BY day`, from30)
      .toArray();
    return {
      active_7d: real.filter((r) => r.active7 > 0).length,
      active_30d: real.filter((r) => r.active_days_30 > 0).length,
      retained: real.filter((r) => r.days >= 2 && r.active7 > 0).length,
      internal_spaces: rows.filter((r) => r.internal).length,
      events_per_day: events.map((e) => ({ day: e.day, events: e.n })),
      spaces_total: rows.length,
      spaces: rows.slice(0, MAX_LISTED_SPACES).map((r) => ({ id: r.id, ...(r.label ? { label: r.label } : {}), status: r.status as SpaceInfo["status"], created: r.created_at, last_event_at: r.last_event_at, active_days_30: r.active_days_30, ...(r.internal ? { internal: true } : {}) })),
    };
  }

  /** verify() plus space semantics: suspended/deleted spaces and `off` mode refuse; viewers see the space's current repos. */
  async verifySpace(token: string): Promise<SpaceGrant | null> {
    this.ensureSpaces(); // runs the viewer-link migration before any token is checked
    const g = (await this.verifyRaw(token)) as SpaceGrant | null;
    if (!g || !g.space) return g;
    if (!this.activeSpace(g.space)) return null;
    if ((await this.hostedMode()) === "off") return null;
    // Free space at its allowance: the gateway refuses its submits (only while billing is enabled there).
    const over = stripeConfig(this.env) ? this.usageState(g.space).over : false;
    const out: SpaceGrant = over ? { ...g, over_allowance: true } : g;
    if (g.role === "viewer" || g.role === "device") return { ...out, repos: this.spaceRepos(g.space).map((r) => r.repo) };
    return out;
  }

  // ------------------------------------------------------------------ usage-based billing
  //
  // docs/pricing.md. The meter is agent events per space per UTC month. A `free` space is held at
  // its allowance (the gateway answers 429 over_allowance); a `paid` one is not, and the overage
  // above its allowance goes to Stripe as meter events. The Registry stores a Stripe customer id
  // and nothing else about the customer.

  private billingRow(space: string): { plan: Plan; allowance: number | null; customer: string | null } {
    this.ensureSpaces();
    const r = this.sql.exec<{ plan: string; allowance: number | null; stripe_customer_id: string | null }>(`SELECT plan, allowance, stripe_customer_id FROM space_billing WHERE space = ?`, space).toArray()[0];
    return { plan: r?.plan === "paid" ? "paid" : "free", allowance: r?.allowance ?? null, customer: r?.stripe_customer_id ?? null };
  }

  /** The space's usage this month against its allowance. `over` is only acted on while billing is enabled. */
  usageState(space: string, now = Date.now()): UsageState {
    const month = monthKey(now);
    const b = this.billingRow(space);
    const events = this.sql.exec<{ events: number }>(`SELECT events FROM usage WHERE space = ? AND month = ?`, space, month).toArray()[0]?.events ?? 0;
    const allowance = b.allowance ?? freeEvents(this.env);
    return { month, events, allowance, plan: b.plan, over: b.plan === "free" && events >= allowance, has_billing_account: b.customer !== null };
  }

  /** `GET /v1/space`: usage for an active space. */
  async spaceUsage(space: string): Promise<UsageState | undefined> {
    return this.activeSpace(space) ? this.usageState(space) : undefined;
  }

  /**
   * Add metered events (the gateway coalesces them). Unknown or deleted spaces are ignored. Returns each
   * space's state so the gateway can start refusing at once instead of when its grant cache expires.
   */
  async recordUsage(items: Array<[string, number]>, now = Date.now()): Promise<Record<string, UsageState>> {
    this.ensureSpaces();
    const month = monthKey(now);
    const out: Record<string, UsageState> = {};
    let wantReport = false;
    for (const [space, n] of items) {
      if (!Number.isInteger(n) || n <= 0 || !this.activeSpace(space)) continue;
      this.sql.exec(`INSERT INTO usage (space, month, events) VALUES (?, ?, ?) ON CONFLICT(space, month) DO UPDATE SET events = events + excluded.events`, space, month, n);
      out[space] = this.usageState(space, now);
      if (out[space]!.has_billing_account) wantReport = true;
    }
    if (this.prunedMonth !== month) {
      this.prunedMonth = month;
      this.pruneUsage(now);
    }
    if (wantReport && stripeConfig(this.env)) await this.scheduleAlarmAt(now + REPORT_EVERY_MS);
    return out;
  }

  /** Operator: give one space a different monthly allowance (null = the default). */
  setAllowance(space: string, allowance: number | null): boolean {
    if (!this.activeSpace(space)) return false;
    this.sql.exec(`INSERT INTO space_billing (space, allowance) VALUES (?, ?) ON CONFLICT(space) DO UPDATE SET allowance = excluded.allowance`, space, allowance);
    return true;
  }

  /** Operator: zero everyone's counters for a month (go-live: forget usage from before billing existed). */
  resetUsage(month: string): number {
    this.ensureSpaces();
    return this.sql.exec(`DELETE FROM usage WHERE month = ? AND reported = 0 AND pending_to IS NULL`, month).rowsWritten;
  }

  /**
   * Before an erase: report what the space owes and cancel its subscription (invoicing what is metered). Returns an
   * error text if Stripe could not do it (the erase then retries from the alarm), undefined when done or when there is
   * nothing to settle. A subscription is usage-only (no flat fee), so one left running by a gateway that has no Stripe
   * secrets bills nothing; that case is logged and the erase goes on, because erasure must not wait for billing.
   */
  private async settleBilling(space: string): Promise<string | undefined> {
    const customer = this.billingRow(space).customer;
    if (!customer) return undefined;
    const cfg = stripeConfig(this.env);
    if (!cfg) {
      console.error("billing: erasing a space that has a Stripe customer, but Stripe is not configured here; its subscription was not cancelled");
      return undefined;
    }
    try {
      if ((await this.reportUsage(space)).failed) return "could not report the space's last usage to Stripe";
      await cancelCustomerSubscriptions(cfg, customer);
      return undefined;
    } catch (e) {
      console.error("billing: cancel before erase failed", e instanceof Error ? e.message : String(e));
      return "could not cancel the subscription with Stripe";
    }
  }

  /** Operator: where billing stands. */
  billingSummary(): { month: string; plans: { free: number; paid: number }; with_billing_account: number; events_this_month: number; active_this_month: number; over_allowance: number } {
    this.ensureSpaces();
    const month = monthKey();
    const active = this.sql.exec<{ id: string }>(`SELECT id FROM spaces WHERE status = 'active'`).toArray();
    const paid = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM space_billing b JOIN spaces s ON s.id = b.space WHERE b.plan = 'paid' AND s.status = 'active'`).one().n;
    const withAccount = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM space_billing b JOIN spaces s ON s.id = b.space WHERE b.stripe_customer_id IS NOT NULL AND s.status = 'active'`).one().n;
    const u = this.sql.exec<{ n: number; e: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(events), 0) AS e FROM usage WHERE month = ?`, month).one();
    const over = active.filter((s) => this.usageState(s.id).over).length;
    return { month, plans: { free: active.length - paid, paid }, with_billing_account: withAccount, events_this_month: u.e, active_this_month: u.n, over_allowance: over };
  }

  /** The Stripe customer attached to a space, if any (for the portal and for cancelling). */
  stripeCustomer(space: string): string | null {
    return this.activeSpace(space) ? this.billingRow(space).customer : null;
  }

  /**
   * Apply one verified Stripe event to the plan table, once. `space` is set for checkout sessions (the
   * client_reference_id we put on them); other events carry only a customer, which must be one we attached to a
   * space. Idempotent on the event id; an event older than the last applied one changes nothing (Stripe does not
   * promise ordering). Runs in one synchronous step, so the id and the change cannot be separated.
   */
  applyBillingEvent(e: { id: string; created: number; space?: string; customer?: string; plan: Plan }): { result: "applied" | "duplicate" | "ignored" | "stale"; space?: string } {
    this.ensureSpaces();
    let space = e.space;
    if (space !== undefined) {
      if (!this.activeSpace(space)) return { result: "ignored" };
    } else if (e.customer) {
      space = this.sql.exec<{ space: string }>(`SELECT space FROM space_billing WHERE stripe_customer_id = ?`, e.customer).toArray()[0]?.space;
      if (!space || !this.activeSpace(space)) return { result: "ignored" };
    } else return { result: "ignored" };
    if (this.sql.exec(`INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?, ?)`, e.id, Math.floor(Date.now() / 1000)).rowsWritten === 0) return { result: "duplicate", space };
    this.sql.exec(`INSERT OR IGNORE INTO space_billing (space) VALUES (?)`, space);
    if (e.space !== undefined && e.customer) this.sql.exec(`UPDATE space_billing SET stripe_customer_id = ? WHERE space = ?`, e.customer, space);
    const moved = this.sql.exec(`UPDATE space_billing SET plan = ?, billing_event_at = ? WHERE space = ? AND billing_event_at <= ?`, e.plan, e.created, space, e.created).rowsWritten;
    return { result: moved > 0 ? "applied" : "stale", space };
  }

  /**
   * Send the overage of every space with a Stripe customer to its meter (all of them, or just `only`). Each
   * space's window (from, to] is written down BEFORE the call and reused until Stripe accepts it, and the meter
   * event's identifier is built from the window, so a retry after a lost answer is the same event to Stripe
   * (it drops duplicates of an identifier for 24 hours) and the cursor only moves on success.
   */
  async reportUsage(only?: string): Promise<{ sent: number; events: number; failed: number }> {
    const cfg = stripeConfig(this.env);
    const res = { sent: 0, events: 0, failed: 0 };
    if (!cfg) return res;
    this.ensureSpaces();
    const rows = this.sql
      .exec<{ space: string; month: string; events: number; reported: number; pending_from: number | null; pending_to: number | null; customer: string; allowance: number | null }>(
        `SELECT u.space, u.month, u.events, u.reported, u.pending_from, u.pending_to, b.stripe_customer_id AS customer, b.allowance
         FROM usage u JOIN space_billing b ON b.space = u.space
         WHERE b.stripe_customer_id IS NOT NULL ${only ? "AND u.space = ?" : ""} ORDER BY u.space, u.month`,
        ...(only ? [only] : []),
      )
      .toArray();
    for (const r of rows) {
      let from = r.pending_from;
      let to = r.pending_to;
      if (from === null || to === null) {
        const overage = Math.max(0, r.events - (r.allowance ?? freeEvents(this.env)));
        if (overage <= r.reported) continue;
        from = r.reported;
        to = overage;
        this.sql.exec(`UPDATE usage SET pending_from = ?, pending_to = ? WHERE space = ? AND month = ?`, from, to, r.space, r.month);
      }
      try {
        await stripeRequest(cfg.key, "POST", "/v1/billing/meter_events", {
          event_name: cfg.meterEvent,
          identifier: `weft:${r.space}:${r.month}:${from}-${to}`,
          timestamp: Math.floor(Date.now() / 1000),
          payload: { stripe_customer_id: r.customer, value: to - from },
        });
        this.sql.exec(`UPDATE usage SET reported = ?, pending_from = NULL, pending_to = NULL WHERE space = ? AND month = ?`, to, r.space, r.month);
        res.sent++;
        res.events += to - from;
      } catch (e) {
        res.failed++;
        console.error("billing: meter event failed", r.space, r.month, e instanceof Error ? e.message : String(e));
      }
    }
    return res;
  }

  /** Counters of months more than ~2 months old that carry nothing left to bill. */
  private pruneUsage(now = Date.now()): void {
    this.sql.exec(
      `DELETE FROM usage WHERE month < ? AND pending_to IS NULL AND reported >= events - COALESCE((SELECT allowance FROM space_billing b WHERE b.space = usage.space), ?)`,
      monthKey(now - 62 * 86_400_000),
      freeEvents(this.env),
    );
  }

  private prunedMonth = "";

  /** Alarm work: report usage, drop old Stripe event ids and fully reported months, and arm the next run. */
  private async maintainBilling(): Promise<void> {
    this.sql.exec(`DELETE FROM stripe_events WHERE at < ?`, Math.floor(Date.now() / 1000) - 45 * 86_400);
    this.pruneUsage();
    if (!stripeConfig(this.env)) return;
    try {
      await this.reportUsage();
    } catch (e) {
      console.error("billing: report failed", e instanceof Error ? e.message : String(e));
    }
    const left = this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM usage u JOIN space_billing b ON b.space = u.space
       WHERE b.stripe_customer_id IS NOT NULL AND (u.pending_to IS NOT NULL OR u.events - COALESCE(b.allowance, ?) > u.reported)`,
      freeEvents(this.env),
    ).one().n;
    if (left > 0) await this.scheduleAlarmAt(Date.now() + REPORT_EVERY_MS);
  }

  // ------------------------------------------------------------------ paired devices (the feed)
  //
  // The feed is read by *devices* the owner paired, not by a link. `pairingCreate` (owner) mints a
  // short one-time code; `pairingExchange` (no auth, rate limited in spaces.ts) trades it for a
  // device session: a random token that only ever travels in an HttpOnly cookie, expires after
  // SESSION_TTL_MS without use (sliding) and SESSION_HARD_MS in any case, and reads one space.

  private hostedModeNow(): HostedMode {
    const v = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'hosted'`).toArray()[0]?.value;
    return v === "off" || v === "no-signups" ? v : "open";
  }

  /** Active (unrevoked, unexpired) device sessions of a space. Also drops rows that ended a week ago. */
  private deviceRows(space: string): DeviceInfo[] {
    const now = new Date();
    const cutoff = new Date(now.getTime() - DEVICE_KEEP_MS).toISOString();
    this.sql.exec(`DELETE FROM tokens WHERE kind = 'device' AND (revoked_at < ? OR expires_at < ?)`, cutoff, cutoff);
    return this.sql
      .exec<{ id: string; label: string | null; created_at: string; last_seen_at: string | null; expires_at: string; hard_expires_at: string }>(
        `SELECT id, label, created_at, last_seen_at, expires_at, hard_expires_at FROM tokens
         WHERE space = ? AND kind = 'device' AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at`,
        space,
        now.toISOString(),
      )
      .toArray()
      .map((r) => ({ id: r.id, label: r.label ?? "", created_at: r.created_at, last_seen_at: r.last_seen_at ?? r.created_at, expires_at: r.expires_at, hard_expires_at: r.hard_expires_at }));
  }

  async devices(space: string): Promise<DeviceInfo[]> {
    this.ensureSpaces();
    return this.activeSpace(space) ? this.deviceRows(space) : [];
  }

  async deviceInfo(space: string, id: string): Promise<DeviceInfo | undefined> {
    this.ensureSpaces();
    return this.activeSpace(space) ? this.deviceRows(space).find((d) => d.id === id) : undefined;
  }

  async deviceRevoke(space: string, id: string): Promise<boolean> {
    this.ensureSpaces();
    return this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE id = ? AND space = ? AND kind = 'device' AND revoked_at IS NULL`, new Date().toISOString(), id, space).rowsWritten > 0;
  }

  async deviceRevokeAll(space: string): Promise<number> {
    this.ensureSpaces();
    const n = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ? AND kind = 'device' AND revoked_at IS NULL`, space).one().n;
    this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE space = ? AND kind = 'device' AND revoked_at IS NULL`, new Date().toISOString(), space);
    return n;
  }

  /** Insert a device session. Synchronous: callers have already hashed the token. */
  private insertDevice(space: string, tokenHash: string, label: string): DeviceInfo {
    const id = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    const created_at = new Date(now).toISOString();
    const expires_at = new Date(now + SESSION_TTL_MS).toISOString();
    const hard_expires_at = new Date(now + SESSION_HARD_MS).toISOString();
    const grant: SpaceGrant = { id, principal: `space:${space}:device`, scopes: ["observe"], repos: [], space, role: "device" };
    this.sql.exec(
      `INSERT INTO tokens (id, hash, grant_json, label, created_at, space, kind, expires_at, hard_expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 'device', ?, ?, ?)`,
      id,
      tokenHash,
      JSON.stringify(grant),
      label,
      created_at,
      space,
      expires_at,
      hard_expires_at,
      created_at,
    );
    return { id, label, created_at, last_seen_at: created_at, expires_at, hard_expires_at };
  }

  /** A device session for the owner's own machine (the CLI): no code, the owner token vouches for it. */
  async deviceCreate(space: string, label: string, maxDevices: number): Promise<{ token: string; device: DeviceInfo } | { error: string; code: "gone" | "quota" }> {
    const token = randomDeviceToken();
    const hash = await sha256Hex(token);
    this.ensureSpaces();
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    if (this.deviceRows(space).length >= maxDevices) return { error: `a space holds at most ${maxDevices} paired devices; revoke some with \`npx @celador/weft viewers revoke --all\``, code: "quota" };
    return { token, device: this.insertDevice(space, hash, cleanLabel(label, "device")) };
  }

  /** A fresh one-time pairing code for the feed page (10 minutes, one use). At most 3 are outstanding. */
  async pairingCreate(space: string): Promise<{ code: string; expires_at: string; expires_in: number } | { error: string; code: "gone" }> {
    const code = pairingCode();
    const hash = await sha256Hex(pairingSalt(space, normalizeCode(code)));
    this.ensureSpaces();
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    const now = Date.now();
    this.sql.exec(`DELETE FROM pairings WHERE expires_at <= ?`, new Date(now).toISOString());
    const open = this.sql.exec<{ id: string }>(`SELECT id FROM pairings WHERE space = ? ORDER BY created_at DESC`, space).toArray();
    for (const old of open.slice(MAX_OPEN_PAIRINGS - 1)) this.sql.exec(`DELETE FROM pairings WHERE id = ?`, old.id);
    const expires_at = new Date(now + PAIRING_TTL_MS).toISOString();
    this.sql.exec(`INSERT INTO pairings (id, space, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, `pr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, space, hash, new Date(now).toISOString(), expires_at);
    return { code, expires_at, expires_in: PAIRING_TTL_MS / 1000 };
  }

  /**
   * Trade a pairing code for a device session. The code is compared in constant time against every
   * open code of the space (no early exit), and consumed by deleting its row in the same synchronous
   * step that found it, so two requests can never both win the same code. Every failure looks the same.
   */
  async pairingExchange(req: { space: string; code: string; label: string; maxDevices: number }): Promise<{ token: string; device: DeviceInfo } | { error: string; code: "invalid" | "quota" | "closed" }> {
    const hash = await sha256Hex(pairingSalt(req.space, normalizeCode(req.code)));
    const token = randomDeviceToken(); // minted whether or not the code matches: same work either way
    const tokenHash = await sha256Hex(token);
    // ---- no await below this line: select, compare, consume and insert happen in one step
    this.ensureSpaces();
    const nowIso = new Date().toISOString();
    const rows = this.sql.exec<{ id: string; code_hash: string }>(`SELECT id, code_hash FROM pairings WHERE space = ? AND expires_at > ?`, req.space, nowIso).toArray();
    let hit: string | undefined;
    for (const r of rows.length ? rows : [{ id: "", code_hash: "0".repeat(64) }]) if (constantTimeEqual(r.code_hash, hash) && r.id) hit = r.id;
    const space = this.activeSpace(req.space);
    if (!hit || !space) return { error: "that pairing code is not valid or has expired", code: "invalid" };
    if (this.hostedModeNow() === "off") return { error: "hosted spaces are switched off on this gateway", code: "closed" };
    if (this.deviceRows(req.space).length >= req.maxDevices) return { error: `this space already has ${req.maxDevices} paired devices; revoke one with \`npx @celador/weft viewers revoke <id>\` first`, code: "quota" };
    if (this.sql.exec(`DELETE FROM pairings WHERE id = ?`, hit).rowsWritten !== 1) return { error: "that pairing code is not valid or has expired", code: "invalid" };
    this.sql.exec(`DELETE FROM pairings WHERE expires_at <= ?`, nowIso);
    return { token, device: this.insertDevice(req.space, tokenHash, cleanLabel(req.label, "browser")) };
  }
}

/** How often a space with a Stripe customer and unreported overage is reported. */
export const REPORT_EVERY_MS = 3_600_000;

export type HostedMode = "open" | "no-signups" | "off";
export type SignupLimits = { perIpDay: number; perDay: number; maxSpaces: number };
export type SpaceInfo = { id: string; status: "active" | "deleted" | "suspended" | "erasing" | "erased"; label?: string; created_at: string };
/** What an erasure removed. After it, the Registry keeps only the tombstone: space id, status 'erased', deleted_at, created_at (date only). */
export type EraseReport = { space: string; status: "erased"; already_erased: boolean; erased: { repos: string[]; events: number; tokens: number } };
/** A grant minted for a hosted space. `role` owner = the space API only (no WCP scopes). */
export type SpaceGrant = Grant & { space?: string; role?: "owner" | "agent" | "system" | "viewer" | "device"; over_allowance?: boolean };
/** A paired device (a browser, or the owner's CLI): what `weft viewers` lists. */
export type DeviceInfo = { id: string; label: string; created_at: string; last_seen_at: string; expires_at: string; hard_expires_at: string };

/** A device session lives this long after its last use (sliding)... */
export const SESSION_TTL_MS = 7 * 86_400_000;
/** ...and never longer than this from pairing: after that the device pairs again. */
export const SESSION_HARD_MS = 30 * 86_400_000;
export const PAIRING_TTL_MS = 10 * 60_000;
const TOUCH_EVERY_MS = 60_000;
const DEVICE_KEEP_MS = 7 * 86_400_000;
const MAX_OPEN_PAIRINGS = 3;

// 31 symbols, no 0/O/1/I/L: easy to read off a terminal and type. 10 of them = 31^10 ~ 2^49.5.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN = 10;

/** `XXXXX-XXXXX`, uniform over the alphabet (rejection sampling, no modulo bias). */
function pairingCode(): string {
  let out = "";
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < CODE_LEN) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** What the user typed -> the canonical code: case and separators do not matter. */
export function normalizeCode(s: string): string {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 64);
}

const pairingSalt = (space: string, normalized: string) => `weft-pairing:${space}:${normalized}`;

function constantTimeEqual(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

function randomDeviceToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return `weft_dev_${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** A device label is shown to the owner in `weft viewers`: short, printable, no control characters. */
function cleanLabel(s: unknown, fallback: string): string {
  const t = typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return t || fallback;
}

/** Per-day activity rows are kept this many UTC days (today included), then deleted. */
export const ACTIVITY_DAYS = 90;
const MAX_LISTED_SPACES = 500;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export type RetentionStats = {
  /** Spaces (internal excluded) with at least one event in the last 7 / 30 UTC days. */
  active_7d: number;
  active_30d: number;
  /** Events on 2+ distinct days, at least one in the last 7. */
  retained: number;
  internal_spaces: number;
  /** Total events per UTC day over the last 30 days, internal spaces excluded. */
  events_per_day: Array<{ day: string; events: number }>;
  spaces_total: number;
  /** Non-deleted spaces, most recently active first (internal ones flagged); at most MAX_LISTED_SPACES. */
  spaces: Array<{ id: string; label?: string; status: SpaceInfo["status"]; created: string; last_event_at: string | null; active_days_30: number; internal?: true }>;
};
export const SPACE_REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `sp` + 10 base-36 chars: short enough for repo names (`<space>-<name>` <= 64 chars), ~51 bits. */
function spaceId(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return `sp${[...b].map((x) => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("")}`;
}
