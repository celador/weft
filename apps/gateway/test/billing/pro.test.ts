// Weft Pro (per user) inside the Workers runtime: CLI-first checkout with seats, the web-first purchase
// (GET /buy -> Stripe -> welcome page -> claim code -> `--claim`), seat changes from the Customer Portal, fair
// use (flagged, never cut off), no meter events for Pro, and erasing a Pro space. Stripe is mocked with
// fetchMock (vitest.billing.config.ts: Pro prices price_pro_month / price_pro_year, fair use 5 events per seat).

import { SELF, env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Welcome } from "@weft/protocol";
import type { Registry } from "../../src/registry";
import { signStripePayload } from "../../src/stripe";
import { ADMIN, BASE, call, hello, wcp } from "../helpers";

const SECRET = "whsec_unit_secret";
const ALLOWANCE = 6;
const FAIR_PER_SEAT = 5;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());

// ------------------------------------------------------------------ helpers

let ipN = 0;
const ip = () => `192.0.2.${(ipN++ % 250) + 1}-${crypto.randomUUID().slice(0, 6)}`;
async function signup() {
  const r = await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": ip() });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { space: { id: string }; token: string };
  return { id: j.space.id, owner: j.token };
}

type Usage = { month: string; events: number; allowance: number; plan: "free" | "paid"; has_billing_account: boolean; seats: number | null; interval: string | null; fair_use_events: number | null; over_fair_use: boolean };
const usage = async (owner: string) => ((await (await call("GET", "/v1/space", owner)).json()) as { usage: Usage }).usage;

async function agentSpace() {
  const s = await signup();
  const name = `p${(ipN++).toString(36)}`;
  await call("POST", "/v1/space/repos", s.owner, { name });
  const repo = `${s.id}-${name}`;
  const t = (await (await call("POST", "/v1/space/tokens", s.owner, { kind: "agent", repo, agent: "a1" })).json()) as { token: string };
  const sess = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, t.token, hello("a1", `I-${s.id}`));
  return { ...s, repo, agent: t.token, session: sess.session, head: sess.head_seq, n: 0 };
}
type AgentSpace = Awaited<ReturnType<typeof agentSpace>>;

async function submit(a: AgentSpace) {
  const r = await call("POST", `/v1/repos/${a.repo}/sessions/${a.session}/events`, a.agent, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: a.head, writes: [{ key: `src/f${a.n++}.ts#x`, kind: "body" }] } });
  if (r.status === 200) a.head = ((await r.clone().json()) as { head_seq: number }).head_seq;
  return r;
}

