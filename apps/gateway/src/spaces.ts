// Hosted spaces (`npx weft`): anonymous, free tenants on a shared gateway. No login and no
// third-party identity: POST /v1/spaces returns a space owner token, which is the only key.
//
//   POST   /v1/spaces                  create a space (open signups, or the admin token)
//   GET    /v1/space                   the space, its repos, token count, limits
//   POST   /v1/space/repos             {name} -> repo `<space>-<name>` (idempotent)
//   POST   /v1/space/tokens            {kind: agent|system|viewer, repo?, agent?, label?}
//   DELETE /v1/space/tokens/{id}       revoke one of the space's tokens
//   DELETE /v1/space                   delete the space (every token revoked)
//   GET    /v1/admin/stats             new spaces per day (= first runs of `npx weft`)
//   GET    /feed                       the private live feed page (viewer token in the #fragment)
//
// Abuse limits, all configurable with vars: signups per network per day, signups per day, total
// spaces, repos and active tokens per space, and requests per minute per space (the
// Workers Rate Limiting binding WEFT_RATE when bound, else a per-isolate window). Kill
// switch: WEFT_HOSTED_OFF=1 (deploy-time, refuses every space request without a DO call) or
// POST /v1/admin/hosted {"mode": "open" | "no-signups" | "off"} (instant, no redeploy).

import type { Registry, SpaceGrant } from "./registry";
import { FEED_HTML } from "./feed-page";

export interface SpacesEnv {
  WEFT_REGISTRY: DurableObjectNamespace<Registry>;
  WEFT_ADMIN_TOKEN?: string;
  /** "open" = anyone may create a space (the hosted gateway). Anything else: admin token only. */
  WEFT_SIGNUPS?: string;
  /** "1" = hosted spaces are switched off (deploy-time kill switch). */
  WEFT_HOSTED_OFF?: string;
  WEFT_SIGNUPS_PER_IP_DAY?: string;
  /** Secret behind the daily-rotating network key for signup counters (falls back to WEFT_ADMIN_TOKEN). */
  WEFT_SIGNUP_SECRET?: string;
  WEFT_SIGNUPS_PER_DAY?: string;
  WEFT_MAX_SPACES?: string;
  WEFT_SPACE_MAX_REPOS?: string;
  WEFT_SPACE_MAX_TOKENS?: string;
  WEFT_SPACE_RPM?: string;
  /** Workers Rate Limiting binding keyed by space id (optional). */
  WEFT_RATE?: RateLimit;
  /** Workers Rate Limiting binding keyed by client IP for POST /v1/spaces (optional). */
  WEFT_SIGNUP_RATE?: RateLimit;
}

type Fail = (code: "unauthorized" | "forbidden" | "not_found" | "invalid_message" | "rate_limited" | "unavailable" | "repo_not_found", message: string, details?: Record<string, unknown>) => never;
export type SpacesKit = {
  fail: Fail;
  json: (body: unknown, status?: number, extra?: Record<string, string>) => Response;
  readJson: (req: Request, optional?: boolean) => Promise<unknown>;
  authenticate: (req: Request) => Promise<SpaceGrant>;
  bearer: (req: Request) => string | undefined;
  isAdmin: (token: string | undefined) => boolean;
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

export function limits(env: SpacesEnv) {
  return {
    perIpDay: num(env.WEFT_SIGNUPS_PER_IP_DAY, 20),
    perDay: num(env.WEFT_SIGNUPS_PER_DAY, 2000),
    maxSpaces: num(env.WEFT_MAX_SPACES, 20000),
    maxRepos: num(env.WEFT_SPACE_MAX_REPOS, 20),
    maxTokens: num(env.WEFT_SPACE_MAX_TOKENS, 200),
    rpm: num(env.WEFT_SPACE_RPM, 1200),
  };
}

function registry(env: SpacesEnv) {
  return env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
}

// Per-isolate fixed window, used when no Rate Limiting binding is configured (local, tests,
// `weft deploy` without the binding). Cloudflare runs many isolates, so it is a floor, not a cap.
const windows = new Map<string, { start: number; n: number }>();
function localLimit(key: string, perMinute: number, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    if (windows.size > 10_000) windows.clear();
    windows.set(key, { start: now, n: 1 });
    return true;
  }
  w.n += 1;
  return w.n <= perMinute;
}

