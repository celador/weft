// The Commercial License bought by an account (docs/commercial-license.md, docs/pricing.md): yearly per seat or once
// per seat, recorded by the webhook as purchases on the account; Pro includes it; a license key shows what the account
// holds to a machine that never signs in, and nothing else. Stripe is mocked with fetchMock (vitest.accounts.config.ts).

import { SELF, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signStripePayload } from "../../src/stripe";
import { BASE, call } from "../helpers";
import { WEFT_JWK } from "./keys";

const ISSUER = "https://clerk.weft.test";
const SITE = "https://site.test";
const SECRET = "whsec_unit_secret";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function jwt(claims: Record<string, unknown>): Promise<string> {
  const body = `${b64url(JSON.stringify({ alg: "RS256", kid: WEFT_JWK.kid, typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const k = await crypto.subtle.importKey("jwk", { ...WEFT_JWK, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, new TextEncoder().encode(body))))}`;
}
let n = 0;
const newUser = () => `user_lic${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}${(n++).toString(36)}`;
const now = () => Math.floor(Date.now() / 1000);
const session = (sub: string) => jwt({ iss: ISSUER, sub, sid: `sess_${sub.slice(5, 15)}`, azp: SITE, iat: now(), nbf: now() - 1, exp: now() + 60 });
let ipN = 0;
const ip = () => `203.0.113.${(ipN++ % 250) + 1}-${crypto.randomUUID().slice(0, 6)}`;
const site = (method: string, p: string, token?: string, body?: unknown) => call(method, p, token, body, { origin: SITE, "cf-connecting-ip": ip() });
const stripe = () => fetchMock.get("https://api.stripe.com");
const form = (b: string) => Object.fromEntries(new URLSearchParams(b));
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
let evN = 0;
const evt = (type: string, object: Record<string, unknown>, created = now()) => ({ id: `evt_lic_${Date.now().toString(36)}${(evN++).toString(36)}`, type, created, data: { object } });
async function webhook(event: unknown): Promise<string> {
  const raw = JSON.stringify(event);
  const r = await SELF.fetch(`${BASE}/v1/billing/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": await signStripePayload(raw, SECRET) }, body: raw });
  expect(r.status).toBe(200);
  return ((await r.json()) as { result: string }).result;
}

type License = { active: boolean; included_in_pro: boolean; seats: number; lifetime_seats: number; year_seats: number; term: string | null; valid_until: string | null; renews: boolean; purchases: Array<{ term: string; seats: number; status: string }>; key: { hint: string } | null };
async function license(user: string): Promise<License> {
  const r = await site("GET", "/v1/account", await session(user));
  expect(r.status).toBe(200);
  return ((await r.json()) as { account: { license: License } }).account.license;
}
const licSub = (id: string, customer: string, seats: number, o: { status?: string; start?: number; end?: number; cancel?: boolean; ended?: number } = {}) => ({
  id,
  object: "subscription",
  status: o.status ?? "active",
  customer,
  cancel_at_period_end: o.cancel ?? false,
  ...(o.ended ? { ended_at: o.ended } : {}),
  metadata: { weft_product: "license" },
  items: { data: [{ quantity: seats, current_period_start: o.start ?? now() - 60, current_period_end: o.end ?? now() + 365 * 86400, price: { id: "price_license_year", recurring: { interval: "year", usage_type: "licensed" } } }] },
});
const lifetimeDone = (user: string, customer: string, cs: string, paid = "paid") =>
  evt("checkout.session.completed", { id: cs, mode: "payment", client_reference_id: user, metadata: { weft_account: user, weft_product: "license", weft_term: "lifetime" }, customer, payment_status: paid, amount_total: 17400 });
const yearDone = (user: string, customer: string, sub: string) =>
  evt("checkout.session.completed", { id: `cs_test_${uid()}`, mode: "subscription", client_reference_id: user, metadata: { weft_account: user, weft_product: "license", weft_term: "year" }, customer, subscription: sub, payment_status: "paid", amount_total: 5800 });

describe("the Commercial License: buying it", () => {
  it("lifetime: Checkout is a one-time payment per seat; the webhook reads the seats from Stripe and records them; never ends", async () => {
    const user = newUser();
    expect(await license(user)).toMatchObject({ active: false, seats: 0, term: null, key: null });
    let body = "";
    stripe()
      .intercept({ path: "/v1/checkout/sessions", method: "POST" })
      .reply(200, (o) => ((body = String(o.body)), { id: "cs_test_lic1", url: "https://checkout.stripe.com/c/pay/cs_test_lic1" }));
    const r = await site("POST", "/v1/account/billing/checkout", await session(user), { product: "license", term: "lifetime", seats: 3 });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ product: "license", term: "lifetime", seats: 3, url: "https://checkout.stripe.com/c/pay/cs_test_lic1" });
    expect(form(body)).toMatchObject({
      mode: "payment",
      client_reference_id: user,
      customer_creation: "always",
      "metadata[weft_account]": user,
      "metadata[weft_product]": "license",
      "metadata[weft_term]": "lifetime",
      "payment_intent_data[metadata][weft_product]": "license",
      "invoice_creation[enabled]": "true",
      "line_items[0][price]": "price_license_lifetime",
      "line_items[0][quantity]": "3",
      "line_items[0][adjustable_quantity][enabled]": "true",
      success_url: `${SITE}/account/?checkout=done&product=license`,
    });
    expect(body).not.toContain("subscription_data");

    // the buyer changed 3 -> 4 seats on the Checkout page: the webhook takes Stripe's line items, not our request
    const customer = `cus_${uid()}`;
    const cs = `cs_test_${uid()}`;
    stripe().intercept({ path: `/v1/checkout/sessions/${cs}/line_items`, method: "GET", query: { limit: "10" } }).reply(200, { data: [{ quantity: 4, price: { id: "price_license_lifetime" } }] });
    const ev = lifetimeDone(user, customer, cs);
    expect(await webhook(ev)).toBe("applied");
    expect(await webhook(ev)).toBe("duplicate"); // replay: no Stripe read, nothing changes
    expect(await license(user)).toMatchObject({ active: true, included_in_pro: false, seats: 4, lifetime_seats: 4, year_seats: 0, term: "lifetime", valid_until: null, renews: false, purchases: [{ term: "lifetime", seats: 4, status: "active" }] });
    // an unpaid one-time session (delayed payment method) is not a license yet
    expect(await webhook(lifetimeDone(user, customer, `cs_test_${uid()}`, "unpaid"))).toBe("ignored");
    // the account's billing customer is now the license customer (Manage billing opens for it)
    const a = ((await (await site("GET", "/v1/account", await session(user))).json()) as { account: { has_billing_account: boolean; plan: string } }).account;
    expect(a).toMatchObject({ has_billing_account: true, plan: "free" }); // a license is not Pro
    fetchMock.assertNoPendingInterceptors();
  });

  it("yearly: a subscription per seat; cancelling keeps it to the end of the paid period; a failed renewal ends it at the paid period", async () => {
    const user = newUser();
    await license(user);
    let body = "";
    stripe()
      .intercept({ path: "/v1/checkout/sessions", method: "POST" })
      .reply(200, (o) => ((body = String(o.body)), { id: "cs_test_lic2", url: "https://checkout.stripe.com/c/pay/cs_test_lic2" }));
    expect((await site("POST", "/v1/account/billing/checkout", await session(user), { product: "license", term: "year", seats: 2 })).status).toBe(201);
    expect(form(body)).toMatchObject({ mode: "subscription", "line_items[0][price]": "price_license_year", "line_items[0][quantity]": "2", "subscription_data[metadata][weft_product]": "license", "subscription_data[metadata][weft_account]": user });

    const customer = `cus_${uid()}`;
    const end = now() + 365 * 86400;
    const sub = licSub(`sub_${uid()}`, customer, 2, { end });
    stripe().intercept({ path: `/v1/subscriptions/${sub.id}`, method: "GET" }).reply(200, sub);
    expect(await webhook(yearDone(user, customer, sub.id))).toBe("applied");
    expect(await license(user)).toMatchObject({ active: true, seats: 2, year_seats: 2, term: "year", renews: true, valid_until: new Date(end * 1000).toISOString() });

    // cancelled in the portal: still licensed until the end of the paid year, no longer renews
    expect(await webhook(evt("customer.subscription.updated", licSub(sub.id, customer, 2, { end, cancel: true }), now() + 5))).toBe("applied");
    expect(await license(user)).toMatchObject({ active: true, seats: 2, renews: false, purchases: [{ status: "ends" }] });
    // the subscription ends at period end (ended_at = the end of the paid year): it stays valid until then
    expect(await webhook(evt("customer.subscription.deleted", licSub(sub.id, customer, 2, { end, status: "canceled", ended: end }), now() + 6))).toBe("applied");
    expect(await license(user)).toMatchObject({ active: true, seats: 2, renews: false, valid_until: new Date(end * 1000).toISOString(), purchases: [{ status: "ends" }] });
    // an older event arriving late changes nothing
    expect(await webhook(evt("customer.subscription.updated", licSub(sub.id, customer, 9, { end }), now() - 100))).toBe("stale");

    // a second yearly purchase whose renewal failed: paid only up to the start of the unpaid period, so it no longer counts
    const sub2 = licSub(`sub_${uid()}`, customer, 5, { end });
    stripe().intercept({ path: `/v1/subscriptions/${sub2.id}`, method: "GET" }).reply(200, sub2);
    expect(await webhook(yearDone(user, customer, sub2.id))).toBe("applied");
    expect((await license(user)).seats).toBe(7);
    expect(await webhook(evt("customer.subscription.updated", licSub(sub2.id, customer, 5, { status: "past_due", start: now() - 10, end }), now() + 7))).toBe("applied");
    expect(await license(user)).toMatchObject({ active: true, seats: 2 });
    fetchMock.assertNoPendingInterceptors();
  });

  it("Pro includes the license: buying one on a Pro account is refused, and license events never change the Pro plan", async () => {
    const user = newUser();
    await license(user);
    const customer = `cus_${uid()}`;
    const pro = { id: `sub_${uid()}`, object: "subscription", status: "active", customer, items: { data: [{ quantity: 3, current_period_end: now() + 30 * 86400, price: { id: "price_pro_month", recurring: { interval: "month", usage_type: "licensed" } } }] } };
    stripe().intercept({ path: `/v1/subscriptions/${pro.id}`, method: "GET" }).reply(200, pro);
    expect(await webhook(evt("checkout.session.completed", { id: `cs_test_${uid()}`, mode: "subscription", client_reference_id: user, metadata: { weft_account: user, weft_plan: "pro" }, customer, subscription: pro.id, payment_status: "paid", amount_total: 3600 }))).toBe("applied");
    expect(await license(user)).toMatchObject({ active: true, included_in_pro: true, seats: 0, term: null });
    const r = await site("POST", "/v1/account/billing/checkout", await session(user), { product: "license", term: "lifetime", seats: 1 });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("included_in_pro");
    expect((await site("POST", "/v1/account/billing/checkout", await session(user), { product: "gold" })).status).toBe(400);
    expect((await site("POST", "/v1/account/billing/checkout", await session(user), { product: "license", term: "forever" })).status).toBe(400);

    // a license subscription on the same customer that ends, or whose renewal invoice fails, leaves Pro alone
    const lic = licSub(`sub_${uid()}`, customer, 1, { end: now() - 5 });
    expect(await webhook(evt("customer.subscription.deleted", { ...lic, status: "canceled" }, now() + 10))).toBe("applied"); // recorded as an ended purchase
    expect(await license(user)).toMatchObject({ included_in_pro: true, seats: 0, purchases: [{ status: "ended" }] });
    expect(await webhook(evt("invoice.payment_failed", { id: `in_${uid()}`, customer, parent: { subscription_details: { metadata: { weft_product: "license" }, subscription: lic.id } }, lines: { data: [] } }, now() + 11))).toBe("ignored");
    expect(await webhook(evt("invoice.payment_failed", { id: `in_${uid()}`, customer, lines: { data: [{ pricing: { price_details: { price: "price_license_year" } } }] } }, now() + 12))).toBe("ignored");
    const a = ((await (await site("GET", "/v1/account", await session(user))).json()) as { account: { plan: string; seats: number } }).account;
    expect(a).toMatchObject({ plan: "paid", seats: 3 });
    fetchMock.assertNoPendingInterceptors();
  });
});

describe("the license key", () => {
  it("is made only for a licensed account, shown once, stored hashed; a check says what it covers and nothing about who owns it", async () => {
    const user = newUser();
    await license(user);
    const nope = await site("POST", "/v1/account/license/key", await session(user), {});
    expect(nope.status).toBe(403);

    const customer = `cus_${uid()}`;
    const cs = `cs_test_${uid()}`;
    stripe().intercept({ path: `/v1/checkout/sessions/${cs}/line_items`, method: "GET", query: { limit: "10" } }).reply(200, { data: [{ quantity: 3, price: { id: "price_license_lifetime" } }] });
    expect(await webhook(lifetimeDone(user, customer, cs))).toBe("applied");

    const r = await site("POST", "/v1/account/license/key", await session(user), {});
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
    const k1 = (await r.json()) as { key: string; hint: string };
    expect(k1.key).toMatch(/^weft_lic_[A-Za-z0-9_-]{32}$/);
    expect(k1.hint).toBe(k1.key.slice(-4));
    // the account page shows only the hint from now on
    expect((await license(user)).key).toMatchObject({ hint: k1.hint });
    expect(JSON.stringify(await license(user))).not.toContain(k1.key);

    const verify = (key: string) => call("POST", "/v1/license/verify", undefined, { key }, { "cf-connecting-ip": ip() });
    const v = await verify(k1.key);
    expect(v.status).toBe(200);
    const vj = (await v.json()) as { license: Record<string, unknown> };
    expect(vj.license).toMatchObject({ active: true, seats: 3, term: "lifetime", valid_until: null });
    expect(JSON.stringify(vj)).not.toContain(user); // never the account id
    expect(vj.license).not.toHaveProperty("purchases");
    expect(vj.license).not.toHaveProperty("key");

    // a new key replaces the old one at once
    const k2 = (await (await site("POST", "/v1/account/license/key", await session(user), {})).json()) as { key: string };
    expect(k2.key).not.toBe(k1.key);
    expect((await verify(k1.key)).status).toBe(404);
    expect((await verify(k2.key)).status).toBe(200);
    for (const bad of ["", "weft_lic_short", `weft_lic_${"A".repeat(32)}`, "x".repeat(81)]) expect((await verify(bad)).status, bad).toBeGreaterThanOrEqual(400);
    // it can do nothing else: not a space key, not a session token
    expect((await call("GET", "/v1/space", k2.key)).status).toBe(401);
    expect((await site("GET", "/v1/account", k2.key)).status).toBe(401);
    fetchMock.assertNoPendingInterceptors();
  });

  it("`weft license` when signed in: the space owner's GET /v1/space carries the account's license; deleting the account deletes it", async () => {
    const user = newUser();
    // weft login (device flow) for a space on the account
    const s = (await (await call("POST", "/v1/login", undefined, {}, { "cf-connecting-ip": ip() })).json()) as { device_code: string; user_code: string };
    expect((await site("POST", "/v1/login/approve", await session(user), { code: s.user_code })).status).toBe(200);
    const owner = ((await (await call("POST", "/v1/login/poll", undefined, { device_code: s.device_code }, { "cf-connecting-ip": ip() })).json()) as { token: string }).token;
    const customer = `cus_${uid()}`;
    const cs = `cs_test_${uid()}`;
    stripe().intercept({ path: `/v1/checkout/sessions/${cs}/line_items`, method: "GET", query: { limit: "10" } }).reply(200, { data: [{ quantity: 2, price: { id: "price_license_lifetime" } }] });
    expect(await webhook(lifetimeDone(user, customer, cs))).toBe("applied");
    const sp = (await (await call("GET", "/v1/space", owner)).json()) as { license: License | null };
    expect(sp.license).toMatchObject({ active: true, seats: 2, term: "lifetime" });
    const key = ((await (await site("POST", "/v1/account/license/key", await session(user), {})).json()) as { key: string }).key;
    // delete the account (no subscription to cancel: a lifetime license has none)
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer, status: "all", limit: "100" } }).reply(200, { data: [] });
    expect((await site("DELETE", "/v1/account", await session(user))).status).toBe(200);
    expect((await call("POST", "/v1/license/verify", undefined, { key }, { "cf-connecting-ip": ip() })).status).toBe(404);
    expect(await license(user)).toMatchObject({ active: false, seats: 0, key: null });
    fetchMock.assertNoPendingInterceptors();
  });
});
