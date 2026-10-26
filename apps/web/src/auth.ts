// Who may use the Weft web UI.
//
// 1. Cloudflare Access (preferred, production): Access sits in front of the Worker and
//    forwards a signed JWT in `Cf-Access-Jwt-Assertion`. We verify it ourselves (RS256
//    against the team's JWKS, `aud` = the Access application's AUD tag, `iss` = the team
//    domain, `exp`/`nbf`) so a request that bypasses Access (e.g. the workers.dev URL) is
//    refused. Optional allow-list: WEFT_ALLOWED_EMAILS.
// 2. Operator key (fallback while Access is not configured): POST /login with
//    WEFT_WEB_KEY sets an HMAC-signed, HttpOnly session cookie.
// 3. Neither configured: fail closed (503), unless WEFT_WEB_DEV=1 (local `wrangler dev`).
// 0. Public read-only demo (WEFT_PUBLIC_DEMO=1, env `public` at demo.weft.mx): everyone is
//    the "guest" identity, no login. index.ts then allows GET routes + the WS stream only and
//    calls the gateway with the observe-only WEFT_PUBLIC_TOKEN (never WEFT_WEB_TOKEN).

export interface AuthEnv {
  ACCESS_TEAM_DOMAIN?: string; // e.g. "elier.cloudflareaccess.com"
  ACCESS_AUD?: string; // Access application AUD tag
  WEFT_ALLOWED_EMAILS?: string; // comma-separated; empty = anyone Access lets through
  WEFT_WEB_KEY?: string; // operator key for the fallback login (secret)
  WEFT_WEB_DEV?: string; // "1" = no auth (local dev only)
  WEFT_PUBLIC_DEMO?: string; // "1" = public read-only demo: guest identity, GET only
}

export function publicDemo(env: AuthEnv): boolean {
  return env.WEFT_PUBLIC_DEMO === "1";
}

export type Identity = { email: string; via: "access" | "key" | "dev" | "public" };
export type AuthResult = { ok: true; identity: Identity } | { ok: false; status: 401 | 403 | 503; reason: string };

export const SESSION_COOKIE = "weft_session";
const SESSION_TTL_S = 12 * 3600;
const enc = new TextEncoder();

// ------------------------------------------------------------------ base64url helpers

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// ------------------------------------------------------------------ Cloudflare Access

type Jwk = JsonWebKey & { kid?: string };
export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const jwksCache = new Map<string, { keys: Jwk[]; exp: number }>();
const defaultFetcher: JwksFetcher = async (url) => {
  const r = await fetch(url, { cf: { cacheTtl: 300 } } as RequestInit);
  if (!r.ok) throw new Error(`JWKS ${r.status}`);
  return (await r.json()) as { keys: Jwk[] };
};

async function jwks(team: string, fetcher: JwksFetcher, force = false): Promise<Jwk[]> {
  const url = `https://${team}/cdn-cgi/access/certs`;
  const hit = jwksCache.get(url);
  if (!force && hit && hit.exp > Date.now()) return hit.keys;
  const { keys } = await fetcher(url);
  jwksCache.set(url, { keys, exp: Date.now() + 10 * 60_000 });
  return keys;
}

export function clearJwksCache(): void {
  jwksCache.clear();
}

/** Verify a Cloudflare Access JWT. Returns the email claim, or throws with a reason. */
export async function verifyAccessJwt(token: string, env: AuthEnv, fetcher: JwksFetcher = defaultFetcher, now = Date.now()): Promise<string> {
  const team = env.ACCESS_TEAM_DOMAIN!.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(unb64url(h))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`unsupported alg ${header.alg}`);
  let keys = await jwks(team, fetcher);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await jwks(team, fetcher, true); // key rotation
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(s), enc.encode(`${h}.${p}`));
  if (!ok) throw new Error("bad signature");
  const claims = JSON.parse(new TextDecoder().decode(unb64url(p))) as { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; common_name?: string };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error("wrong audience");
  if (claims.iss !== `https://${team}`) throw new Error("wrong issuer");
  const t = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp < t - 30) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > t + 30) throw new Error("not yet valid");
  const who = claims.email ?? claims.common_name; // common_name = service token
  if (!who) throw new Error("no identity claim");
  return who;
}

// ------------------------------------------------------------------ operator key session

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export async function mintSession(env: AuthEnv, now = Date.now()): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ sub: "operator", exp: Math.floor(now / 1000) + SESSION_TTL_S })));
  return `${body}.${await hmac(env.WEFT_WEB_KEY!, `session:${body}`)}`;
}

export async function readSession(cookie: string, env: AuthEnv, now = Date.now()): Promise<boolean> {
  const [body, sig] = cookie.split(".");
  if (!body || !sig || !env.WEFT_WEB_KEY) return false;
  if (!timingSafeEqual(sig, await hmac(env.WEFT_WEB_KEY, `session:${body}`))) return false;
  try {
    const c = JSON.parse(new TextDecoder().decode(unb64url(body))) as { exp?: number };
    return typeof c.exp === "number" && c.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

export function sessionCookie(value: string, maxAge = SESSION_TTL_S): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function accessConfigured(env: AuthEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

/** Decide who is calling. Access wins when configured; then the operator-key session. */
export async function authenticate(req: Request, env: AuthEnv, fetcher?: JwksFetcher): Promise<AuthResult> {
  if (publicDemo(env)) return { ok: true, identity: { email: "guest", via: "public" } };
  if (accessConfigured(env)) {
    const jwt = req.headers.get("cf-access-jwt-assertion") ?? cookieValue(req, "CF_Authorization");
    if (jwt) {
      try {
        const email = await verifyAccessJwt(jwt, env, fetcher);
        const allowed = (env.WEFT_ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (allowed.length && !allowed.includes(email.toLowerCase())) return { ok: false, status: 403, reason: `${email} is not allowed` };
        return { ok: true, identity: { email, via: "access" } };
      } catch (e) {
        return { ok: false, status: 401, reason: `Access token rejected: ${(e as Error).message}` };
      }
    }
    if (!env.WEFT_WEB_KEY) return { ok: false, status: 401, reason: "Cloudflare Access login required" };
  }
  if (env.WEFT_WEB_KEY) {
    const c = cookieValue(req, SESSION_COOKIE);
    if (c && (await readSession(c, env))) return { ok: true, identity: { email: "operator", via: "key" } };
    return { ok: false, status: 401, reason: "login required" };
  }
  if (env.WEFT_WEB_DEV === "1") return { ok: true, identity: { email: "dev", via: "dev" } };
  return { ok: false, status: 503, reason: "web UI auth is not configured (set ACCESS_TEAM_DOMAIN+ACCESS_AUD or WEFT_WEB_KEY)" };
}
