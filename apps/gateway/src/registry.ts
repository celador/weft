// Registry: a singleton Durable Object holding the repo list and API tokens (spec §3:
// "tokens are opaque bearer strings issued out of band by the gateway operator"). Tokens
// are stored as SHA-256 hashes; the plaintext is returned exactly once at issuance.

import { DurableObject } from "cloudflare:workers";
import { claimsPolicyError, type RepoSummary, type Scope } from "@weft/protocol";
import type { CoordinatorConfig, CoordinatorInit, Grant, RepoCoordinator, Result } from "@weft/sequencer";
import { cancelCustomerSubscriptions, StripeError, stripeConfig, stripeRequest, type StripeEnv } from "./stripe";
import { fairUsePerSeat, freeEvents, isInterval, monthKey, type Interval, type Plan, type UsageState } from "./usage";

export interface RegistryEnv extends StripeEnv {
  WEFT_REPO: DurableObjectNamespace<RepoCoordinator>;
  /** Free events per space per month (default 5000, docs/pricing.md). */
  WEFT_FREE_EVENTS?: string;
  /** Weft Pro fair use, events per seat per month (default 50000): passing it is flagged, never cut off. */
  WEFT_PRO_FAIR_USE_EVENTS?: string;
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
    // One row per repo: its summary (counts, head_seq, last event time, policy; never content). RepoCoordinator
    // pushes it on every change, and /v1/repos + /v1/feed read it instead of waking every repo object.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS repo_summaries (repo TEXT PRIMARY KEY, head_seq INTEGER NOT NULL, last_event_at TEXT, json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  /** Called by a RepoCoordinator after any change to its summary. */
  async putSummary(s: RepoSummary): Promise<void> {
    if (!REPO_NAME.test(s.repo)) return;
    this.sql.exec(
      `INSERT OR REPLACE INTO repo_summaries (repo, head_seq, last_event_at, json, updated_at) VALUES (?, ?, ?, ?, ?)`,
      s.repo,
      s.head_seq,
      s.last_event_at ?? null,
      JSON.stringify(s),
      new Date().toISOString(),
    );
  }

  /** Every registered repo with its stored summary (null until the repo has pushed one). One call, no repo objects woken. */
  async repoSummaries(): Promise<Array<{ repo: string; summary: RepoSummary | null }>> {
    return this.sql
      .exec<{ repo: string; json: string | null }>(`SELECT r.repo AS repo, s.json AS json FROM repos r LEFT JOIN repo_summaries s ON s.repo = r.repo ORDER BY r.repo`)
      .toArray()
      .map((r) => ({ repo: r.repo, summary: r.json ? (JSON.parse(r.json) as RepoSummary) : null }));
  }

