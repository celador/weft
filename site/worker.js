// weft-site Worker. Static assets serve everything except POST /e, the funnel-event
// endpoint (run_worker_first in wrangler.toml). Events go to Workers Analytics Engine.
// Stored per event: name, page placement, traffic source, command variant, utm campaign.
// No IP, no user agent, no cookies, no identifiers. Query: site/funnel.mjs, docs/launch/README.md.
//
// The same code runs as `weft-site-preview` (wrangler.toml [env.preview]): there CANONICAL_HOST is
// the preview host, PREVIEW = "1" adds a banner and noindex, and events go to a separate dataset.
//
// Accounts (Clerk, the "Weft" application): GET /weft-config.js hands the pages the PUBLIC Clerk settings and the
// gateway URL. POST /api/account/delete is the one route that uses the Clerk SECRET key (a Worker secret, never in
// a page): it verifies the caller's session token, has the gateway delete the account's data first (subscription
// cancelled, spaces erased), then deletes that same Clerk user, and only ever the caller's own.
export const EVENTS = new Set(["view", "copy", "pricing_view", "buy_click", "signup_view", "account_view", "checkout_start"]);
const clip = (v, n) => String(v ?? "").replace(/[^\w.\-]/g, "").slice(0, n);

/** The Analytics Engine data point for one POST /e body, or null for an unknown event. */
export function eventPoint(body) {
  const event = clip(body?.e, 16);
  if (!EVENTS.has(event)) return null;
  return {
    indexes: [event],
    // blob1 event, blob2 placement, blob3 source, blob4 command variant, blob5 utm_campaign
    blobs: [event, clip(body.w, 32), clip(body.s, 64).toLowerCase(), clip(body.c, 16), clip(body.k, 64).toLowerCase()],
    doubles: [1],
  };
}

const BANNER = '<div class="preview-banner">Preview of weft.mx. Not live: accounts here are a test instance and payments are in Stripe test mode.</div>';

// ---------------------------------------------------------------- Clerk session tokens (same checks as the gateway)
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const keyCache = new Map();

/** The Clerk user id (`sub`) of a valid session token from this Clerk application, made on `origin`; else throws. */
export async function verifySession(token, { issuer, origin, jwks, now = Date.now(), fetchFn = fetch }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed");
  let h, c;
  try { h = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); c = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); } catch { throw new Error("malformed"); }
  if (h.alg !== "RS256" || typeof h.kid !== "string") throw new Error("alg");
  if (c.iss !== issuer) throw new Error("issuer");
  // Pinned keys (tests) are used as given; fetched ones are cached per issuer and refetched for an unknown kid.
  let keys = jwks ? null : keyCache.get(issuer);
  if (!keys || !keys.has(h.kid)) {
    const set = jwks ?? (await (await fetchFn(`${issuer}/.well-known/jwks.json`)).json());
    keys = new Map();
    for (const k of set.keys ?? []) if (k.kty === "RSA" && k.kid) keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    if (!jwks) keyCache.set(issuer, keys);
  }
  const key = keys.get(h.kid);
  if (!key) throw new Error("kid");
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) throw new Error("signature");
  const t = Math.floor(now / 1000);
  if (typeof c.exp !== "number" || c.exp + 5 < t) throw new Error("expired");
  if (typeof c.nbf === "number" && c.nbf - 5 > t) throw new Error("not_yet_valid");
  if (String(c.azp || "").replace(/\/+$/, "") !== origin) throw new Error("azp");
  if (typeof c.sub !== "string" || !/^user_[A-Za-z0-9]{8,64}$/.test(c.sub)) throw new Error("subject");
  return c.sub;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const issuerOf = (env) => (env.CLERK_FRONTEND_API ? `https://${env.CLERK_FRONTEND_API}` : "");
const gatewayOf = (env) => (env.WEFT_GATEWAY_URL || "https://weft-hosted.elier.ai").replace(/\/+$/, "");

