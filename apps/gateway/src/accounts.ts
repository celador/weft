// Accounts on the hosted gateway (docs/hosted.md "Accounts"): a Weft account is a user of the Weft Clerk application,
// signed in on weft.mx. The gateway has no Clerk secret and stores no email or name: it verifies the Clerk session
// token the page sends (clerk.ts) and keys everything by the token's `sub` (the Clerk user id).
//
//   GET    /v1/account                       Clerk session: plan, seats, renewal, spaces (created on first call)
//   POST   /v1/account/billing/checkout      Clerk session {interval, seats, utm_source?, utm_campaign?}: Stripe Checkout URL
//   POST   /v1/account/billing/portal        Clerk session: Stripe Customer Portal URL
//   DELETE /v1/account                       Clerk session: cancel the subscription, erase every space, delete the account
//   POST   /v1/login                         no auth: `weft login` starts (device code + the code the person confirms)
//   POST   /v1/login/approve {code}          Clerk session (weft.mx/cli/): confirm the code shown in the terminal
//   POST   /v1/login/poll {device_code}      the CLI polls; with its current owner key (Bearer) the space is attached
//   GET    /v1/admin/accounts                operator: accounts with plan, seats, spaces, events in 7 days
//
// Browser calls come from the site's origins only (CORS allow-list, no cookies: the token is a Bearer header).

import { clerkConfig, ClerkTokenError, verifyClerkToken, type ClerkEnv } from "./clerk";
import { accountCheckout, accountUrl, clean, corsHeaders, portalUrl, proChoice, requireBilling, withHeaders, type BillingEnv, type BillingKit } from "./billing";
import type { SpaceGrant, Utm } from "./registry";
import { limits, networkKey, type SpacesEnv } from "./spaces";
import { StripeError, stripeConfig } from "./stripe";

export interface AccountsEnv extends BillingEnv, ClerkEnv, SpacesEnv {
  /** Where `weft login` sends the person to confirm the code (default https://weft.mx). */
  WEFT_SITE_URL?: string;
}

export type AccountsKit = BillingKit & {
  bearer: (req: Request) => string | undefined;
  /** The owner grant behind a bearer, or undefined (the poll's optional attach). */
  ownerGrant: (req: Request) => Promise<SpaceGrant | undefined>;
  dropGrants: () => void;
};

function registry(env: AccountsEnv) {
  return env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
}

const siteUrl = (env: AccountsEnv) => (env.WEFT_SITE_URL?.trim() || "https://weft.mx").replace(/\/+$/, "");

/** The Clerk user id behind the request's session token, or a 401 (503 when this gateway has no accounts). */
export async function requireAccount(req: Request, env: AccountsEnv, k: Pick<AccountsKit, "fail" | "bearer">): Promise<string> {
  const cfg = clerkConfig(env);
  if (!cfg) k.fail("unavailable", "accounts are not enabled on this gateway");
  const token = k.bearer(req);
  if (!token) k.fail("unauthorized", "sign in on weft.mx first (missing session token)");
  try {
    return (await verifyClerkToken(token!, cfg!)).userId;
  } catch (e) {
    if (e instanceof ClerkTokenError) {
      if (e.reason === "jwks") k.fail("unavailable", "could not read the sign-in keys; try again in a minute");
      k.fail("unauthorized", `sign in again (${e.reason})`, { reason: e.reason });
    }
    throw e;
  }
}

const utmFrom = (o: { utm_source?: unknown; utm_campaign?: unknown }): Utm => ({
  ...(typeof o.utm_source === "string" && clean(o.utm_source) ? { source: clean(o.utm_source) } : {}),
  ...(typeof o.utm_campaign === "string" && clean(o.utm_campaign) ? { campaign: clean(o.utm_campaign) } : {}),
});