/** Throttle a request made with a space token. Called from the gateway's authenticate(). */
export async function throttleSpace(env: SpacesEnv, k: Pick<SpacesKit, "fail">, g: SpaceGrant): Promise<void> {
  if (!g.space) return;
  if (env.WEFT_HOSTED_OFF === "1") k.fail("unavailable", "hosted spaces are switched off on this gateway");
  const ok = env.WEFT_RATE ? (await env.WEFT_RATE.limit({ key: g.space })).success : localLimit(`space:${g.space}`, limits(env).rpm);
  if (!ok) k.fail("rate_limited", "this space is sending too many requests; slow down");
}

const enc = new TextEncoder();
async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/**
 * The key a network's signup counter is stored under: HMAC-SHA-256(ip, daily secret), where the
 * daily secret is HMAC-SHA-256(Worker secret, "weft-signup-day:" + UTC date). Without the Worker
 * secret it can't be reversed or recomputed, and a new day gives the same network an unrelated key,
 * so yesterday's counters can't be linked to today's. Nothing IP-derived is stored on the space.
 */
export async function networkKey(ip: string, secret: string, day: string): Promise<string> {
  const daily = await hmac(enc.encode(secret), `weft-signup-day:${day}`);
  const mac = await hmac(daily, ip);
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function signupSecret(env: SpacesEnv): string {
  return env.WEFT_SIGNUP_SECRET || env.WEFT_ADMIN_TOKEN || "weft-local-signup";
}

/** Routes under /v1/spaces, /v1/space and /feed; null when the path is not one of them. */
export async function spacesRoute(req: Request, env: SpacesEnv, k: SpacesKit, path: string): Promise<Response | null> {
  const m = req.method;
  if (path === "/feed" && m === "GET") {
    return new Response(FEED_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    });
  }
  if (path === "/v1/spaces" && m === "POST") {
    const L = limits(env);
    const admin = k.isAdmin(k.bearer(req));
    const day = new Date().toISOString().slice(0, 10);
    const net = await networkKey(req.headers.get("cf-connecting-ip") ?? "local", signupSecret(env), day);
    if (!admin) {
      if (env.WEFT_HOSTED_OFF === "1") k.fail("unavailable", "hosted spaces are switched off on this gateway");
      if (env.WEFT_SIGNUPS !== "open") k.fail("forbidden", "this gateway does not offer free spaces; ask its operator, or run your own with `npx @celador/weft deploy`");
      const ok = env.WEFT_SIGNUP_RATE ? (await env.WEFT_SIGNUP_RATE.limit({ key: net })).success : localLimit(`signup:${net}`, 10);
      if (!ok) k.fail("rate_limited", "too many new spaces from your network; wait a minute");
    }
    const body = ((await k.readJson(req, true)) ?? {}) as { label?: unknown };
    const r = await registry(env).createSpace({ networkKey: net, day, ...(typeof body.label === "string" ? { label: body.label } : {}), limits: L, bypassQuota: admin });
    if ("error" in r) k.fail(r.code === "closed" ? "unavailable" : "rate_limited", r.error);
    const ok = r as { space: { id: string }; token: string };
    return k.json({ type: "space", space: ok.space, token: ok.token, limits: { repos: L.maxRepos, tokens: L.maxTokens, requests_per_minute: L.rpm } }, 201);
  }
  if (path !== "/v1/space" && !path.startsWith("/v1/space/")) return null;

  const g = await k.authenticate(req);
  if (g.role !== "owner" || !g.space) k.fail("forbidden", "the space API needs the space's owner token");
  const space = g.space!;
  const reg = registry(env);
  const L = limits(env);
  if (path === "/v1/space" && m === "GET") {
    const info = await reg.spaceInfo(space);
    if (!info) k.fail("unauthorized", "space not found");
    return k.json({ type: "space", space: info, limits: { repos: L.maxRepos, tokens: L.maxTokens, requests_per_minute: L.rpm } });
  }
  if (path === "/v1/space" && m === "DELETE") {
    await reg.deleteSpace(space);
    return new Response(null, { status: 204 });
  }
  if (path === "/v1/space/repos" && m === "POST") {
    const body = (await k.readJson(req)) as { name?: unknown };
    if (typeof body?.name !== "string") k.fail("invalid_message", "name required", { issues: [{ path: "/name", message: "string" }] });
    const r = await reg.spaceCreateRepo(space, body.name as string, L.maxRepos);
    if ("error" in r) k.fail(r.code === "quota" ? "rate_limited" : r.code === "gone" ? "unauthorized" : "invalid_message", r.error, { issues: [{ path: "/name", message: r.error }] });
    const ok = r as { created: boolean };
    return k.json({ type: "space.repo", ...ok }, ok.created ? 201 : 200);
  }
  if (path === "/v1/space/tokens" && m === "POST") {
    const body = ((await k.readJson(req)) ?? {}) as { kind?: unknown; repo?: unknown; agent?: unknown; label?: unknown };
    const kind = body.kind;
    if (kind !== "agent" && kind !== "system" && kind !== "viewer") k.fail("invalid_message", "kind must be agent, system or viewer", { issues: [{ path: "/kind", message: "enum" }] });
    const r = await reg.spaceIssueToken(
      space,
      {
        kind: kind as "agent" | "system" | "viewer",
        ...(typeof body.repo === "string" ? { repo: body.repo } : {}),
        ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
      },
      L.maxTokens,
    );
    if ("error" in r) k.fail(r.code === "quota" ? "rate_limited" : r.code === "repo" ? "repo_not_found" : r.code === "gone" ? "unauthorized" : "invalid_message", r.error, { issues: [{ path: "", message: r.error }] });
    return k.json({ type: "space.token", ...(r as object) }, 201);
  }
  const tm = /^\/v1\/space\/tokens\/([^/]+)$/.exec(path);
  if (tm && m === "DELETE") {
    if (!(await reg.spaceRevoke(space, decodeURIComponent(tm[1]!)))) k.fail("not_found", "no such active token in this space");
    return new Response(null, { status: 204 });
  }
  k.fail("not_found", `no route ${m} ${path}`);
}