  /**
   * Erase one repo that belongs to no hosted space (a test/demo repo the operator no longer wants): refuse its
   * tokens' reach by revoking tokens scoped to it alone, erase its Durable Object (log, diffs, journal), and drop
   * its rows. Space repos go through eraseSpace instead. Irreversible; idempotent.
   */
  async eraseRepo(repo: string): Promise<{ repo: string; erased: boolean; events: number; tokens_revoked: number } | { error: string; code: "space" | "unknown" }> {
    if (!REPO_NAME.test(repo)) return { error: "bad repo name", code: "unknown" };
    const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info(repos)`).toArray().map((c) => c.name);
    if (cols.includes("space")) {
      const row = this.sql.exec<{ space: string | null }>(`SELECT space FROM repos WHERE repo = ?`, repo).toArray()[0];
      if (row?.space) return { error: `repo ${repo} belongs to hosted space ${row.space}; erase the space instead`, code: "space" };
    }
    const known = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM repos WHERE repo = ?`, repo).one().n > 0;
    if (!known) return { error: `unknown repo ${repo}`, code: "unknown" };
    // Tokens that reach only this repo die with it (a wildcard or multi-repo token stays).
    const now = new Date().toISOString();
    let revoked = 0;
    for (const t of this.sql.exec<{ id: string; grant_json: string }>(`SELECT id, grant_json FROM tokens WHERE revoked_at IS NULL`).toArray()) {
      const g = JSON.parse(t.grant_json) as Grant;
      if (Array.isArray(g.repos) && g.repos.length === 1 && g.repos[0] === repo) {
        this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE id = ?`, now, t.id);
        revoked++;
      }
    }
    const { events } = await this.env.WEFT_REPO.get(this.env.WEFT_REPO.idFromName(repo)).erase();
    this.sql.exec(`DELETE FROM repos WHERE repo = ?`, repo);
    this.sql.exec(`DELETE FROM repo_summaries WHERE repo = ?`, repo);
    return { repo, erased: true, events, tokens_revoked: revoked };
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
    // Seed the summary row so the new repo shows up in lists without anyone waking its object.
    const sum = (await stub.summary()) as unknown as Result<RepoSummary>;
    if (sum.ok) await this.putSummary(sum.value);
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
    if (r.kind === "member" && (!r.last_seen_at || now - Date.parse(r.last_seen_at) >= TOUCH_EVERY_MS)) {
      // A member key never expires; the owner sees when it was last used (written at most once a minute).
      this.sql.exec(`UPDATE tokens SET last_seen_at = ? WHERE id = ?`, new Date(now).toISOString(), r.id);
    }
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
    // A pairing code minted with a member key: the browser it pairs is that member's, and goes when the member does.
    if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(pairings)`).toArray().some((c) => c.name === "member")) this.sql.exec(`ALTER TABLE pairings ADD COLUMN member TEXT`);
    // One-time invite codes (team join): salted hashes only, deleted on use or expiry, at most MAX_OPEN_INVITES per space.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, space TEXT NOT NULL, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS invites_space ON invites(space)`);
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
    // Weft Pro (per user): which product the space pays for ('pro'; NULL = the legacy usage plan), its seats and interval;
    // and the month a Pro space first went past fair use (flagged for the operator, never cut off).
    const billingCols = this.sql.exec<{ name: string }>(`PRAGMA table_info(space_billing)`).toArray().map((c) => c.name);
    if (!billingCols.includes("product")) this.sql.exec(`ALTER TABLE space_billing ADD COLUMN product TEXT`);
    if (!billingCols.includes("seats")) this.sql.exec(`ALTER TABLE space_billing ADD COLUMN seats INTEGER`);
    if (!billingCols.includes("interval")) this.sql.exec(`ALTER TABLE space_billing ADD COLUMN interval TEXT`);
    if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(usage)`).toArray().some((c) => c.name === "fair_use_at")) this.sql.exec(`ALTER TABLE usage ADD COLUMN fair_use_at TEXT`);
    // Web-first purchases (GET /buy): a paid Pro subscription not yet bound to a space. Keyed by the Checkout Session id
    // (the welcome page has it); holds Stripe ids, seats, interval, plan and the link's utm_source / utm_campaign (which
    // marketing link sold it, for the site's funnel), nothing about the person. Bound to a space
    // with a one-time claim code (claim_codes: salted hashes only, one hour, single use), then kept as `claimed` so the
    // same purchase can never be claimed twice. Deleted with the space it was claimed for.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS entitlements (session TEXT PRIMARY KEY, customer TEXT, subscription TEXT, seats INTEGER NOT NULL, interval TEXT NOT NULL, plan TEXT NOT NULL, billing_event_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, claimed_space TEXT, claimed_at TEXT, utm_source TEXT, utm_campaign TEXT)`,
    );
    const entCols = this.sql.exec<{ name: string }>(`PRAGMA table_info(entitlements)`).toArray().map((c) => c.name);
    for (const col of ["utm_source", "utm_campaign"]) if (!entCols.includes(col)) this.sql.exec(`ALTER TABLE entitlements ADD COLUMN ${col} TEXT`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS entitlements_customer ON entitlements(customer)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS entitlements_space ON entitlements(claimed_space)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS claim_codes (id TEXT PRIMARY KEY, session TEXT NOT NULL, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS claim_codes_session ON claim_codes(session)`);

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

  async spaceInfo(space: string): Promise<(SpaceInfo & { repos: Array<{ name: string; repo: string; created_at: string }>; tokens: number; devices: number; members: number }) | undefined> {
    const s = this.activeSpace(space);
    if (!s) return undefined;
    const tokens = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ? AND revoked_at IS NULL AND kind IS NOT 'device'`, space).one().n;
    return { ...s, repos: this.spaceRepos(space), tokens, devices: this.deviceRows(space).length, members: this.memberRows(space).length };
  }

  /** `existingOnly` (a member key): an existing repo answers as before, a new name is refused (code `forbidden`). */
  async spaceCreateRepo(space: string, name: string, maxRepos: number, existingOnly = false): Promise<{ created: boolean; name: string; repo: string } | { error: string; code: "invalid" | "quota" | "gone" | "forbidden" }> {
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    if (!SPACE_REPO_NAME.test(name)) return { error: "repo name must be 1-48 chars of a-z, 0-9, '.', '_' or '-', starting with a letter or digit", code: "invalid" };
    const repo = `${space}-${name}`;
    const existing = this.sql.exec<{ space: string | null }>(`SELECT space FROM repos WHERE repo = ?`, repo).toArray()[0];
    if (existing) {
      if (existing.space !== space) return { error: "repo name not available", code: "invalid" };
      return { created: false, name, repo };
    }
    if (existingOnly) {
      const names = this.spaceRepos(space).map((r) => r.name);
      return { error: `this space has no repo ${name}${names.length ? ` (it has: ${names.join(", ")}; pass --repo <name>)` : ""}; only the space's owner can add one`, code: "forbidden" };
    }
    if (this.spaceRepos(space).length >= maxRepos) return { error: `a space holds at most ${maxRepos} repos`, code: "quota" };
    const r = await this.createRepo({ repo });
    if ("error" in r) return { error: r.error, code: "invalid" };
    if (!this.activeSpace(space)) {
      // The space was erased or suspended while this repo was being created: do not leave a repo behind.
      await this.env.WEFT_REPO.get(this.env.WEFT_REPO.idFromName(repo)).erase();
      this.sql.exec(`DELETE FROM repos WHERE repo = ? AND space IS NULL`, repo);
      this.sql.exec(`DELETE FROM repo_summaries WHERE repo = ?`, repo);
      return { error: "space not found", code: "gone" };
    }
    this.sql.exec(`UPDATE repos SET space = ? WHERE repo = ?`, space, repo);
    return { created: r.created, name, repo };
  }

  /**
   * Mint a repo-bound key. `by` = a member key is asking: only agent keys, and only for an agent id that ends in
   * `.<the member's handle>`, so one person's agents can never take (or share) another's id; the key records the
   * member, and goes when the member is removed.
   */
  async spaceIssueToken(
    space: string,
    spec: { kind: "agent" | "system"; repo?: string; agent?: string; label?: string },
    maxTokens: number,
    by?: MemberRef,
  ): Promise<{ token: string; info: TokenInfo } | { error: string; code: "invalid" | "quota" | "gone" | "repo" | "forbidden" }> {
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    // ---- no await below this line: the member check and the insert are one step (a member removed meanwhile mints nothing)
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    if (by && !this.memberActive(space, by.id)) return { error: "this member key was removed from the space", code: "gone" };
    if (by && spec.kind !== "agent") return { error: "a member key mints agent keys only; landing keys come from the space's owner", code: "forbidden" };
    if (by && !(spec.agent ?? "").endsWith(`.${by.handle}`))
      return { error: `a member's agent ids end in .${by.handle} (so they never clash with a teammate's): e.g. ${slugAgent(spec.agent ?? "agent", by.handle)}`, code: "forbidden" };
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
      grant = { id, principal: spec.agent, scopes: ["agent", "observe"], repos: [repo], agent: spec.agent, space, role: "agent", ...(by ? { member: by.id } : {}) };
    } else if (spec.kind === "system") {
      grant = { id, principal: `space:${space}:lander`, scopes: ["system", "observe"], repos: [repo], space, role: "system" };
    } else return { error: "kind must be agent or system", code: "invalid" };
    const created_at = new Date().toISOString();
    const label = spec.label?.slice(0, 120) ?? null;
    this.sql.exec(`INSERT INTO tokens (id, hash, grant_json, label, created_at, space) VALUES (?, ?, ?, ?, ?, ?)`, id, tokenHash, JSON.stringify(grant), label, created_at, space);
    return { token, info: { ...grant, ...(label ? { label } : {}), created_at } };
  }

  /**
   * Revoke one of the space's own tokens (never the owner token, never another space's). A member key revoked this way
   * takes everything it minted with it (memberRevoke). `by` = a member asking: only keys that member minted.
   */
  async spaceRevoke(space: string, tokenId: string, by?: MemberRef): Promise<boolean> {
    const r = this.sql.exec<{ grant_json: string }>(`SELECT grant_json FROM tokens WHERE id = ? AND space = ? AND revoked_at IS NULL`, tokenId, space).toArray()[0];
    if (!r) return false;
    const g = JSON.parse(r.grant_json) as SpaceGrant;
    if (g.role === "owner") return false;
    if (by && g.member !== by.id) return false;
    if (g.role === "member") return (await this.memberRevoke(space, tokenId)) > 0;
    return this.revoke(tokenId);
  }

  /** Suspend a space (operator ban): every token (owner included) is revoked at once; its data is kept until the operator erases it. */
  async suspendSpace(space: string): Promise<boolean> {
    this.ensureSpaces();
    const now = new Date().toISOString();
    const n = this.sql.exec(`UPDATE spaces SET status = 'suspended', deleted_at = ? WHERE id = ? AND status = 'active'`, now, space).rowsWritten;
    this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE space = ? AND revoked_at IS NULL`, now, space);
    this.sql.exec(`DELETE FROM pairings WHERE space = ?`, space);
    this.sql.exec(`DELETE FROM invites WHERE space = ?`, space);
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
    this.sql.exec(`DELETE FROM invites WHERE space = ?`, space); // and so do open invites
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
    for (const repo of repos) this.sql.exec(`DELETE FROM repo_summaries WHERE repo = ?`, repo);
    this.sql.exec(`DELETE FROM repos WHERE space = ? OR (space IS NULL AND substr(repo, 1, ?) = ?)`, space, space.length + 1, `${space}-`);
    this.sql.exec(`DELETE FROM tokens WHERE space = ?`, space);
    // Retention counts (last event time, events per day) go with the space; the operator's internal tag stays so the first-run counts keep leaving it out.
    this.sql.exec(`DELETE FROM space_activity WHERE space = ?`, space);
    this.sql.exec(`DELETE FROM space_days WHERE space = ?`, space);
    // Billing rows (plan, Stripe customer id, monthly usage) go too. The Stripe customer record itself stays with Stripe (it holds invoices).
    this.sql.exec(`DELETE FROM usage WHERE space = ?`, space);
    this.sql.exec(`DELETE FROM space_billing WHERE space = ?`, space);
    // A web purchase claimed for this space goes too (its subscription was cancelled above, so it cannot be claimed again).
    this.sql.exec(`DELETE FROM claim_codes WHERE session IN (SELECT session FROM entitlements WHERE claimed_space = ?)`, space);
    this.sql.exec(`DELETE FROM entitlements WHERE claimed_space = ?`, space);
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

  /**
   * Every space for the operator. Billing columns: `plan`, `events_this_month`, and for Pro `seats`, `interval` and
   * `fair_use_exceeded_at` (when this month's events first passed seats x fair use; nothing is cut off, it is a flag).
   */
  async listSpaces(): Promise<Array<SpaceInfo & { repos: number; tokens: number; internal?: true; plan: Plan; events_this_month: number; seats?: number; interval?: Interval; fair_use_exceeded_at?: string }>> {
    this.ensureSpaces();
    const month = monthKey();
    return this.sql
      .exec<{ id: string; status: string; label: string | null; created_at: string; repos: number; tokens: number; internal: number; plan: string | null; product: string | null; seats: number | null; interval: string | null; events: number | null; fair_use_at: string | null }>(
        `SELECT s.id, s.status, s.label, s.created_at,
           (SELECT COUNT(*) FROM repos r WHERE r.space = s.id) AS repos,
           (SELECT COUNT(*) FROM tokens t WHERE t.space = s.id AND t.revoked_at IS NULL) AS tokens,
           COALESCE((SELECT internal FROM space_tags g WHERE g.space = s.id), 0) AS internal,
           b.plan, b.product, b.seats, b.interval, u.events, u.fair_use_at
         FROM spaces s LEFT JOIN space_billing b ON b.space = s.id LEFT JOIN usage u ON u.space = s.id AND u.month = ?
         ORDER BY s.created_at`,
        month,
      )
      .toArray()
      .map((r) => {
        const pro = r.plan === "paid" && r.product === "pro" && r.seats !== null;
        return {
          id: r.id,
          status: r.status as SpaceInfo["status"],
          created_at: r.created_at,
          ...(r.label ? { label: r.label } : {}),
          repos: r.repos,
          tokens: r.tokens,
          ...(r.internal ? { internal: true as const } : {}),
          plan: r.plan === "paid" ? ("paid" as const) : ("free" as const),
          events_this_month: r.events ?? 0,
          ...(pro ? { seats: r.seats!, interval: (r.interval === "year" ? "year" : "month") as Interval } : {}),
          ...(pro && r.fair_use_at ? { fair_use_exceeded_at: r.fair_use_at } : {}),
        };
      });
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

  // ------------------------------------------------------------------ billing (docs/pricing.md)
  //
  // The meter is agent events per space per UTC month. A `free` space is held at its allowance (the gateway
  // answers 429 over_allowance). A `paid` space is never held. Paid is Weft Pro (product 'pro': seats x a
  // per-user price, no event cut-off, a fair-use flag for the operator) or, for subscriptions from before
  // Pro, the legacy usage plan (product NULL: the overage above the allowance goes to a Stripe meter). The
  // Registry stores Stripe ids, seats and interval, and nothing else about the customer.

  private billingRow(space: string): { plan: Plan; allowance: number | null; customer: string | null; pro: boolean; seats: number | null; interval: Interval | null } {
    this.ensureSpaces();
    const r = this.sql
      .exec<{ plan: string; allowance: number | null; stripe_customer_id: string | null; product: string | null; seats: number | null; interval: string | null }>(
        `SELECT plan, allowance, stripe_customer_id, product, seats, interval FROM space_billing WHERE space = ?`,
        space,
      )
      .toArray()[0];
    const pro = r?.product === "pro";
    return {
      plan: r?.plan === "paid" ? "paid" : "free",
      allowance: r?.allowance ?? null,
      customer: r?.stripe_customer_id ?? null,
      pro,
      seats: pro ? (r?.seats ?? null) : null,
      interval: pro && isInterval(r?.interval) ? (r!.interval as Interval) : null,
    };
  }

  /** The space's usage this month against its allowance (free) or fair use (Pro). `over` is only acted on while billing is enabled. */
  usageState(space: string, now = Date.now()): UsageState {
    const month = monthKey(now);
    const b = this.billingRow(space);
    const events = this.sql.exec<{ events: number }>(`SELECT events FROM usage WHERE space = ? AND month = ?`, space, month).toArray()[0]?.events ?? 0;
    const allowance = b.allowance ?? freeEvents(this.env);
    const pro = b.plan === "paid" && b.pro && b.seats !== null;
    const fair = pro ? b.seats! * fairUsePerSeat(this.env) : null;
    return {
      month,
      events,
      allowance,
      plan: b.plan,
      over: b.plan === "free" && events >= allowance,
      has_billing_account: b.customer !== null,
      seats: pro ? b.seats : null,
      interval: pro ? b.interval : null,
      fair_use_events: fair,
      over_fair_use: fair !== null && events > fair,
    };
  }

  /** `GET /v1/space`: usage for an active space. */
  async spaceUsage(space: string): Promise<UsageState | undefined> {
    return this.activeSpace(space) ? this.usageState(space) : undefined;
  }

  /**
   * Add metered events (the gateway coalesces them). Unknown or deleted spaces are ignored. Returns each
   * space's state so the gateway can start refusing at once instead of when its grant cache expires. A Pro
   * space that goes past fair use this month is flagged once (fair_use_at); nothing is refused.
   */
  async recordUsage(items: Array<[string, number]>, now = Date.now()): Promise<Record<string, UsageState>> {
    this.ensureSpaces();
    const month = monthKey(now);
    const out: Record<string, UsageState> = {};
    let wantReport = false;
    for (const [space, n] of items) {
      if (!Number.isInteger(n) || n <= 0 || !this.activeSpace(space)) continue;
      this.sql.exec(`INSERT INTO usage (space, month, events) VALUES (?, ?, ?) ON CONFLICT(space, month) DO UPDATE SET events = events + excluded.events`, space, month, n);
      const st = this.usageState(space, now);
      out[space] = st;
      if (st.over_fair_use) this.sql.exec(`UPDATE usage SET fair_use_at = ? WHERE space = ? AND month = ? AND fair_use_at IS NULL`, new Date(now).toISOString(), space, month);
      // Only the legacy usage plan reports overage to a Stripe meter; Pro is a flat per-seat price.
      if (st.has_billing_account && !this.billingRow(space).pro) wantReport = true;
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
   * Before an erase: report what a legacy usage plan owes and cancel the subscription (Pro has nothing metered to
   * report). Returns an error text if Stripe could not do it (the erase then retries from the alarm), undefined when
   * done or when there is nothing to settle. Without Stripe secrets on this gateway nothing can be cancelled: that is
   * logged and the erase goes on, because erasure must not wait for billing.
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
  billingSummary(): {
    month: string;
    plans: { free: number; paid: number };
    pro: { spaces: number; seats: number; over_fair_use: number };
    with_billing_account: number;
    events_this_month: number;
    active_this_month: number;
    over_allowance: number;
    purchases_unclaimed: number;
  } {
    this.ensureSpaces();
    const month = monthKey();
    const active = this.sql.exec<{ id: string }>(`SELECT id FROM spaces WHERE status = 'active'`).toArray();
    const paid = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM space_billing b JOIN spaces s ON s.id = b.space WHERE b.plan = 'paid' AND s.status = 'active'`).one().n;
    const withAccount = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM space_billing b JOIN spaces s ON s.id = b.space WHERE b.stripe_customer_id IS NOT NULL AND s.status = 'active'`).one().n;
    const pro = this.sql
      .exec<{ n: number; seats: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(b.seats), 0) AS seats FROM space_billing b JOIN spaces s ON s.id = b.space WHERE b.plan = 'paid' AND b.product = 'pro' AND s.status = 'active'`)
      .one();
    const u = this.sql.exec<{ n: number; e: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(events), 0) AS e FROM usage WHERE month = ?`, month).one();
    const states = active.map((s) => this.usageState(s.id));
    const unclaimed = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM entitlements WHERE claimed_space IS NULL AND plan = 'paid'`).one().n;
    return {
      month,
      plans: { free: active.length - paid, paid },
      pro: { spaces: pro.n, seats: pro.seats, over_fair_use: states.filter((s) => s.over_fair_use).length },
      with_billing_account: withAccount,
      events_this_month: u.e,
      active_this_month: u.n,
      over_allowance: states.filter((s) => s.over).length,
      purchases_unclaimed: unclaimed,
    };
  }

  /** Whether a Stripe event id was already applied (lets the webhook skip a Stripe read for a replay). */
  billingEventSeen(id: string): boolean {
    this.ensureSpaces();
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM stripe_events WHERE id = ?`, id).one().n > 0;
  }

  /** The Stripe customer attached to a space, if any (for the portal and for cancelling). */
  stripeCustomer(space: string): string | null {
    return this.activeSpace(space) ? this.billingRow(space).customer : null;
  }

  /**
   * Apply one verified Stripe event, once. `space` is set for checkout sessions started from a space (the
   * client_reference_id we put on them); other events carry only a customer, which must be one we attached to a
   * space or to an unclaimed web purchase. `pro` (seats, interval) is set when the event says what the
   * subscription now is. Idempotent on the event id; an event older than the last applied one changes nothing
   * (Stripe does not promise ordering). Runs in one synchronous step, so the id and the change cannot be separated.
   */
  applyBillingEvent(e: { id: string; created: number; space?: string; customer?: string; plan: Plan; pro?: { seats: number; interval: Interval } }): {
    result: "applied" | "duplicate" | "ignored" | "stale";
    space?: string;
    purchase?: true;
  } {
    this.ensureSpaces();
    let space = e.space;
    if (space !== undefined) {
      if (!this.activeSpace(space)) return { result: "ignored" };
    } else if (e.customer) {
      space = this.sql.exec<{ space: string }>(`SELECT space FROM space_billing WHERE stripe_customer_id = ?`, e.customer).toArray()[0]?.space;
      if (!space) {
        // A web purchase that nobody has claimed yet: keep its plan and seats current until it is.
        const ent = this.sql.exec<{ session: string }>(`SELECT session FROM entitlements WHERE customer = ? AND claimed_space IS NULL`, e.customer).toArray()[0];
        if (!ent) return { result: "ignored" };
        if (this.sql.exec(`INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?, ?)`, e.id, Math.floor(Date.now() / 1000)).rowsWritten === 0) return { result: "duplicate", purchase: true };
        const moved = this.sql.exec(
          `UPDATE entitlements SET plan = ?, seats = COALESCE(?, seats), interval = COALESCE(?, interval), billing_event_at = ? WHERE session = ? AND billing_event_at <= ?`,
          e.plan,
          e.pro?.seats ?? null,
          e.pro?.interval ?? null,
          e.created,
          ent.session,
          e.created,
        ).rowsWritten;
        return { result: moved > 0 ? "applied" : "stale", purchase: true };
      }
      if (!this.activeSpace(space)) return { result: "ignored" };
    } else return { result: "ignored" };
    if (this.sql.exec(`INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?, ?)`, e.id, Math.floor(Date.now() / 1000)).rowsWritten === 0) return { result: "duplicate", space };
    this.sql.exec(`INSERT OR IGNORE INTO space_billing (space) VALUES (?)`, space);
    if (e.space !== undefined && e.customer) this.sql.exec(`UPDATE space_billing SET stripe_customer_id = ? WHERE space = ?`, e.customer, space);
    const moved = e.pro
      ? this.sql.exec(
          `UPDATE space_billing SET plan = ?, product = 'pro', seats = ?, interval = ?, billing_event_at = ? WHERE space = ? AND billing_event_at <= ?`,
          e.plan,
          e.pro.seats,
          e.pro.interval,
          e.created,
          space,
          e.created,
        ).rowsWritten
      : this.sql.exec(`UPDATE space_billing SET plan = ?, billing_event_at = ? WHERE space = ? AND billing_event_at <= ?`, e.plan, e.created, space, e.created).rowsWritten;
    return { result: moved > 0 ? "applied" : "stale", space };
  }

  // ------------------------------------------------------------------ web-first purchases and claim codes
  //
  // GET /buy sells Weft Pro before there is a space. Stripe's `checkout.session.completed` (or the welcome page,
  // if it gets there first) records the purchase here as an entitlement. The welcome page trades the Checkout
  // Session id for a one-time claim code, and `npx @celador/weft --hosted --claim <code>` binds the purchase to a
  // space. A claimed purchase stays as a row so it can never be claimed again; the code itself is stored only as
  // a salted hash, expires in an hour, and is single use.

  /**
   * Record a paid web purchase (idempotent on the session id; with `eventId`, also on the Stripe event). A newer
   * report of the same purchase updates plan and seats while it is unclaimed; a claimed one is not touched here
   * (later changes reach it through its customer, applyBillingEvent).
   */
  recordPurchase(p: { session: string; customer: string; subscription: string; seats: number; interval: Interval; plan: Plan; created: number; eventId?: string; utm?: Utm }): { result: "applied" | "duplicate" | "stale" } {
    this.ensureSpaces();
    if (p.eventId && this.sql.exec(`INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?, ?)`, p.eventId, Math.floor(Date.now() / 1000)).rowsWritten === 0) return { result: "duplicate" };
    const n = this.sql.exec(
      `INSERT INTO entitlements (session, customer, subscription, seats, interval, plan, billing_event_at, created_at, utm_source, utm_campaign) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session) DO UPDATE SET plan = excluded.plan, seats = excluded.seats, interval = excluded.interval, billing_event_at = excluded.billing_event_at
       WHERE entitlements.claimed_space IS NULL AND entitlements.billing_event_at <= excluded.billing_event_at`,
      p.session,
      p.customer,
      p.subscription,
      p.seats,
      p.interval,
      p.plan,
      p.created,
      new Date().toISOString(),
      p.utm?.source ?? null,
      p.utm?.campaign ?? null,
    ).rowsWritten;
    return { result: n > 0 ? "applied" : "stale" };
  }

  /** Where a web purchase stands, by its Checkout Session id. Never returns Stripe ids or the space. */
  purchase(session: string): { status: "unknown" | "claimed" | "inactive" | "claimable"; seats?: number; interval?: Interval; utm?: Utm } {
    this.ensureSpaces();
    const r = this.sql
      .exec<{ seats: number; interval: string; plan: string; claimed_space: string | null; utm_source: string | null; utm_campaign: string | null }>(
        `SELECT seats, interval, plan, claimed_space, utm_source, utm_campaign FROM entitlements WHERE session = ?`,
        session,
      )
      .toArray()[0];
    if (!r) return { status: "unknown" };
    const utm: Utm = { ...(r.utm_source ? { source: r.utm_source } : {}), ...(r.utm_campaign ? { campaign: r.utm_campaign } : {}) };
    const facts = { seats: r.seats, interval: (r.interval === "year" ? "year" : "month") as Interval, utm };
    if (r.claimed_space) return { status: "claimed", ...facts };
    return { status: r.plan === "paid" ? "claimable" : "inactive", ...facts };
  }

  private claimSalt(): string {
    this.ensureSpaces();
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'claim_salt'`).toArray()[0];
    if (row) return row.value;
    const salt = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('claim_salt', ?)`, salt);
    return this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'claim_salt'`).one().value;
  }

  /** A fresh one-time claim code for an unclaimed, paid purchase (one hour, one use; at most 3 open per purchase). */
  async claimCodeCreate(session: string): Promise<{ code: string; expires_at: string; seats: number; interval: Interval; utm: Utm } | { error: string; code: "unknown" | "claimed" | "inactive" }> {
    const st = this.purchase(session);
    if (st.status === "unknown") return { error: "no paid Weft Pro checkout with that id (yet): if you just paid, try again in a few seconds", code: "unknown" };
    if (st.status === "claimed") return { error: "this purchase is already claimed by a space; manage it with `npx @celador/weft billing` in that repo", code: "claimed" };
    if (st.status === "inactive") return { error: "this purchase's subscription is not active (cancelled or unpaid)", code: "inactive" };
    const code = claimCode();
    const hash = await sha256Hex(claimSaltText(this.claimSalt(), normalizeCode(code)));
    const now = Date.now();
    this.sql.exec(`DELETE FROM claim_codes WHERE expires_at <= ?`, new Date(now).toISOString());
    const open = this.sql.exec<{ id: string }>(`SELECT id FROM claim_codes WHERE session = ? ORDER BY created_at DESC`, session).toArray();
    for (const old of open.slice(MAX_OPEN_CLAIMS - 1)) this.sql.exec(`DELETE FROM claim_codes WHERE id = ?`, old.id);
    const expires_at = new Date(now + CLAIM_TTL_MS).toISOString();
    this.sql.exec(`INSERT INTO claim_codes (id, session, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, `cc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, session, hash, new Date(now).toISOString(), expires_at);
    return { code, expires_at, seats: st.seats!, interval: st.interval!, utm: st.utm ?? {} };
  }

  /**
   * Bind the purchase behind a claim code to `space`: the space becomes Pro with the purchase's seats. The code is
   * compared in constant time against every open code (no early exit) and consumed in the same synchronous step that
   * found it, so two requests can never both win it. Every bad or expired code gets the same answer.
   */
  async claimRedeem(
    space: string,
    code: string,
  ): Promise<
    | { space: string; seats: number; interval: Interval; customer: string; subscription: string | null }
    | { error: string; code: "invalid" | "gone" | "already_paid" | "inactive" }
  > {
    const hash = await sha256Hex(claimSaltText(this.claimSalt(), normalizeCode(code)));
    // ---- no await below this line
    this.ensureSpaces();
    const nowIso = new Date().toISOString();
    const rows = this.sql.exec<{ id: string; session: string; code_hash: string }>(`SELECT id, session, code_hash FROM claim_codes WHERE expires_at > ? LIMIT 5000`, nowIso).toArray();
    let hit: { id: string; session: string } | undefined;
    for (const r of rows.length ? rows : [{ id: "", session: "", code_hash: "0".repeat(64) }]) if (constantTimeEqual(r.code_hash, hash) && r.id) hit = r;
    const invalid = { error: "that claim code is not valid or has expired; get a new one from the welcome page", code: "invalid" as const };
    if (!hit) return invalid;
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    const ent = this.sql
      .exec<{ customer: string | null; subscription: string | null; seats: number; interval: string; plan: string; billing_event_at: number; claimed_space: string | null }>(
        `SELECT customer, subscription, seats, interval, plan, billing_event_at, claimed_space FROM entitlements WHERE session = ?`,
        hit.session,
      )
      .toArray()[0];
    if (!ent || ent.claimed_space || !ent.customer) return invalid;
    if (ent.plan !== "paid") return { error: "this purchase's subscription is not active (cancelled or unpaid)", code: "inactive" };
    const b = this.billingRow(space);
    if (b.plan === "paid") return { error: "this space already has a paid plan; claim the purchase from another repo, or manage this one with `npx @celador/weft billing`", code: "already_paid" };
    if (this.sql.exec(`DELETE FROM claim_codes WHERE id = ?`, hit.id).rowsWritten !== 1) return invalid;
    this.sql.exec(`DELETE FROM claim_codes WHERE session = ?`, hit.session);
    this.sql.exec(`UPDATE entitlements SET claimed_space = ?, claimed_at = ? WHERE session = ?`, space, nowIso, hit.session);
    const interval: Interval = ent.interval === "year" ? "year" : "month";
    this.sql.exec(
      `INSERT INTO space_billing (space, plan, stripe_customer_id, billing_event_at, product, seats, interval) VALUES (?, 'paid', ?, ?, 'pro', ?, ?)
       ON CONFLICT(space) DO UPDATE SET plan = 'paid', stripe_customer_id = excluded.stripe_customer_id, billing_event_at = MAX(space_billing.billing_event_at, excluded.billing_event_at), product = 'pro', seats = excluded.seats, interval = excluded.interval`,
      space,
      ent.customer,
      ent.billing_event_at,
      ent.seats,
      interval,
    );
    return { space, seats: ent.seats, interval, customer: ent.customer, subscription: ent.subscription };
  }

  /**
   * Send the overage of every legacy usage-plan space with a Stripe customer to its meter (all of them, or just
   * `only`). Pro spaces are never metered. Each space's window (from, to] is written down BEFORE the call and reused
   * until Stripe accepts it, and the meter event's identifier is built from the window, so a retry after a lost
   * answer is the same event to Stripe (it drops duplicates of an identifier for 24 hours) and the cursor only
   * moves on success.
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
         WHERE b.stripe_customer_id IS NOT NULL AND b.product IS NULL ${only ? "AND u.space = ?" : ""} ORDER BY u.space, u.month`,
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
        // Stripe answers a repeated identifier with 400 "An event already exists with identifier ..." (seen in test mode): an
        // earlier attempt got through and only its answer was lost. That window is reported, so move on instead of retrying forever.
        if (e instanceof StripeError && e.status === 400 && /already exists with identifier/i.test(e.message)) {
          this.sql.exec(`UPDATE usage SET reported = ?, pending_from = NULL, pending_to = NULL WHERE space = ? AND month = ?`, to, r.space, r.month);
          res.sent++;
          res.events += to - from;
          continue;
        }
        res.failed++;
        console.error("billing: meter event failed", r.space, r.month, e instanceof Error ? e.message : String(e));
      }
    }
    return res;
  }

  /**
   * Counters of months more than ~2 months old that carry nothing left to bill: everything except a legacy
   * usage-plan space's unreported overage. Unclaimed web purchases whose subscription ended go after 30 days.
   */
  private pruneUsage(now = Date.now()): void {
    this.sql.exec(
      `DELETE FROM usage WHERE month < ? AND pending_to IS NULL AND (
         NOT EXISTS (SELECT 1 FROM space_billing b WHERE b.space = usage.space AND b.stripe_customer_id IS NOT NULL AND b.product IS NULL)
         OR reported >= events - COALESCE((SELECT allowance FROM space_billing b WHERE b.space = usage.space), ?))`,
      monthKey(now - 62 * 86_400_000),
      freeEvents(this.env),
    );
    this.sql.exec(`DELETE FROM entitlements WHERE claimed_space IS NULL AND plan != 'paid' AND created_at < ?`, new Date(now - 30 * 86_400_000).toISOString());
    this.sql.exec(`DELETE FROM claim_codes WHERE expires_at <= ?`, new Date(now).toISOString());
  }

  private prunedMonth = "";

  /** Alarm work: report legacy usage, drop old Stripe event ids and fully reported months, and arm the next run. */
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
       WHERE b.stripe_customer_id IS NOT NULL AND b.product IS NULL AND (u.pending_to IS NOT NULL OR u.events - COALESCE(b.allowance, ?) > u.reported)`,
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
    // `by`: the handle of the member who paired it (none = the owner).
    return this.sql
      .exec<{ id: string; label: string | null; created_at: string; last_seen_at: string | null; expires_at: string; hard_expires_at: string; by: string | null }>(
        `SELECT t.id, t.label, t.created_at, t.last_seen_at, t.expires_at, t.hard_expires_at,
           (SELECT json_extract(m.grant_json, '$.handle') FROM tokens m WHERE m.id = json_extract(t.grant_json, '$.member')) AS by
         FROM tokens t
         WHERE t.space = ? AND t.kind = 'device' AND t.revoked_at IS NULL AND t.expires_at > ? ORDER BY t.created_at`,
        space,
        now.toISOString(),
      )
      .toArray()
      .map((r) => ({ id: r.id, label: r.label ?? "", created_at: r.created_at, last_seen_at: r.last_seen_at ?? r.created_at, expires_at: r.expires_at, hard_expires_at: r.hard_expires_at, ...(r.by ? { by: r.by } : {}) }));
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
  private insertDevice(space: string, tokenHash: string, label: string, member?: string): DeviceInfo {
    const id = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    const created_at = new Date(now).toISOString();
    const expires_at = new Date(now + SESSION_TTL_MS).toISOString();
    const hard_expires_at = new Date(now + SESSION_HARD_MS).toISOString();
    const grant: SpaceGrant = { id, principal: `space:${space}:device`, scopes: ["observe"], repos: [], space, role: "device", ...(member ? { member } : {}) };
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
  async deviceCreate(space: string, label: string, maxDevices: number, by?: MemberRef): Promise<{ token: string; device: DeviceInfo } | { error: string; code: "gone" | "quota" }> {
    const token = randomDeviceToken();
    const hash = await sha256Hex(token);
    this.ensureSpaces();
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    if (by && !this.memberActive(space, by.id)) return { error: "this member key was removed from the space", code: "gone" };
    if (this.deviceRows(space).length >= maxDevices) return { error: `a space holds at most ${maxDevices} paired devices; revoke some with \`npx @celador/weft viewers revoke --all\``, code: "quota" };
    return { token, device: this.insertDevice(space, hash, cleanLabel(label, "device"), by?.id) };
  }

  /** A fresh one-time pairing code for the feed page (10 minutes, one use). At most 3 are outstanding. */
  async pairingCreate(space: string, by?: MemberRef): Promise<{ code: string; expires_at: string; expires_in: number } | { error: string; code: "gone" }> {
    const code = pairingCode();
    const hash = await sha256Hex(pairingSalt(space, normalizeCode(code)));
    this.ensureSpaces();
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    if (by && !this.memberActive(space, by.id)) return { error: "this member key was removed from the space", code: "gone" };
    const now = Date.now();
    this.sql.exec(`DELETE FROM pairings WHERE expires_at <= ?`, new Date(now).toISOString());
    const open = this.sql.exec<{ id: string }>(`SELECT id FROM pairings WHERE space = ? ORDER BY created_at DESC`, space).toArray();
    for (const old of open.slice(MAX_OPEN_PAIRINGS - 1)) this.sql.exec(`DELETE FROM pairings WHERE id = ?`, old.id);
    const expires_at = new Date(now + PAIRING_TTL_MS).toISOString();
    this.sql.exec(`INSERT INTO pairings (id, space, code_hash, created_at, expires_at, member) VALUES (?, ?, ?, ?, ?, ?)`, `pr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, space, hash, new Date(now).toISOString(), expires_at, by?.id ?? null);
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
    const rows = this.sql.exec<{ id: string; code_hash: string; member: string | null }>(`SELECT id, code_hash, member FROM pairings WHERE space = ? AND expires_at > ?`, req.space, nowIso).toArray();
    let hit: string | undefined;
    let member: string | null = null;
    for (const r of rows.length ? rows : [{ id: "", code_hash: "0".repeat(64), member: null }])
      if (constantTimeEqual(r.code_hash, hash) && r.id) {
        hit = r.id;
        member = r.member;
      }
    const space = this.activeSpace(req.space);
    if (!hit || !space) return { error: "that pairing code is not valid or has expired", code: "invalid" };
    // A code a member minted dies with the member (they were removed after minting it).
    if (member && !this.memberActive(req.space, member)) return { error: "that pairing code is not valid or has expired", code: "invalid" };
    if (this.hostedModeNow() === "off") return { error: "hosted spaces are switched off on this gateway", code: "closed" };
    if (this.deviceRows(req.space).length >= req.maxDevices) return { error: `this space already has ${req.maxDevices} paired devices; revoke one with \`npx @celador/weft viewers revoke <id>\` first`, code: "quota" };
    if (this.sql.exec(`DELETE FROM pairings WHERE id = ?`, hit).rowsWritten !== 1) return { error: "that pairing code is not valid or has expired", code: "invalid" };
    this.sql.exec(`DELETE FROM pairings WHERE expires_at <= ?`, nowIso);
    return { token, device: this.insertDevice(req.space, tokenHash, cleanLabel(req.label, "browser"), member ?? undefined) };
  }

  // ------------------------------------------------------------------ team members (invite codes -> member keys)
  //
  // The owner mints a one-time invite code (`inviteCreate`); a teammate on another machine trades it, with no other
  // credential (`inviteExchange`, POST /v1/join, rate limited in spaces.ts), for a *member key*. A member key reads the
  // space and sets up checkouts: it mints agent keys whose id ends in `.<handle>` (unique per member in the space, so
  // two people's agents are always checked against each other), a read session for its own CLI and pairing codes for
  // its own browsers. It cannot add repos, mint landing keys, invite, list or remove anyone, touch billing or erase the
  // space. Removing a member revokes its key and everything it minted, in one step.

  /** Whether `id` is a live member key of `space`. Synchronous, so callers can check and write in one step. */
  private memberActive(space: string, id: string): boolean {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE id = ? AND space = ? AND kind = 'member' AND revoked_at IS NULL`, id, space).one().n > 0;
  }

  private memberRows(space: string): MemberInfo[] {
    return this.sql
      .exec<{ id: string; label: string | null; grant_json: string; created_at: string; last_seen_at: string | null }>(
        `SELECT id, label, grant_json, created_at, last_seen_at FROM tokens WHERE space = ? AND kind = 'member' AND revoked_at IS NULL ORDER BY created_at`,
        space,
      )
      .toArray()
      .map((r) => ({ id: r.id, label: r.label ?? "", handle: (JSON.parse(r.grant_json) as SpaceGrant).handle ?? "", created_at: r.created_at, last_seen_at: r.last_seen_at ?? r.created_at }));
  }

  /** The space's members (owner view): id, label, handle, joined, last used. */
  async members(space: string): Promise<MemberInfo[]> {
    this.ensureSpaces();
    return this.activeSpace(space) ? this.memberRows(space) : [];
  }

  /** One member, for `GET /v1/space` asked with that member's key. */
  async memberInfo(space: string, id: string): Promise<MemberInfo | undefined> {
    this.ensureSpaces();
    return this.activeSpace(space) ? this.memberRows(space).find((m) => m.id === id) : undefined;
  }

  /**
   * Remove a member (or every member, with `*`): its key, and every agent key, CLI read session and paired browser it
   * minted, are revoked in this one step, and its open pairing codes are dropped. Returns the number of keys revoked
   * (0 = no such member).
   */
  async memberRevoke(space: string, id: string): Promise<number> {
    this.ensureSpaces();
    const ids = id === "*" ? this.memberRows(space).map((m) => m.id) : this.memberActive(space, id) ? [id] : [];
    const now = new Date().toISOString();
    let n = 0;
    for (const m of ids) {
      n += this.sql.exec(`UPDATE tokens SET revoked_at = ? WHERE space = ? AND revoked_at IS NULL AND (id = ? OR json_extract(grant_json, '$.member') = ?)`, now, space, m, m).rowsWritten;
      this.sql.exec(`DELETE FROM pairings WHERE space = ? AND member = ?`, space, m);
    }
    return n;
  }

  /** A fresh one-time invite code (INVITE_TTL_MS, one use). At most MAX_OPEN_INVITES are open; minting another retires the oldest. */
  async inviteCreate(space: string): Promise<{ code: string; expires_at: string; expires_in: number } | { error: string; code: "gone" }> {
    const code = pairingCode();
    const hash = await sha256Hex(inviteSaltText(this.claimSalt(), space, normalizeCode(code)));
    this.ensureSpaces();
    if (!this.activeSpace(space)) return { error: "space not found", code: "gone" };
    const now = Date.now();
    this.sql.exec(`DELETE FROM invites WHERE expires_at <= ?`, new Date(now).toISOString());
    const open = this.sql.exec<{ id: string }>(`SELECT id FROM invites WHERE space = ? ORDER BY created_at DESC, rowid DESC`, space).toArray();
    for (const old of open.slice(MAX_OPEN_INVITES - 1)) this.sql.exec(`DELETE FROM invites WHERE id = ?`, old.id);
    const expires_at = new Date(now + INVITE_TTL_MS).toISOString();
    this.sql.exec(`INSERT INTO invites (id, space, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, space, hash, new Date(now).toISOString(), expires_at);
    return { code, expires_at, expires_in: INVITE_TTL_MS / 1000 };
  }

  /** Drop every open invite code of a space. */
  async inviteCancelAll(space: string): Promise<number> {
    this.ensureSpaces();
    return this.sql.exec(`DELETE FROM invites WHERE space = ?`, space).rowsWritten;
  }

  /**
   * Trade an invite code for a member key. Like pairingExchange: the code is compared in constant time against every
   * open invite of the space (no early exit) and consumed in the same synchronous step that found it, so two requests
   * can never both win it; every failure looks the same; a full space does not burn the code.
   */
  async inviteExchange(req: { space: string; code: string; label: string; handle?: string; maxMembers: number; maxTokens: number }): Promise<{ token: string; member: MemberInfo } | { error: string; code: "invalid" | "quota" | "closed" }> {
    const salt = this.claimSalt();
    const hash = await sha256Hex(inviteSaltText(salt, req.space, normalizeCode(req.code)));
    const token = randomToken(); // minted whether or not the code matches: same work either way
    const tokenHash = await sha256Hex(token);
    // ---- no await below this line: select, compare, consume and insert happen in one step
    this.ensureSpaces();
    const nowIso = new Date().toISOString();
    const rows = this.sql.exec<{ id: string; code_hash: string }>(`SELECT id, code_hash FROM invites WHERE space = ? AND expires_at > ?`, req.space, nowIso).toArray();
    let hit: string | undefined;
    for (const r of rows.length ? rows : [{ id: "", code_hash: "0".repeat(64) }]) if (constantTimeEqual(r.code_hash, hash) && r.id) hit = r.id;
    const invalid = { error: "that invite code is not valid or has expired; ask the space's owner for a new one (npx @celador/weft invite)", code: "invalid" as const };
    if (!hit || !this.activeSpace(req.space)) return invalid;
    if (this.hostedModeNow() === "off") return { error: "hosted spaces are switched off on this gateway", code: "closed" };
    if (this.memberRows(req.space).length >= req.maxMembers) return { error: `this space already has ${req.maxMembers} members; its owner can remove one with \`npx @celador/weft members revoke <id>\``, code: "quota" };
    const active = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tokens WHERE space = ? AND revoked_at IS NULL AND kind IS NOT 'device'`, req.space).one().n;
    if (active >= req.maxTokens) return { error: `this space holds at most ${req.maxTokens} active keys; its owner can free some with \`npx @celador/weft uninstall\` in checkouts no longer used`, code: "quota" };
    if (this.sql.exec(`DELETE FROM invites WHERE id = ?`, hit).rowsWritten !== 1) return invalid;
    this.sql.exec(`DELETE FROM invites WHERE expires_at <= ?`, nowIso);
    const label = cleanLabel(req.label, "teammate");
    const handle = this.uniqueHandle(req.space, cleanHandle(req.handle || label));
    const id = `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const grant: SpaceGrant = { id, principal: `space:${req.space}:member:${handle}`, scopes: [], repos: [], space: req.space, role: "member", handle };
    this.sql.exec(
      `INSERT INTO tokens (id, hash, grant_json, label, created_at, space, kind, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 'member', ?)`,
      id,
      tokenHash,
      JSON.stringify(grant),
      label,
      nowIso,
      req.space,
      nowIso,
    );
    return { token, member: { id, label, handle, created_at: nowIso, last_seen_at: nowIso } };
  }

  /** `base`, or `base-2`, `base-3`, ...: never a handle any member of the space has had (removed ones included), so history stays unambiguous. */
  private uniqueHandle(space: string, base: string): string {
    const taken = new Set(
      this.sql
        .exec<{ h: string | null }>(`SELECT json_extract(grant_json, '$.handle') AS h FROM tokens WHERE space = ? AND kind = 'member'`, space)
        .toArray()
        .map((r) => r.h)
        .filter((h): h is string => !!h),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const h = `${base.slice(0, HANDLE_MAX - String(i).length - 1)}-${i}`;
      if (!taken.has(h)) return h;
    }
  }
}

/** How often a space with a Stripe customer and unreported overage is reported. */
export const REPORT_EVERY_MS = 3_600_000;

export type HostedMode = "open" | "no-signups" | "off";
/** Which marketing link sold a web purchase (from the /buy link's utm_source / utm_campaign). */
export type Utm = { source?: string; campaign?: string };
export type SignupLimits = { perIpDay: number; perDay: number; maxSpaces: number };
export type SpaceInfo = { id: string; status: "active" | "deleted" | "suspended" | "erasing" | "erased"; label?: string; created_at: string };
/** What an erasure removed. After it, the Registry keeps only the tombstone: space id, status 'erased', deleted_at, created_at (date only). */
export type EraseReport = { space: string; status: "erased"; already_erased: boolean; erased: { repos: string[]; events: number; tokens: number } };
/**
 * A grant minted for a hosted space. `role` owner = the space API only (no WCP scopes); member = a teammate's key, a
 * subset of the space API (no WCP scopes either), with its `handle`. `member` on an agent key or device session = the
 * member key that minted it (it is revoked with that member).
 */
export type SpaceGrant = Grant & { space?: string; role?: "owner" | "member" | "agent" | "system" | "viewer" | "device"; over_allowance?: boolean; handle?: string; member?: string };
/** A paired device (a browser, or a CLI's read session): what `weft viewers` lists. `by` = the member who paired it. */
export type DeviceInfo = { id: string; label: string; created_at: string; last_seen_at: string; expires_at: string; hard_expires_at: string; by?: string };
/** A teammate who joined the space with an invite code: what `weft members` lists. */
export type MemberInfo = { id: string; label: string; handle: string; created_at: string; last_seen_at: string };
/** Who is asking, when a member key calls the space API. */
export type MemberRef = { id: string; handle: string };

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

/** Invite codes (team join): the pairing code's format (10 symbols, ~2^49), 30 minutes, single use, at most 5 open per space. */
export const INVITE_TTL_MS = 30 * 60_000;
const MAX_OPEN_INVITES = 5;
/** The hashed text of an invite code: the per-Registry random salt, the space, and the normalized code. */
const inviteSaltText = (salt: string, space: string, normalized: string) => `weft-invite:${salt}:${space}:${normalized}`;

/** A member's handle: lowercase letters, digits and '-', at most HANDLE_MAX, from what the teammate sent (or their label). */
const HANDLE_MAX = 20;
export function cleanHandle(s: unknown): string {
  const t = typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, HANDLE_MAX).replace(/-+$/, "") : "";
  return t || "member";
}

/** `base` as a member's agent id: `<base>.<handle>`, cut to the 64-char agent id limit. */
export function slugAgent(base: string, handle: string): string {
  const b = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "agent";
  return `${b.slice(0, 63 - handle.length)}.${handle}`;
}

/** Claim codes (web purchases): 12 symbols of the same alphabet (~2^59), one hour, single use, at most 3 open per purchase. */
export const CLAIM_TTL_MS = 60 * 60_000;
const CLAIM_LEN = 12;
const MAX_OPEN_CLAIMS = 3;

/** `XXXX-XXXX-XXXX`, uniform over the alphabet. */
function claimCode(): string {
  let out = "";
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CLAIM_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(24))) {
      if (b < limit && out.length < CLAIM_LEN) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** The hashed text of a claim code: a per-Registry random salt (settings.claim_salt) and the normalized code. */
const claimSaltText = (salt: string, normalized: string) => `weft-claim:${salt}:${normalized}`;

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