async function route(req: Request, env: AccountsEnv, k: AccountsKit, path: string): Promise<Response | null> {
  const m = req.method;
  const reg = registry(env);

  // ----- `weft login` (device login)
  if (path === "/v1/login" && m === "POST") {
    if (!clerkConfig(env)) k.fail("unavailable", "accounts are not enabled on this gateway");
    if (env.WEFT_HOSTED_OFF === "1") k.fail("unavailable", "hosted spaces are switched off on this gateway");
    await k.throttle(req, "login");
    const r = await reg.loginStart();
    const url = `${siteUrl(env)}/cli/?code=${encodeURIComponent(r.user_code)}`;
    return k.json({ type: "login", device_code: r.device_code, user_code: r.user_code, verification_url: url, expires_at: r.expires_at, expires_in: r.expires_in, interval: 3 }, 201);
  }
  if (path === "/v1/login/poll" && m === "POST") {
    if (!clerkConfig(env)) k.fail("unavailable", "accounts are not enabled on this gateway");
    const body = ((await k.readJson(req, true)) ?? {}) as { device_code?: unknown; label?: unknown };
    if (typeof body.device_code !== "string" || !/^weft_login_[A-Za-z0-9_-]{20,80}$/.test(body.device_code)) k.fail("invalid_message", "device_code is required", { issues: [{ path: "/device_code", message: "string" }] });
    // Optional: the owner key of the anonymous space this repo already has, so it joins the account instead of a new one.
    const g = await k.ownerGrant(req);
    const day = new Date().toISOString().slice(0, 10);
    const net = await networkKey(req.headers.get("cf-connecting-ip") ?? "local", env.WEFT_SIGNUP_SECRET || env.WEFT_ADMIN_TOKEN || "weft-local-signup", day);
    const r = await reg.loginPoll(body.device_code as string, { ...(g?.space ? { attach: g.space } : {}), networkKey: net, limits: limits(env), ...(typeof body.label === "string" ? { label: body.label.slice(0, 80) } : {}) });
    if ("error" in r) k.fail(r.code === "other_account" ? "forbidden" : r.code === "quota" ? "rate_limited" : "unavailable", r.error, { reason: r.code });
    if (r.status === "pending") return k.json({ type: "login.pending" }, 202);
    if (r.status === "expired") k.fail("unauthorized", "this login expired or was already used; run `npx @celador/weft login` again", { reason: "expired" });
    const ok = r as { account: string; space: string; attached: boolean; token?: string; created: boolean };
    return k.json({ type: "login.approved", space: ok.space, attached: ok.attached, created: ok.created, ...(ok.token ? { token: ok.token } : {}) });
  }
  if (path === "/v1/login/approve" && m === "POST") {
    const account = await requireAccount(req, env, k);
    await k.throttle(req, "login-approve", [`account:${account}`]);
    const body = ((await k.readJson(req, true)) ?? {}) as { code?: unknown };
    if (typeof body.code !== "string" || !body.code || body.code.length > 32) k.fail("invalid_message", "code is required", { issues: [{ path: "/code", message: "string" }] });
    const r = await reg.loginApprove(body.code as string, account);
    if ("error" in r) k.fail("unauthorized", r.error, { reason: "invalid" });
    return k.json({ type: "login.approved" });
  }

  // ----- the signed-in account page
  if (path === "/v1/account" && m === "GET") {
    const account = await requireAccount(req, env, k);
    const q = new URL(req.url).searchParams;
    await reg.ensureAccount(account, utmFrom({ utm_source: q.get("utm_source") ?? undefined, utm_campaign: q.get("utm_campaign") ?? undefined }));
    const info = await reg.accountInfo(account);
    return k.json({ type: "account", account: info, billing: { enabled: stripeConfig(env) !== null } });
  }
  if (path === "/v1/account" && m === "DELETE") {
    const account = await requireAccount(req, env, k);
    const r = await reg.deleteAccount(account);
    if ("error" in r) k.fail("unavailable", r.error, { reason: r.code });
    k.dropGrants();
    return k.json({ type: "account.deleted", ...(r as object) });
  }
  const bm = /^\/v1\/account\/billing\/(checkout|portal)$/.exec(path);
  if (bm && m === "POST") {
    const account = await requireAccount(req, env, k);
    const cfg = requireBilling(env, k);
    const body = ((await k.readJson(req, true)) ?? {}) as { interval?: unknown; seats?: unknown; utm_source?: unknown; utm_campaign?: unknown };
    await reg.ensureAccount(account, utmFrom(body));
    const a = await reg.accountCustomer(account);
    const back = accountUrl(env);
    try {
      if (bm[1] === "checkout") {
        const choice = proChoice({ interval: body.interval, seats: body.seats }, k);
        if (a.plan === "paid") k.fail("invalid_message", "this account already has Weft Pro; change seats or cancel with Manage billing", { issues: [{ path: "", message: "already paid" }] });
        const url = await accountCheckout(cfg, account, a.customer, choice, { success: `${back}?checkout=done`, cancel: `${back}?checkout=cancelled` }, utmFrom(body));
        return k.json({ type: "billing.checkout", url, interval: choice.interval, seats: choice.seats }, 201);
      }
      if (!a.customer) k.fail("invalid_message", "this account has no billing yet; get Weft Pro first", { issues: [{ path: "", message: "no billing account" }] });
      return k.json({ type: "billing.portal", url: await portalUrl(cfg, a.customer!, back) }, 201);
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      console.error("accounts: stripe", bm[1], e.status, e.code ?? "", e.message);
      return k.fail("unavailable", `Stripe could not start ${bm[1] === "checkout" ? "checkout" : "the billing portal"}; try again in a minute`);
    }
  }
  return null;
}

const BROWSER_PATHS = /^\/v1\/(account(\/billing\/(checkout|portal))?|login\/approve)$/;

/** Account and login routes (null for any other path). The browser-facing ones answer CORS for the site's origins. */
export async function accountsRoute(req: Request, env: AccountsEnv, k: AccountsKit, path: string): Promise<Response | null> {
  if (!path.startsWith("/v1/account") && !path.startsWith("/v1/login")) return null;
  const browser = BROWSER_PATHS.test(path);
  const cors = browser ? corsHeaders(env, req) : {};
  if (req.method === "OPTIONS" && browser) return new Response(null, { status: 204, headers: { ...cors, "cache-control": "no-store" } });
  try {
    const r = await route(req, env, k, path);
    return r ? withHeaders(r, cors) : null;
  } catch (e) {
    return withHeaders(k.respond(e), cors);
  }
}

/** Operator: `GET /v1/admin/accounts`. */
export async function accountsAdmin(req: Request, env: AccountsEnv, k: Pick<BillingKit, "json">, path: string): Promise<Response | null> {
  if (path === "/v1/admin/accounts" && req.method === "GET") return k.json({ type: "accounts", accounts: await registry(env).listAccounts() });
  return null;
}

