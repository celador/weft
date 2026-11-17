// Accounts (Clerk users on weft.mx) inside the Workers runtime: session-token verification (no Clerk secret on the
// gateway), the account page's API, `weft login` (device login, attach), Weft Pro bought by an account, logout, and
// deleting an account. Stripe is mocked with fetchMock (vitest.accounts.config.ts).

import { SELF, env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Registry } from "../../src/registry";
import { signStripePayload } from "../../src/stripe";
import { ADMIN, BASE, call } from "../helpers";
import { OTHER_JWK, WEFT_JWK } from "./keys";

const ISSUER = "https://clerk.weft.test";
const SITE = "https://site.test";
const SECRET = "whsec_unit_secret";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());

// ------------------------------------------------------------------ helpers

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type Claims = Record<string, unknown>;
async function jwt(claims: Claims, opts: { key?: JsonWebKey & { kid?: string }; kid?: string; alg?: string } = {}): Promise<string> {
  const key = opts.key ?? WEFT_JWK;
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? key.kid, typ: "JWT" };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const k = await crypto.subtle.importKey("jwk", { ...key, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

let n = 0;
const newUser = () => `user_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}${(n++).toString(36)}`;
const now = () => Math.floor(Date.now() / 1000);
const session = (sub: string, extra: Claims = {}) => jwt({ iss: ISSUER, sub, sid: `sess_${sub.slice(5, 15)}`, azp: SITE, iat: now(), nbf: now() - 1, exp: now() + 60, ...extra });

let ipN = 0;
const ip = () => `198.51.100.${(ipN++ % 250) + 1}-${crypto.randomUUID().slice(0, 6)}`;
const site = (method: string, p: string, token?: string, body?: unknown) => call(method, p, token, body, { origin: SITE, "cf-connecting-ip": ip() });
const errOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;

type Account = { id: string; plan: string; product: string | null; seats: number | null; interval: string | null; period_end: string | null; has_billing_account: boolean; spaces: Array<{ id: string; repos: number; last_event_at: string | null }> };
async function account(token: string, q = ""): Promise<Account> {
  const r = await site("GET", `/v1/account${q}`, token);
  expect(r.status).toBe(200);
  return ((await r.json()) as { account: Account }).account;
}

/** `weft login` end to end: start, confirm on the site with `user`'s session, poll. */
async function login(user: string, owner?: string) {
  const s = (await (await call("POST", "/v1/login", undefined, {}, { "cf-connecting-ip": ip() })).json()) as { device_code: string; user_code: string; verification_url: string };
  const ok = await site("POST", "/v1/login/approve", await session(user), { code: s.user_code });
  expect(ok.status).toBe(200);
  const r = await call("POST", "/v1/login/poll", owner, { device_code: s.device_code, label: "test laptop" }, { "cf-connecting-ip": ip() });
  return { r, start: s };
}
async function loginOk(user: string, owner?: string) {
  const { r } = await login(user, owner);
  expect(r.status).toBe(200);
  return (await r.json()) as { space: string; attached: boolean; created: boolean; token?: string };
}

const registry = () => env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
const stripe = () => fetchMock.get("https://api.stripe.com");
const form = (b: string) => Object.fromEntries(new URLSearchParams(b));
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
let evN = 0;
const evt = (type: string, object: Record<string, unknown>, created = now()) => ({ id: `evt_acc_${Date.now().toString(36)}${(evN++).toString(36)}`, type, created, data: { object } });
async function webhook(event: unknown) {
  const raw = JSON.stringify(event);
  return SELF.fetch(`${BASE}/v1/billing/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": await signStripePayload(raw, SECRET) }, body: raw });
}
const proSub = (id: string, customer: string, seats: number, interval: "month" | "year" = "month", status = "active", periodEnd = now() + 30 * 86400) => ({
  id,
  object: "subscription",
  status,
  customer,
  items: { data: [{ quantity: seats, current_period_end: periodEnd, price: { id: interval === "year" ? "price_pro_year" : "price_pro_month", recurring: { interval, usage_type: "licensed" } } }] },
});
const accountCheckoutDone = (user: string, customer: string, subscription: string) =>
  evt("checkout.session.completed", { id: `cs_test_${uid()}`, mode: "subscription", client_reference_id: user, metadata: { weft_account: user, weft_plan: "pro" }, customer, subscription, payment_status: "paid", amount_total: 2400 });

// ------------------------------------------------------------------ session tokens

describe("Clerk session tokens are verified without a Clerk secret", () => {
  it("a valid token from the Weft application on the site's origin gets the account (created on first call, with its utm)", async () => {
    const user = newUser();
    const a = await account(await session(user), "?utm_source=youtube&utm_campaign=vid1");
    expect(a).toMatchObject({ id: user, plan: "free", seats: null, spaces: [] });
    const rows = await runInDurableObject(registry(), (i: Registry) => [...(i as any).sql.exec("SELECT * FROM accounts WHERE id = ?", user)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: user, plan: "free", utm_source: "youtube", utm_campaign: "vid1" });
    // only ids, plan facts and the marketing link: no email or name column exists
    expect(Object.keys(rows[0]).sort()).toEqual(["billing_event_at", "created_at", "id", "interval", "paid_at", "period_end", "plan", "product", "seats", "stripe_customer_id", "utm_campaign", "utm_source"]);
  });

  it("refuses expired, not-yet-valid, wrong-azp, tampered, unsigned and unknown-key tokens with the reason", async () => {
    const user = newUser();
    const cases: Array<[string, Promise<string>]> = [
      ["expired", session(user, { exp: now() - 60 })],
      ["not_yet_valid", session(user, { nbf: now() + 600 })],
      ["azp", session(user, { azp: "https://evil.test" })],
      ["azp", session(user, { azp: undefined })],
      ["alg", jwt({ iss: ISSUER, sub: user, azp: SITE, exp: now() + 60 }, { alg: "HS256" })],
      ["kid", jwt({ iss: ISSUER, sub: user, azp: SITE, exp: now() + 60 }, { kid: "ins_unknown" })],
      ["subject", session("not-a-user-id")],
    ];
    for (const [reason, tok] of cases) {
      const r = await site("GET", "/v1/account", await tok);
      expect(r.status, reason).toBe(401);
      expect((await errOf(r)).details?.reason, reason).toBe(reason);
    }
    // tampered: a valid token with another subject spliced into its payload
    const good = await session(user);
    const [h, , s] = good.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ iss: ISSUER, sub: newUser(), azp: SITE, exp: now() + 60 }))}.${s}`;
    const t = await site("GET", "/v1/account", forged);
    expect(t.status).toBe(401);
    expect((await errOf(t)).details?.reason).toBe("signature");
    expect((await site("GET", "/v1/account")).status).toBe(401);
    expect((await site("GET", "/v1/account", "not.a.jwt")).status).toBe(401);
  });

  it("a token from another Clerk application (the elier.ai one) is refused, whichever key signed it", async () => {
    const user = newUser();
    for (const tok of [
      await jwt({ iss: "https://clerk.elier.ai", sub: user, azp: SITE, exp: now() + 60 }, { key: OTHER_JWK }),
      await jwt({ iss: "https://clerk.elier.ai", sub: user, azp: SITE, exp: now() + 60 }),
      await jwt({ iss: ISSUER, sub: user, azp: SITE, exp: now() + 60 }, { key: OTHER_JWK, kid: WEFT_JWK.kid }),
    ]) {
      const r = await site("GET", "/v1/account", tok);
      expect(r.status).toBe(401);
      expect(["issuer", "signature"]).toContain((await errOf(r)).details?.reason);
    }
  });

  it("answers CORS for the site's origins only, with the Authorization header allowed and no credentials", async () => {
    const pre = await SELF.fetch(`${BASE}/v1/account`, { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    const evil = await call("GET", "/v1/account", await session(newUser()), undefined, { origin: "https://evil.test" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ------------------------------------------------------------------ weft login

describe("`weft login`: device code confirmed on the site", () => {
  it("new hosted spaces need a login; the login creates a space on the account and later logins on other machines get the same space", async () => {
    const anon = await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": ip() });
    expect(anon.status).toBe(403);
    expect((await errOf(anon)).details).toMatchObject({ reason: "login_required" });

    const user = newUser();
    const start = (await (await call("POST", "/v1/login", undefined, {}, { "cf-connecting-ip": ip() })).json()) as { device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number };
    expect(start.user_code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(start.verification_url).toBe(`${SITE}/cli/?code=${start.user_code}`);
    expect(start.expires_in).toBe(600);
    // pending until confirmed
    expect((await call("POST", "/v1/login/poll", undefined, { device_code: start.device_code })).status).toBe(202);
    // stored as salted hashes only
    const stored = await runInDurableObject(registry(), (i: Registry) => [...(i as any).sql.exec("SELECT device_hash, user_hash FROM device_logins")].map((r: any) => `${r.device_hash}${r.user_hash}`).join(","));
    expect(stored).not.toContain(start.device_code);
    expect(stored).not.toContain(start.user_code.replace("-", ""));
    // confirmed on the site (case and separators do not matter)
    const ok = await site("POST", "/v1/login/approve", await session(user), { code: start.user_code.toLowerCase().replace("-", " ") });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(SITE);
    const r = await call("POST", "/v1/login/poll", undefined, { device_code: start.device_code });
    expect(r.status).toBe(200);
    const got = (await r.json()) as { space: string; token: string; created: boolean; attached: boolean };
    expect(got).toMatchObject({ created: true, attached: false });
    const sp = (await (await call("GET", "/v1/space", got.token)).json()) as { space: { id: string }; account: string | null; accounts: boolean };
    expect(sp).toMatchObject({ space: { id: got.space }, account: user, accounts: true });
    // single use
    expect((await call("POST", "/v1/login/poll", undefined, { device_code: start.device_code })).status).toBe(401);
    // a second machine: a new owner key for the same space
    const second = await loginOk(user);
    expect(second).toMatchObject({ space: got.space, created: false, attached: false });
    expect(second.token).not.toBe(got.token);
    expect((await account(await session(user))).spaces.map((s) => s.id)).toEqual([got.space]);
  });

  it("an existing anonymous space is attached (its key keeps working); a space of another account is not", async () => {
    const created = (await (await call("POST", "/v1/spaces", ADMIN, {})).json()) as { space: { id: string }; token: string };
    const user = newUser();
    const got = await loginOk(user, created.token);
    expect(got).toMatchObject({ space: created.space.id, attached: true, created: false });
    expect(got.token).toBeUndefined();
    expect(((await (await call("GET", "/v1/space", created.token)).json()) as { account: string }).account).toBe(user);
    const { r } = await login(newUser(), created.token);
    expect(r.status).toBe(403);
    expect((await errOf(r)).details).toMatchObject({ reason: "other_account" });
  });

  it("wrong codes get the same 401; confirming needs a session; starting and confirming are rate limited", async () => {
    const user = newUser();
    const bad = await site("POST", "/v1/login/approve", await session(user), { code: "AAAA-BBBB" });
    expect(bad.status).toBe(401);
    expect((await errOf(bad)).message).toContain("not valid or has expired");
    expect((await site("POST", "/v1/login/approve", undefined, { code: "AAAA-BBBB" })).status).toBe(401);
    const tok = await session(user);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await site("POST", "/v1/login/approve", tok, { code: "ZZZZ-ZZZZ" })).status);
    expect(codes).toContain(429); // per account, even from fresh networks
    const net = ip();
    const starts: number[] = [];
    for (let i = 0; i < 11; i++) starts.push((await call("POST", "/v1/login", undefined, {}, { "cf-connecting-ip": net })).status);
    expect(starts[10]).toBe(429);
    expect((await call("POST", "/v1/login/poll", undefined, { device_code: "weft_login_" + "x".repeat(43) })).status).toBe(401);
  });

  it("logout revokes this machine's key on an account space; an anonymous space refuses (its key is the only way in)", async () => {
    const user = newUser();
    const a = await loginOk(user);
    const b = await loginOk(user);
    expect((await call("POST", "/v1/space/logout", a.token!)).status).toBe(204);
    expect((await call("GET", "/v1/space", a.token!)).status).toBe(401);
    expect((await call("GET", "/v1/space", b.token!)).status).toBe(200);
    const anon = (await (await call("POST", "/v1/spaces", ADMIN, {})).json()) as { token: string };
    const r = await call("POST", "/v1/space/logout", anon.token);
    expect(r.status).toBe(403);
    expect((await errOf(r)).details).toMatchObject({ reason: "anonymous" });
  });
});

// ------------------------------------------------------------------ Pro by account

describe("Weft Pro is bought by an account; every space of the account is Pro", () => {
  it("checkout from the account page -> webhook -> the account and its spaces are Pro with seats and a renewal date; portal", async () => {
    const user = newUser();
    const sp = await loginOk(user);
    let body = "";
    stripe()
      .intercept({ path: "/v1/checkout/sessions", method: "POST" })
      .reply(200, (o) => ((body = String(o.body)), { id: "cs_test_acc1", url: "https://checkout.stripe.com/c/pay/cs_test_acc1" }));
    const r = await site("POST", "/v1/account/billing/checkout", await session(user), { interval: "month", seats: 2, utm_campaign: "vid1" });
    expect(r.status).toBe(201);
    expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(await r.json()).toMatchObject({ url: "https://checkout.stripe.com/c/pay/cs_test_acc1", seats: 2, interval: "month" });
    expect(form(body)).toMatchObject({
      mode: "subscription",
      client_reference_id: user,
      "metadata[weft_account]": user,
      "metadata[utm_campaign]": "vid1",
      "subscription_data[metadata][weft_account]": user,
      "line_items[0][price]": "price_pro_month",
      "line_items[0][quantity]": "2",
      success_url: `${SITE}/account/?checkout=done`,
      cancel_url: `${SITE}/account/?checkout=cancelled`,
    });

    const customer = `cus_${uid()}`;
    const end = now() + 30 * 86400;
    const sub = proSub(`sub_${uid()}`, customer, 2, "month", "active", end);
    stripe().intercept({ path: `/v1/subscriptions/${sub.id}`, method: "GET" }).reply(200, sub);
    const w = await webhook(accountCheckoutDone(user, customer, sub.id));
    expect(((await w.json()) as { result: string }).result).toBe("applied");
    const a = await account(await session(user));
    expect(a).toMatchObject({ plan: "paid", product: "pro", seats: 2, interval: "month", has_billing_account: true, period_end: new Date(end * 1000).toISOString() });
    const usage = ((await (await call("GET", "/v1/space", sp.token!)).json()) as { usage: { plan: string; seats: number } }).usage;
    expect(usage).toMatchObject({ plan: "paid", seats: 2 });
    // a space attached later is Pro too
    const anon = (await (await call("POST", "/v1/spaces", ADMIN, {})).json()) as { token: string };
    await loginOk(user, anon.token);
    expect(((await (await call("GET", "/v1/space", anon.token)).json()) as { usage: { plan: string; seats: number } }).usage).toMatchObject({ plan: "paid", seats: 2 });
    // seat change from the portal reaches the account (by customer)
    expect(((await (await webhook(evt("customer.subscription.updated", proSub(sub.id, customer, 5), now() + 10))).json()) as { result: string }).result).toBe("applied");
    expect((await account(await session(user))).seats).toBe(5);
    // a second checkout is refused while paid; the portal opens for the account's customer
    expect((await site("POST", "/v1/account/billing/checkout", await session(user), { interval: "year", seats: 1 })).status).toBe(400);
    let pbody = "";
    stripe()
      .intercept({ path: "/v1/billing_portal/sessions", method: "POST" })
      .reply(200, (o) => ((pbody = String(o.body)), { url: "https://billing.stripe.com/p/session/x" }));
    const p = await site("POST", "/v1/account/billing/portal", await session(user), {});
    expect(p.status).toBe(201);
    expect(form(pbody)).toMatchObject({ customer, return_url: `${SITE}/account/` });
    // the operator sees the account, with plan, seats and spaces (no email)
    const list = ((await (await call("GET", "/v1/admin/accounts", ADMIN)).json()) as { accounts: Array<Record<string, unknown>> }).accounts;
    expect(list.find((x) => x.id === user)).toMatchObject({ plan: "paid", seats: 5, spaces: 2, utm_campaign: "vid1" });
    fetchMock.assertNoPendingInterceptors();
  });

  it("`weft upgrade` in a space with no account is sent through login; in an account space it buys for the account", async () => {
    const anon = (await (await call("POST", "/v1/spaces", ADMIN, {})).json()) as { token: string };
    const r = await call("POST", "/v1/space/billing/checkout", anon.token, { interval: "month", seats: 1 });
    expect(r.status).toBe(403);
    expect((await errOf(r)).details).toMatchObject({ reason: "login_required" });
    const user = newUser();
    await loginOk(user, anon.token);
    let body = "";
    stripe()
      .intercept({ path: "/v1/checkout/sessions", method: "POST" })
      .reply(200, (o) => ((body = String(o.body)), { id: "cs_test_acc2", url: "https://checkout.stripe.com/c/pay/cs_test_acc2" }));
    const ok = await call("POST", "/v1/space/billing/checkout", anon.token, { interval: "year", seats: 3 });
    expect(ok.status).toBe(201);
    expect(form(body)).toMatchObject({ client_reference_id: user, "metadata[weft_account]": user, "line_items[0][price]": "price_pro_year", "line_items[0][quantity]": "3" });
    fetchMock.assertNoPendingInterceptors();
  });
});

// ------------------------------------------------------------------ delete

describe("deleting an account", () => {
  it("cancels the subscription first, erases every space of the account, then the account itself", async () => {
    const user = newUser();
    const a = await loginOk(user);
    const customer = `cus_${uid()}`;
    const sub = proSub(`sub_${uid()}`, customer, 1);
    stripe().intercept({ path: `/v1/subscriptions/${sub.id}`, method: "GET" }).reply(200, sub);
    await webhook(accountCheckoutDone(user, customer, sub.id));
    const calls: string[] = [];
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer, status: "all", limit: "100" } }).reply(200, { data: [{ id: sub.id, status: "active" }] });
    stripe().intercept({ path: `/v1/subscriptions/${sub.id}`, method: "DELETE", query: { invoice_now: "true", prorate: "false" } }).reply(200, () => (calls.push("cancel"), { id: sub.id, status: "canceled" }));
    const r = await site("DELETE", "/v1/account", await session(user));
    expect(r.status).toBe(200);
    const rep = (await r.json()) as { deleted: boolean; subscriptions_cancelled: number; spaces: Array<{ space: string; status: string }> };
    expect(rep).toMatchObject({ deleted: true, subscriptions_cancelled: 1 });
    expect(rep.spaces.map((s) => [s.space, s.status])).toEqual([[a.space, "erased"]]);
    expect(calls).toEqual(["cancel"]);
    expect((await call("GET", "/v1/space", a.token!)).status).toBe(401);
    const left = await runInDurableObject(registry(), (i: Registry) => [...(i as any).sql.exec("SELECT id FROM accounts WHERE id = ?", user)].length);
    expect(left).toBe(0);
    fetchMock.assertNoPendingInterceptors();
  });

  it("if Stripe cannot cancel, nothing is deleted", async () => {
    const user = newUser();
    const a = await loginOk(user);
    const customer = `cus_${uid()}`;
    const sub = proSub(`sub_${uid()}`, customer, 1);
    stripe().intercept({ path: `/v1/subscriptions/${sub.id}`, method: "GET" }).reply(200, sub);
    await webhook(accountCheckoutDone(user, customer, sub.id));
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer, status: "all", limit: "100" } }).reply(500, { error: { message: "down" } });
    const r = await site("DELETE", "/v1/account", await session(user));
    expect(r.status).toBe(503);
    expect((await call("GET", "/v1/space", a.token!)).status).toBe(200);
    expect((await account(await session(user))).plan).toBe("paid");
  });
});