/** POST /api/account/delete: the gateway erases the account's data, then the caller's own Clerk user is deleted. */
export async function deleteAccount(request, env, { fetchFn = fetch, origin, jwks } = {}) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  // A form on another site cannot set this header, and the token is never a cookie: no CSRF.
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (!m || !env.CLERK_SECRET_KEY || !issuerOf(env)) return json({ error: "sign in first" }, m ? 503 : 401);
  let user;
  try { user = await verifySession(m[1].trim(), { issuer: issuerOf(env), origin, ...(jwks ? { jwks } : {}), fetchFn }); }
  catch (e) { return json({ error: `sign in again (${e.message})` }, 401); }
  // 1. Weft's data: cancel the subscription, erase every space, delete the account row. Stop here on any failure.
  const g = await fetchFn(`${gatewayOf(env)}/v1/account`, { method: "DELETE", headers: { authorization: `Bearer ${m[1].trim()}` } });
  const report = await g.json().catch(() => ({}));
  if (!g.ok) return json({ error: report?.error?.message || `the gateway could not delete your data (HTTP ${g.status}); nothing else was deleted` }, 502);
  // 2. The sign-in record at Clerk (email, sign-in data): only the user the token belongs to.
  const c = await fetchFn(`https://api.clerk.com/v1/users/${encodeURIComponent(user)}`, { method: "DELETE", headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
  if (!c.ok && c.status !== 404) return json({ error: `your Weft data is deleted, but the sign-in record could not be removed (HTTP ${c.status}); write to john@elier.ai`, data_deleted: true }, 502);
  return json({ deleted: true, spaces_erased: Array.isArray(report.spaces) ? report.spaces.length : 0, subscriptions_cancelled: report.subscriptions_cancelled ?? 0 });
}

/** GET /weft-config.js: the public settings the pages need (no secret). */
function configScript(env, origin) {
  const cfg = { clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || "", clerkFrontendApi: env.CLERK_FRONTEND_API || "", gateway: gatewayOf(env), origin };
  return new Response(`window.WEFT_CONFIG = ${JSON.stringify(cfg)};\n`, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const canonical = env.CANONICAL_HOST || "weft.mx";
    // weft.mx is the canonical host; www and the old weft-site.elier.ai 301 there.
    // LOCAL_DEV=1 (only in a gitignored .dev.vars for `wrangler dev`, which rewrites the host to the first route).
    if (url.hostname !== canonical && url.pathname !== "/e" && env.LOCAL_DEV !== "1") {
      url.hostname = canonical; url.protocol = "https:"; url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    const origin = env.SITE_ORIGIN || `https://${canonical}`;
    if (url.pathname === "/weft-config.js") return configScript(env, origin);
    if (url.pathname === "/api/account/delete") return deleteAccount(request, env, { origin });
    if (url.pathname === "/e") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      let body = {};
      try { body = JSON.parse((await request.text()).slice(0, 1024)); } catch {}
      const point = eventPoint(body);
      if (point && env.EVENTS) env.EVENTS.writeDataPoint(point);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    let res = await env.ASSETS.fetch(request);
    // Signed-in pages: never cached, never indexed, no referrer (the /cli/ address carries a login code).
    const priv = /^\/(account|cli|sign-in|sign-up)(\/|$)/.test(url.pathname);
    if (!priv && env.PREVIEW !== "1") return res;
    res = new Response(res.body, res);
    if (priv) {
      res.headers.set("cache-control", "no-store");
      res.headers.set("referrer-policy", "no-referrer");
    }
    if (priv || env.PREVIEW === "1") res.headers.set("x-robots-tag", "noindex, nofollow");
    if (env.PREVIEW === "1" && (res.headers.get("content-type") || "").includes("text/html")) {
      res = new HTMLRewriter().on("body", { element(el) { el.prepend(BANNER, { html: true }); } }).transform(res);
    }
    return res;
  },
};