/** Operator routes: GET /v1/admin/spaces, POST /v1/admin/spaces/{id}/suspend, GET|POST /v1/admin/hosted. */
export async function spacesAdmin(req: Request, env: SpacesEnv, k: SpacesKit, path: string): Promise<Response | null> {
  const reg = registry(env);
  const m = req.method;
  if (path === "/v1/admin/spaces" && m === "GET") return k.json({ spaces: await reg.listSpaces() });
  const sm = /^\/v1\/admin\/spaces\/([^/]+)\/suspend$/.exec(path);
  if (sm && m === "POST") {
    if (!(await reg.deleteSpace(decodeURIComponent(sm[1]!), "suspended"))) k.fail("not_found", "no such active space");
    return k.json({ type: "space.suspended", space: sm[1] });
  }
  if (path === "/v1/admin/stats" && m === "GET") {
    const all = await reg.listSpaces();
    return k.json({ type: "stats", days: await reg.signupStats(), spaces: { total: all.length, active: all.filter((s) => s.status === "active").length } });
  }
  if (path === "/v1/admin/hosted" && m === "GET") return k.json({ type: "hosted", mode: await reg.hostedMode(), env_off: env.WEFT_HOSTED_OFF === "1", signups: env.WEFT_SIGNUPS === "open" });
  if (path === "/v1/admin/hosted" && m === "POST") {
    const body = (await k.readJson(req)) as { mode?: unknown };
    if (body?.mode !== "open" && body?.mode !== "no-signups" && body?.mode !== "off") k.fail("invalid_message", "mode must be open, no-signups or off", { issues: [{ path: "/mode", message: "enum" }] });
    return k.json({ type: "hosted", mode: await reg.setHostedMode(body.mode as "open") });
  }
  return null;
}
