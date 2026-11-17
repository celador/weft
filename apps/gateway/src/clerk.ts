// Clerk session tokens for weft.mx accounts (docs/hosted.md "Accounts"). The gateway holds NO Clerk secret: it
// verifies the short-lived session JWT a signed-in page on weft.mx sends, with the public keys (JWKS) of the Weft
// Clerk application's Frontend API. Checks: RS256 only, the key id is one of that application's keys, `iss` is
// exactly the configured issuer (a token from any other Clerk application, e.g. clerk.elier.ai, is refused), `exp`
// and `nbf` (with 5 s of clock skew), and `azp` (the page origin that asked for the token) is on the allow-list.
//
//   CLERK_ISSUER               https://clerk.weft.mx (the Weft application's Frontend API). Accounts are off without it.
//   CLERK_AUTHORIZED_PARTIES   comma-separated origins (default https://weft.mx)
//   CLERK_JWKS_URL             default `${CLERK_ISSUER}/.well-known/jwks.json`
//   CLERK_JWKS                 inline JWKS JSON (tests, or pinning the keys); used instead of fetching

export interface ClerkEnv {
  CLERK_ISSUER?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  CLERK_JWKS_URL?: string;
  CLERK_JWKS?: string;
}

export type ClerkConfig = { issuer: string; parties: string[]; jwksUrl: string; inline?: string };

export function clerkConfig(env: ClerkEnv): ClerkConfig | null {
  const issuer = env.CLERK_ISSUER?.trim().replace(/\/+$/, "");
  if (!issuer || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(issuer)) return null;
  const parties = (env.CLERK_AUTHORIZED_PARTIES ?? "https://weft.mx")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return { issuer, parties, jwksUrl: env.CLERK_JWKS_URL?.trim() || `${issuer}/.well-known/jwks.json`, ...(env.CLERK_JWKS?.trim() ? { inline: env.CLERK_JWKS.trim() } : {}) };
}

export type ClerkSession = { userId: string; sessionId?: string; azp: string; exp: number };
export class ClerkTokenError extends Error {
  constructor(readonly reason: "malformed" | "alg" | "kid" | "signature" | "issuer" | "expired" | "not_yet_valid" | "azp" | "subject" | "jwks") {
    super(`session token rejected (${reason})`);
  }
}

type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string; use?: string };
const keyCache = new Map<string, { keys: Map<string, CryptoKey>; at: number }>();
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFRESH_MS = 60_000;
const SKEW_S = 5;

const b64urlBytes = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};
const b64urlJson = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;

async function importKeys(jwks: unknown): Promise<Map<string, CryptoKey>> {
  const out = new Map<string, CryptoKey>();
  const keys = (jwks as { keys?: Jwk[] })?.keys;
  if (!Array.isArray(keys)) return out;
  for (const k of keys) {
    if (k.kty !== "RSA" || !k.kid || (k.alg && k.alg !== "RS256") || (k.use && k.use !== "sig")) continue;
    try {
      out.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    } catch {
      /* skip a key we cannot read */
    }
  }
  return out;
}

async function keysFor(cfg: ClerkConfig, kid: string, fetchImpl: typeof fetch): Promise<CryptoKey | undefined> {
  const cacheKey = cfg.inline ? `inline:${cfg.issuer}:${cfg.inline.length}` : cfg.jwksUrl;
  const hit = keyCache.get(cacheKey);
  const now = Date.now();
  if (hit && (hit.keys.has(kid) ? now - hit.at < JWKS_TTL_MS : now - hit.at < JWKS_MIN_REFRESH_MS)) return hit.keys.get(kid);
  let jwks: unknown;
  if (cfg.inline) jwks = JSON.parse(cfg.inline);
  else {
    const r = await fetchImpl(cfg.jwksUrl, { headers: { accept: "application/json" } });
    if (!r.ok) {
      if (hit) return hit.keys.get(kid);
      throw new ClerkTokenError("jwks");
    }
    jwks = await r.json();
  }
  const keys = await importKeys(jwks);
  keyCache.set(cacheKey, { keys, at: now });
  return keys.get(kid);
}

/** Verify a Clerk session token. Throws ClerkTokenError; returns the user id (`sub`), session id and azp. */
export async function verifyClerkToken(token: string, cfg: ClerkConfig, opts: { now?: number; fetchImpl?: typeof fetch } = {}): Promise<ClerkSession> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) throw new ClerkTokenError("malformed");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64urlJson(parts[0]!);
    claims = b64urlJson(parts[1]!);
  } catch {
    throw new ClerkTokenError("malformed");
  }
  if (header.alg !== "RS256") throw new ClerkTokenError("alg");
  if (typeof header.kid !== "string" || !header.kid) throw new ClerkTokenError("kid");
  // The issuer is checked before any key is fetched: a token from another Clerk application never costs a JWKS call.
  if (claims.iss !== cfg.issuer) throw new ClerkTokenError("issuer");
  const key = await keysFor(cfg, header.kid, opts.fetchImpl ?? fetch);
  if (!key) throw new ClerkTokenError("kid");
  let sig: Uint8Array;
  try {
    sig = b64urlBytes(parts[2]!);
  } catch {
    throw new ClerkTokenError("malformed");
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new ClerkTokenError("signature");
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new ClerkTokenError("expired");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) throw new ClerkTokenError("not_yet_valid");
  const azp = typeof claims.azp === "string" ? claims.azp.replace(/\/+$/, "") : "";
  if (!azp || !cfg.parties.includes(azp)) throw new ClerkTokenError("azp");
  if (typeof claims.sub !== "string" || !/^user_[A-Za-z0-9]{8,64}$/.test(claims.sub)) throw new ClerkTokenError("subject");
  return { userId: claims.sub, ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}), azp, exp: claims.exp };
}