async function untilEvents(owner: string, n: number) {
  for (let i = 0; i < 100; i++) {
    if ((await usage(owner)).events === n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`usage never reached ${n}`);
}

let evN = 0;
const evt = (type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) => ({ id: `evt_pro_${Date.now().toString(36)}${(evN++).toString(36)}`, type, created, data: { object } });
async function webhook(event: unknown, secret = SECRET) {
  const raw = JSON.stringify(event);
  return SELF.fetch(`${BASE}/v1/billing/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": await signStripePayload(raw, secret) }, body: raw });
}
const hookResult = async (r: Response) => ((await r.json()) as { result: string }).result;

const stripe = () => fetchMock.get("https://api.stripe.com");
const form = (b: string) => Object.fromEntries(new URLSearchParams(b));

/** A Stripe subscription object for a Pro price. */
const proSub = (id: string, customer: string, seats: number, interval: "month" | "year" = "month", status = "active") => ({
  id,
  object: "subscription",
  status,
  customer,
  items: { data: [{ quantity: seats, price: { id: interval === "year" ? "price_pro_year" : "price_pro_month", recurring: { interval, usage_type: "licensed" } } }] },
});
const mockSub = (sub: ReturnType<typeof proSub>) => stripe().intercept({ path: `/v1/subscriptions/${sub.id}`, method: "GET" }).reply(200, sub);

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const spaceCheckout = (space: string, customer: string, subscription: string) =>
  evt("checkout.session.completed", { id: `cs_test_${uid()}`, mode: "subscription", client_reference_id: space, metadata: { weft_space: space, weft_plan: "pro" }, customer, subscription, payment_status: "paid", amount_total: 2400 });
const webCheckout = (session: string, customer: string, subscription: string) =>
  evt("checkout.session.completed", { id: session, object: "checkout.session", mode: "subscription", status: "complete", client_reference_id: null, metadata: { weft_purchase: "web", weft_plan: "pro" }, customer, subscription, payment_status: "paid", amount_total: 2400 });

/** A web purchase Stripe has told us about (webhook), ready to claim. */
async function webPurchase(seats = 2, interval: "month" | "year" = "month") {
  const session = `cs_test_${uid()}${uid()}`;
  const customer = `cus_${uid()}`;
  const sub = proSub(`sub_${uid()}`, customer, seats, interval);
  mockSub(sub);
  const r = await webhook(webCheckout(session, customer, sub.id));
  expect(r.status).toBe(200);
  expect(await hookResult(r)).toBe("applied");
  return { session, customer, subscription: sub.id };
}

const claimStart = (session: unknown, headers: Record<string, string> = {}) => call("POST", "/v1/billing/claim", undefined, { session_id: session }, { "cf-connecting-ip": ip(), ...headers });
async function claimCode(session: string): Promise<string> {
  const r = await claimStart(session);
  expect(r.status).toBe(201);
  return ((await r.json()) as { code: string }).code;
}
const redeem = (owner: string, code: string) => call("POST", "/v1/space/billing/claim", owner, { code }, { "cf-connecting-ip": ip() });
const labelSub = (sub: string) => stripe().intercept({ path: `/v1/subscriptions/${sub}`, method: "POST" }).reply(200, { id: sub });

const registry = () => env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));

// ------------------------------------------------------------------ CLI-first

describe("CLI-first Pro: checkout -> webhook -> plan paid with seats", () => {
  it("checkout.session.completed reads the subscription and sets plan, seats and interval; a replay is a no-op", async () => {
    const a = await signup();
    const sub = proSub(`sub_${uid()}`, `cus_${uid()}`, 2, "year");
    mockSub(sub);
    const e = spaceCheckout(a.id, sub.customer, sub.id);
    expect(await hookResult(await webhook(e))).toBe("applied");
    expect(await usage(a.owner)).toMatchObject({ plan: "paid", seats: 2, interval: "year", has_billing_account: true, fair_use_events: 2 * FAIR_PER_SEAT, over_fair_use: false });
    expect(await hookResult(await webhook(e))).toBe("duplicate"); // no second Stripe read (no interceptor left)
    fetchMock.assertNoPendingInterceptors();
  });

  it("if Stripe cannot be read, the webhook answers 503 (Stripe retries) and nothing changes; the retry applies", async () => {
    const a = await signup();
    const sub = proSub(`sub_${uid()}`, `cus_${uid()}`, 3);
    const e = spaceCheckout(a.id, sub.customer, sub.id);
    stripe().intercept({ path: `/v1/subscriptions/${sub.id}`, method: "GET" }).reply(500, { error: { message: "down" } });
    expect((await webhook(e)).status).toBe(503);
    expect(await usage(a.owner)).toMatchObject({ plan: "free", seats: null });
    mockSub(sub);
    expect(await hookResult(await webhook(e))).toBe("applied");
    expect(await usage(a.owner)).toMatchObject({ plan: "paid", seats: 3, interval: "month" });
  });

  it("a subscription that is not active yet does not make the space paid", async () => {
    const a = await signup();
    const sub = proSub(`sub_${uid()}`, `cus_${uid()}`, 1, "month", "incomplete");
    mockSub(sub);
    await webhook(spaceCheckout(a.id, sub.customer, sub.id));
    expect((await usage(a.owner)).plan).toBe("free");
  });

  it("seat changes and cancellation from the Customer Portal reach the space; an older event cannot undo a newer one", async () => {
    const a = await signup();
    const sub = proSub(`sub_${uid()}`, `cus_${uid()}`, 2);
    mockSub(sub);
    const now = Math.floor(Date.now() / 1000);
    await webhook(spaceCheckout(a.id, sub.customer, sub.id));
    expect(await hookResult(await webhook(evt("customer.subscription.updated", proSub(sub.id, sub.customer, 5, "year"), now + 10)))).toBe("applied");
    expect(await usage(a.owner)).toMatchObject({ plan: "paid", seats: 5, interval: "year" });
    expect(await hookResult(await webhook(evt("customer.subscription.updated", proSub(sub.id, sub.customer, 4, "year"), now + 5)))).toBe("stale");
    expect((await usage(a.owner)).seats).toBe(5);
    expect(await hookResult(await webhook(evt("customer.subscription.deleted", proSub(sub.id, sub.customer, 5, "year", "canceled"), now + 20)))).toBe("applied");
    expect(await usage(a.owner)).toMatchObject({ plan: "free", seats: null, fair_use_events: null });
  });
});

// ------------------------------------------------------------------ Pro is never metered or cut off; fair use is flagged

describe("Pro usage: no cut-off, no meter events, fair use flagged for the operator", () => {
  it("a Pro space passes the free allowance and fair use without a refusal, sends no meter event, and shows in /v1/admin/spaces", async () => {
    const a = await agentSpace();
    const sub = proSub(`sub_${uid()}`, `cus_${uid()}`, 2);
    mockSub(sub);
    await webhook(spaceCheckout(a.id, sub.customer, sub.id));
    const total = 2 * FAIR_PER_SEAT + 2; // past the allowance (6) and past fair use (10)
    for (let i = 0; i < total; i++) expect((await submit(a)).status).toBe(200);
    await untilEvents(a.owner, total);
    expect(await usage(a.owner)).toMatchObject({ plan: "paid", seats: 2, events: total, fair_use_events: 10, over_fair_use: true });
    // no meter event for Pro: the report has nothing to send (no interceptor, so a call would count as failed)
    expect(await (await call("POST", "/v1/admin/billing/report", ADMIN, { space: a.id })).json()).toMatchObject({ sent: 0, failed: 0 });
    const spaces = ((await (await call("GET", "/v1/admin/spaces", ADMIN)).json()) as { spaces: Array<Record<string, unknown>> }).spaces;
    const row = spaces.find((s) => s.id === a.id)!;
    expect(row).toMatchObject({ plan: "paid", seats: 2, interval: "month", events_this_month: total });
    expect(typeof row.fair_use_exceeded_at).toBe("string");
    const summary = (await (await call("GET", "/v1/admin/billing", ADMIN)).json()) as { pro: { spaces: number; seats: number; over_fair_use: number } };
    expect(summary.pro.spaces).toBeGreaterThanOrEqual(1);
    expect(summary.pro.over_fair_use).toBeGreaterThanOrEqual(1);
    fetchMock.assertNoPendingInterceptors();
  });
});

// ------------------------------------------------------------------ web-first: /buy

describe("GET /buy", () => {
  it("answers 303 to a Pro Checkout Session with no space, seats adjustable, utm passed into metadata, welcome URL with the session id", async () => {
    let body = "";
    stripe()
      .intercept({ path: "/v1/checkout/sessions", method: "POST" })
      .reply(200, (o) => ((body = String(o.body)), { id: "cs_test_buy1", url: "https://checkout.stripe.com/c/pay/cs_test_buy1" }));
    const r = await SELF.fetch(`${BASE}/buy?interval=year&seats=2&utm_source=x.com&utm_campaign=launch%20video<script>&foo=bar`, { redirect: "manual", headers: { "cf-connecting-ip": ip() } });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/cs_test_buy1");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const f = form(body);
    expect(f).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_pro_year",
      "line_items[0][quantity]": "2",
      "line_items[0][adjustable_quantity][enabled]": "true",
      "metadata[weft_purchase]": "web",
      "metadata[weft_plan]": "pro",
      "metadata[utm_source]": "x.com",
      "metadata[utm_campaign]": "launch videoscript",
      "subscription_data[metadata][weft_purchase]": "web",
      success_url: "https://site.test/welcome/?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://site.test/pricing/",
      allow_promotion_codes: "true",
    });
    expect(f.client_reference_id).toBeUndefined();
    expect(f["metadata[foo]"]).toBeUndefined();
    fetchMock.assertNoPendingInterceptors();
  });

  it("defaults to monthly, one seat; refuses a bad interval or seat count with a page and no Stripe call", async () => {
    let body = "";
    stripe()
      .intercept({ path: "/v1/checkout/sessions", method: "POST" })
      .reply(200, (o) => ((body = String(o.body)), { id: "cs_test_buy2", url: "https://checkout.stripe.com/c/pay/cs_test_buy2" }));
    expect((await SELF.fetch(`${BASE}/buy`, { redirect: "manual", headers: { "cf-connecting-ip": ip() } })).status).toBe(303);
    expect(form(body)).toMatchObject({ "line_items[0][price]": "price_pro_month", "line_items[0][quantity]": "1" });
    for (const q of ["interval=week", "seats=0", "seats=501", "seats=1.5", "seats=abc"]) {
      const r = await SELF.fetch(`${BASE}/buy?${q}`, { redirect: "manual", headers: { "cf-connecting-ip": ip() } });
      expect(r.status, q).toBe(400);
      expect(r.headers.get("content-type")).toContain("text/html");
    }
    fetchMock.assertNoPendingInterceptors();
  });

  it("is rate limited per network", async () => {
    const net = ip();
    stripe().intercept({ path: "/v1/checkout/sessions", method: "POST" }).reply(200, { id: "cs_test_rl", url: "https://checkout.stripe.com/c/pay/cs_test_rl" }).times(10);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await SELF.fetch(`${BASE}/buy`, { redirect: "manual", headers: { "cf-connecting-ip": net } })).status);
    expect(codes.slice(0, 10).every((c) => c === 303)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

// ------------------------------------------------------------------ web-first: webhook, claim code, redeem

describe("web purchase -> claim code -> space becomes Pro", () => {
  it("the whole path: webhook records the purchase, the welcome page gets a one-time code, --claim makes the space Pro with the purchase's seats", async () => {
    const p = await webPurchase(2, "year");
    const r = await claimStart(p.session, { origin: "https://site.test" });
    expect(r.status).toBe(201);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://site.test");
    const c = (await r.json()) as { code: string; expires_at: string; seats: number; interval: string; command: string };
    expect(c.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(c).toMatchObject({ seats: 2, interval: "year", command: `npx @celador/weft --hosted --claim ${c.code}` });
    expect(Date.parse(c.expires_at) - Date.now()).toBeGreaterThan(55 * 60_000);
    // the code is stored only as a salted hash: no row holds it in clear
    const stored = await runInDurableObject(registry(), (i: Registry) => [...(i as any).sql.exec("SELECT code_hash FROM claim_codes")].map((x: { code_hash: string }) => x.code_hash));
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.join(",")).not.toContain(c.code.replace(/-/g, ""));

    const s = await signup();
    labelSub(p.subscription);
    const red = await redeem(s.owner, c.code.toLowerCase().replace(/-/g, " ")); // case and separators do not matter
    expect(red.status).toBe(200);
    expect(await red.json()).toEqual({ type: "billing.claimed", plan: "paid", product: "pro", seats: 2, interval: "year" });
    expect(await usage(s.owner)).toMatchObject({ plan: "paid", seats: 2, interval: "year", has_billing_account: true });
    fetchMock.assertNoPendingInterceptors(); // the subscription was labelled with the space

    // single use, and the purchase cannot be claimed again
    const other = await signup();
    expect((await redeem(other.owner, c.code)).status).toBe(401);
    const again = await claimStart(p.session);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { details: { status: string } } }).error.details.status).toBe("claimed");
    expect((await usage(other.owner)).plan).toBe("free");

    // later Portal changes reach the claimed space through its customer
    expect(await hookResult(await webhook(evt("customer.subscription.updated", proSub(p.subscription, p.customer, 7, "year"), Math.floor(Date.now() / 1000) + 30)))).toBe("applied");
    expect((await usage(s.owner)).seats).toBe(7);
  });

  it("the same webhook event twice records the purchase once", async () => {
    const session = `cs_test_${uid()}${uid()}`;
    const customer = `cus_${uid()}`;
    const sub = proSub(`sub_${uid()}`, customer, 1);
    mockSub(sub);
    const e = webCheckout(session, customer, sub.id);
    expect(await hookResult(await webhook(e))).toBe("applied");
    expect(await hookResult(await webhook(e))).toBe("duplicate");
  });

  it("a forged webhook cannot create a purchase", async () => {
    const session = `cs_test_${uid()}${uid()}`;
    const r = await webhook(webCheckout(session, "cus_forged", "sub_forged"), "whsec_attacker");
    expect(r.status).toBe(400);
    stripe().intercept({ path: `/v1/checkout/sessions/${session}`, method: "GET" }).reply(404, { error: { message: "No such checkout.session" } });
    expect((await claimStart(session)).status).toBe(404);
  });

  it("if the welcome page gets there before the webhook, the purchase is read from Stripe", async () => {
    const session = `cs_test_${uid()}${uid()}`;
    const customer = `cus_${uid()}`;
    const sub = proSub(`sub_${uid()}`, customer, 3);
    stripe()
      .intercept({ path: `/v1/checkout/sessions/${session}`, method: "GET" })
      .reply(200, { id: session, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid", amount_total: 3600, client_reference_id: null, metadata: { weft_purchase: "web" }, customer, subscription: sub.id });
    mockSub(sub);
    const r = await claimStart(session);
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ seats: 3, interval: "month" });
    // the webhook arriving afterwards does not duplicate anything
    mockSub(sub);
    expect(["applied", "stale"]).toContain(await hookResult(await webhook(webCheckout(session, customer, sub.id))));
    fetchMock.assertNoPendingInterceptors();
  });

  it("a session that is not a paid web purchase gets no code", async () => {
    const unpaid = `cs_test_${uid()}${uid()}`;
    stripe().intercept({ path: `/v1/checkout/sessions/${unpaid}`, method: "GET" }).reply(200, { id: unpaid, mode: "subscription", status: "open", metadata: { weft_purchase: "web" }, customer: null, subscription: null });
    const r1 = await claimStart(unpaid);
    expect(r1.status).toBe(404);
    expect(((await r1.json()) as { error: { details: { status: string } } }).error.details.status).toBe("unknown");
    const theirs = `cs_test_${uid()}${uid()}`;
    stripe().intercept({ path: `/v1/checkout/sessions/${theirs}`, method: "GET" }).reply(200, { id: theirs, mode: "subscription", status: "complete", metadata: {}, customer: "cus_x", subscription: "sub_x" });
    expect((await claimStart(theirs)).status).toBe(404);
    for (const bad of ["", "cs_x", "pi_test_123456789", "cs_test_../../v1/x", 42]) expect((await claimStart(bad)).status, String(bad)).toBe(400);
    fetchMock.assertNoPendingInterceptors();
  });

  it("a purchase cancelled before it is claimed cannot be claimed", async () => {
    const p = await webPurchase(1);
    expect(await hookResult(await webhook(evt("customer.subscription.deleted", proSub(p.subscription, p.customer, 1, "month", "canceled"), Math.floor(Date.now() / 1000) + 30)))).toBe("applied");
    const r = await claimStart(p.session);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { details: { status: string } } }).error.details.status).toBe("inactive");
  });

  it("a space that already pays cannot claim; the code stays good for another space", async () => {
    const p = await webPurchase(2);
    const code = await claimCode(p.session);
    const paid = await signup();
    const sub = proSub(`sub_${uid()}`, `cus_${uid()}`, 1);
    mockSub(sub);
    await webhook(spaceCheckout(paid.id, sub.customer, sub.id));
    const r = await redeem(paid.owner, code);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { details: { status: string } } }).error.details.status).toBe("already_paid");
    const fresh = await signup();
    labelSub(p.subscription);
    expect((await redeem(fresh.owner, code)).status).toBe(200);
    expect((await usage(fresh.owner)).seats).toBe(2);
  });

  it("wrong codes all get the same 401; only the owner key may redeem; redeeming is rate limited", async () => {
    const a = await agentSpace();
    expect((await redeem(a.agent, "AAAA-BBBB-CCCC")).status).toBe(403);
    const s = await signup();
    const r = await redeem(s.owner, "AAAA-BBBB-CCCC");
    expect(r.status).toBe(401);
    const msg = ((await r.json()) as { error: { message: string } }).error.message;
    expect(msg).toContain("not valid or has expired");
    // per space: the 11th attempt in a minute is refused even from fresh networks
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await redeem(s.owner, "ZZZZ-ZZZZ-ZZZZ")).status);
    expect(codes).toContain(429);
  });

  it("asking for codes is rate limited per network, and only the site's origins get CORS", async () => {
    const p = await webPurchase(1);
    const pre = await SELF.fetch(`${BASE}/v1/billing/claim`, { method: "OPTIONS", headers: { origin: "https://site.test", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://site.test");
    const evil = await claimStart(p.session, { origin: "https://evil.test" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const net = ip();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await call("POST", "/v1/billing/claim", undefined, { session_id: p.session }, { "cf-connecting-ip": net, origin: "https://site.test" })).status);
    expect(codes[10]).toBe(429);
    // at most 3 codes are open per purchase at a time
    const open = await runInDurableObject(registry(), (i: Registry) => [...(i as any).sql.exec("SELECT COUNT(*) AS n FROM claim_codes WHERE session = ?", p.session)][0].n);
    expect(open).toBe(3);
  });
});

// ------------------------------------------------------------------ erase

describe("erasing a Pro space", () => {
  it("cancels the subscription first (no meter event), then removes the claimed purchase", async () => {
    const p = await webPurchase(2);
    const code = await claimCode(p.session);
    const s = await signup();
    labelSub(p.subscription);
    expect((await redeem(s.owner, code)).status).toBe(200);
    const calls: string[] = [];
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer: p.customer, status: "all", limit: "100" } }).reply(200, { data: [{ id: p.subscription, status: "active" }] });
    stripe().intercept({ path: `/v1/subscriptions/${p.subscription}`, method: "DELETE", query: { invoice_now: "true", prorate: "false" } }).reply(200, () => (calls.push("cancel"), { id: p.subscription, status: "canceled" }));
    const r = await call("DELETE", "/v1/space", s.owner);
    expect(r.status).toBe(200);
    expect(calls).toEqual(["cancel"]);
    fetchMock.assertNoPendingInterceptors();
    const left = await runInDurableObject(registry(), (i: Registry) => [...(i as any).sql.exec("SELECT session FROM entitlements WHERE session = ?", p.session)].length);
    expect(left).toBe(0);
  });
});
