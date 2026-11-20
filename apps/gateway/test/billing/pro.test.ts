// Weft Pro (per user) inside the Workers runtime: CLI-first checkout with seats on a gateway without accounts, seat
// changes from the Customer Portal, fair use (flagged, never cut off), no meter events for Pro, erasing a Pro space,
// and the anonymous web purchase being gone (test/accounts covers Pro bought by an account). Stripe is mocked with
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

// ------------------------------------------------------------------ the anonymous web purchase is gone

describe("no anonymous web purchase (accounts: paying on the web needs a signed-in account)", () => {
  it("GET /buy and POST /v1/billing/claim no longer exist, and no Stripe call is made", async () => {
    expect((await SELF.fetch(`${BASE}/buy?interval=month&seats=2`, { redirect: "manual", headers: { "cf-connecting-ip": ip() } })).status).toBe(404);
    expect((await call("POST", "/v1/billing/claim", undefined, { session_id: "cs_test_abcdefgh12345" }, { "cf-connecting-ip": ip() })).status).toBe(404);
    const s = await signup();
    expect((await call("POST", "/v1/space/billing/claim", s.owner, { code: "AAAA-BBBB-CCCC" })).status).toBe(404);
    fetchMock.assertNoPendingInterceptors();
  });
});

// ------------------------------------------------------------------ erase

describe("erasing a Pro space", () => {
  it("cancels the space's own subscription first (no meter event), then erases", async () => {
    const s = await signup();
    const sub = proSub(`sub_${uid()}`, `cus_${uid()}`, 2);
    mockSub(sub);
    await webhook(spaceCheckout(s.id, sub.customer, sub.id));
    const calls: string[] = [];
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer: sub.customer, status: "all", limit: "100" } }).reply(200, { data: [{ id: sub.id, status: "active" }] });
    stripe().intercept({ path: `/v1/subscriptions/${sub.id}`, method: "DELETE", query: { invoice_now: "true", prorate: "false" } }).reply(200, () => (calls.push("cancel"), { id: sub.id, status: "canceled" }));
    const r = await call("DELETE", "/v1/space", s.owner);
    expect(r.status).toBe(200);
    expect(calls).toEqual(["cancel"]);
    fetchMock.assertNoPendingInterceptors();
    const left = await runInDurableObject(registry(), (i: Registry) => [...(i as any).sql.exec("SELECT space FROM space_billing WHERE space = ?", s.id)].length);
    expect(left).toBe(0);
  });
});
