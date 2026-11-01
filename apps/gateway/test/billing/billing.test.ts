// Hosted usage billing end to end inside the Workers runtime (docs/pricing.md). The gateway runs with
// Stripe configured (vitest.billing.config.ts: free allowance 6, test-mode shaped secrets) and Stripe's API
// mocked with fetchMock, so these tests cover metering, the allowance gate, the webhook, usage reporting and
// erase without a network.

import { SELF, env, fetchMock, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Welcome } from "@weft/protocol";
import type { Registry } from "../../src/registry";
import { signStripePayload } from "../../src/stripe";
import { ADMIN, BASE, call, hello, wcp } from "../helpers";

const SECRET = "whsec_unit_secret";
const ALLOWANCE = 6;
const month = new Date().toISOString().slice(0, 7);

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());

// ------------------------------------------------------------------ helpers

let ipN = 0;
async function signup() {
  const r = await call("POST", "/v1/spaces", undefined, {}, { "cf-connecting-ip": `203.0.113.${(ipN++ % 250) + 1}-${crypto.randomUUID().slice(0, 6)}` });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { space: { id: string }; token: string };
  return { id: j.space.id, owner: j.token };
}

type UsageBody = { usage: { month: string; events: number; allowance: number; plan: "free" | "paid"; has_billing_account: boolean }; billing: { enabled: boolean } };
const spaceInfo = async (owner: string) => (await (await call("GET", "/v1/space", owner)).json()) as UsageBody;

/** A space with one repo, one agent and an open session. */
async function agentSpace() {
  const s = await signup();
  const name = `r${(ipN++).toString(36)}`;
  await call("POST", "/v1/space/repos", s.owner, { name });
  const repo = `${s.id}-${name}`;
  const t = (await (await call("POST", "/v1/space/tokens", s.owner, { kind: "agent", repo, agent: "a1" })).json()) as { token: string };
  const sess = await wcp<Welcome>("POST", `/v1/repos/${repo}/sessions`, t.token, hello("a1", `I-${s.id}`));
  return { ...s, repo, agent: t.token, session: sess.session, head: sess.head_seq, n: 0 };
}
type AgentSpace = Awaited<ReturnType<typeof agentSpace>>;

const submitBody = (head: number, key: string, mode: "check" | "commit") => ({ type: "submit", mode, event: { kind: "edit", base_seq: head, writes: [{ key, kind: "body" }] } });

/** Submit one event; returns the HTTP response and keeps the space's head current. */
async function submit(a: AgentSpace, mode: "check" | "commit" = "commit") {
  const r = await call("POST", `/v1/repos/${a.repo}/sessions/${a.session}/events`, a.agent, submitBody(a.head, `src/f${a.n++}.ts#x`, mode));
  if (r.status === 200) a.head = ((await r.clone().json()) as { head_seq: number }).head_seq;
  return r;
}

/** The meter is written in the background after the response: wait for the count to land. */
async function untilEvents(owner: string, n: number) {
  for (let i = 0; i < 100; i++) {
    const u = (await spaceInfo(owner)).usage.events;
    if (u === n) return u;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`usage never reached ${n}: ${JSON.stringify((await spaceInfo(owner)).usage)}`);
}

let evN = 0;
const evt = (type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) => ({ id: `evt_${Date.now().toString(36)}${(evN++).toString(36)}`, type, created, data: { object } });
const checkoutDone = (space: string, customer: string) => evt("checkout.session.completed", { mode: "subscription", client_reference_id: space, metadata: { weft_space: space }, customer, payment_status: "paid" });

async function webhook(event: unknown, opts: { secret?: string; nowSec?: number; header?: string | null } = {}) {
  const raw = JSON.stringify(event);
  const sig = opts.header !== undefined ? opts.header : await signStripePayload(raw, opts.secret ?? SECRET, opts.nowSec);
  return SELF.fetch(`${BASE}/v1/billing/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) }, body: raw });
}
const hookResult = async (r: Response) => ((await r.json()) as { result: string }).result;

/** Upgrade a space the way Stripe would tell us, and wait out the 5 s grant cache is not needed: plan is read live. */
async function makePaid(s: { id: string; owner: string }, customer = `cus_${s.id}`) {
  const r = await webhook(checkoutDone(s.id, customer));
  expect(r.status).toBe(200);
  expect(await hookResult(r)).toBe("applied");
  return customer;
}

const stripe = () => fetchMock.get("https://api.stripe.com");
/**
 * The Registry alarm reports EVERY space with unreported overage, so a test that runs it needs a Stripe that accepts
 * any meter event. Registered once (interceptors cannot be removed); it records the identifiers it saw.
 */
const alarmSeen: string[] = [];
let sink = false;
function meterSink() {
  if (sink) return;
  sink = true;
  stripe()
    .intercept({ path: "/v1/billing/meter_events", method: "POST" })
    .reply(200, (o) => (alarmSeen.push(form(String(o.body)).identifier!), { object: "billing.meter_event" }))
    .persist();
}
const form = (b: string) => Object.fromEntries(new URLSearchParams(b));

// ------------------------------------------------------------------ metering and the allowance

describe("metering and the free allowance", () => {
  it("counts events that entered the log; accepting checks, hello and drain are free", async () => {
    const a = await agentSpace();
    expect((await spaceInfo(a.owner)).usage).toMatchObject({ events: 0, allowance: ALLOWANCE, plan: "free", month });
    expect((await submit(a, "check")).status).toBe(200); // accepting check: seq null
    expect((await call("POST", `/v1/repos/${a.repo}/sessions/${a.session}/inbox`, a.agent, { type: "inbox.drain" })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await submit(a)).status).toBe(200);
    await untilEvents(a.owner, 3);
    expect((await spaceInfo(a.owner)).billing.enabled).toBe(true);
  });

  it("a free space over its allowance gets 429 over_allowance with an upgrade line; everything else keeps working", async () => {
    const a = await agentSpace();
    for (let i = 0; i < ALLOWANCE; i++) expect((await submit(a)).status).toBe(200);
    await untilEvents(a.owner, ALLOWANCE);
    const r = await submit(a);
    expect(r.status).toBe(429);
    const body = (await r.json()) as { type: string; error: { code: string; message: string; retryable: boolean; details: { upgrade: string } } };
    expect(body.type).toBe("error");
    expect(body.error.code).toBe("over_allowance");
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toContain("npx @celador/weft upgrade");
    expect(body.error.message).not.toContain("\n");
    expect(body.error.details.upgrade).toBe("npx @celador/weft upgrade");
    // refused events are not counted, and the rest of the protocol is untouched
    expect((await call("POST", `/v1/repos/${a.repo}/sessions/${a.session}/heartbeat`, a.agent, { type: "heartbeat" })).status).toBe(200);
    expect((await call("POST", `/v1/repos/${a.repo}/sessions/${a.session}/inbox`, a.agent, { type: "inbox.drain" })).status).toBe(200);
    expect((await call("GET", `/v1/repos/${a.repo}/events?limit=5`, a.agent)).status).toBe(200);
    const info = await spaceInfo(a.owner);
    expect(info.usage).toMatchObject({ events: ALLOWANCE, plan: "free" });
  });

  it("allowances are per space: one space's overage never touches another", async () => {
    const a = await agentSpace();
    const b = await agentSpace();
    for (let i = 0; i < ALLOWANCE; i++) await submit(a);
    await untilEvents(a.owner, ALLOWANCE);
    expect((await submit(a)).status).toBe(429);
    expect((await submit(b)).status).toBe(200);
    expect((await submit(b)).status).toBe(200);
    await untilEvents(b.owner, 2);
    expect((await spaceInfo(a.owner)).usage.events).toBe(ALLOWANCE);
  });

  it("a paid space is never cut off by the allowance, and its overage is counted", async () => {
    const a = await agentSpace();
    for (let i = 0; i < ALLOWANCE; i++) await submit(a);
    await untilEvents(a.owner, ALLOWANCE);
    expect((await submit(a)).status).toBe(429);
    await makePaid(a);
    expect((await spaceInfo(a.owner)).usage.plan).toBe("paid");
    for (let i = 0; i < 4; i++) expect((await submit(a)).status).toBe(200);
    await untilEvents(a.owner, ALLOWANCE + 4);
  });

  it("an operator can give one space a different allowance, and null restores the default", async () => {
    const a = await agentSpace();
    expect((await call("POST", `/v1/admin/spaces/${a.id}/allowance`, ADMIN, { events: 2 })).status).toBe(200);
    expect((await spaceInfo(a.owner)).usage.allowance).toBe(2);
    for (let i = 0; i < 2; i++) expect((await submit(a)).status).toBe(200);
    await untilEvents(a.owner, 2);
    expect((await submit(a)).status).toBe(429);
    expect((await call("POST", `/v1/admin/spaces/${a.id}/allowance`, ADMIN, { events: null })).status).toBe(200);
    expect((await spaceInfo(a.owner)).usage.allowance).toBe(ALLOWANCE);
    expect((await call("POST", `/v1/admin/spaces/${a.id}/allowance`, ADMIN, { events: -1 })).status).toBe(400);
    expect((await call("POST", `/v1/admin/spaces/spnotreal0000/allowance`, ADMIN, { events: 1 })).status).toBe(404);
    expect((await call("POST", `/v1/admin/spaces/${a.id}/allowance`, a.owner, { events: 99 })).status).toBe(401); // admin only
  });

  it("hosted agents submit over HTTP: the agent WebSocket is not offered while billing is on", async () => {
    const a = await agentSpace();
    const r = await SELF.fetch(`${BASE}/v1/repos/${a.repo}/sessions/${a.session}/ws`, { headers: { upgrade: "websocket", authorization: `Bearer ${a.agent}` } });
    expect(r.status).toBe(403);
  });
});

// ------------------------------------------------------------------ checkout and portal

describe("checkout and portal", () => {
  it("POST /v1/space/billing/checkout creates a subscription Checkout Session for the space and returns its URL", async () => {
    const a = await signup();
    let body = "";
    stripe()
      .intercept({ path: "/v1/checkout/sessions", method: "POST" })
      .reply(200, (o) => ((body = String(o.body)), { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
    const r = await call("POST", "/v1/space/billing/checkout", a.owner, {});
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ type: "billing.checkout", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const f = form(body);
    expect(f.mode).toBe("subscription");
    expect(f.client_reference_id).toBe(a.id);
    expect(f["line_items[0][price]"]).toBe("price_unit");
    expect(f["metadata[weft_space]"]).toBe(a.id);
    expect(f["subscription_data[metadata][weft_space]"]).toBe(a.id);
    expect(f.success_url).toBe(`${BASE}/billing/done`);
    expect(f.cancel_url).toBe(`${BASE}/billing/cancelled`);
    expect(f.customer).toBeUndefined(); // Stripe creates the customer; we store only its id, later
    expect(f["line_items[0][quantity]"]).toBeUndefined(); // metered: no quantity
    expect(f["adaptive_pricing[enabled]"]).toBe("false"); // USD, like the price
    fetchMock.assertNoPendingInterceptors();
  });

  it("only the owner key may start checkout; a paid space is told to use `billing`", async () => {
    const a = await agentSpace();
    expect((await call("POST", "/v1/space/billing/checkout", a.agent, {})).status).toBe(403);
    expect((await call("POST", "/v1/space/billing/checkout", undefined, {})).status).toBe(401);
    expect((await call("POST", "/v1/space/billing/portal", a.agent, {})).status).toBe(403);
    await makePaid(a);
    const r = await call("POST", "/v1/space/billing/checkout", a.owner, {});
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("npx @celador/weft billing");
  });

  it("a Stripe failure is a 503 that leaks neither the key nor Stripe's text", async () => {
    const a = await signup();
    stripe().intercept({ path: "/v1/checkout/sessions", method: "POST" }).reply(500, { error: { message: "internal secret detail sk_test_unit_key" } });
    const r = await call("POST", "/v1/space/billing/checkout", a.owner, {});
    expect(r.status).toBe(503);
    const t = await r.text();
    expect(t).not.toContain("sk_test");
    expect(t).not.toContain("secret detail");
  });

  it("the portal needs a billing account first; with one it returns the Portal URL", async () => {
    const a = await signup();
    const none = await call("POST", "/v1/space/billing/portal", a.owner, {});
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: { message: string } }).error.message).toContain("npx @celador/weft upgrade");
    const cus = await makePaid(a);
    let body = "";
    stripe()
      .intercept({ path: "/v1/billing_portal/sessions", method: "POST" })
      .reply(200, (o) => ((body = String(o.body)), { id: "bps_1", url: "https://billing.stripe.com/p/session/test_1" }));
    const r = await call("POST", "/v1/space/billing/portal", a.owner, {});
    expect(r.status).toBe(201);
    expect(((await r.json()) as { url: string }).url).toBe("https://billing.stripe.com/p/session/test_1");
    expect(form(body)).toMatchObject({ customer: cus, return_url: `${BASE}/billing/done` });
    expect((await spaceInfo(a.owner)).usage.has_billing_account).toBe(true);
  });

  it("serves the two return pages", async () => {
    for (const p of ["/billing/done", "/billing/cancelled"]) {
      const r = await SELF.fetch(`${BASE}${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
  });
});

// ------------------------------------------------------------------ webhook

describe("POST /v1/billing/stripe/webhook", () => {
  it("rejects a missing, forged or stale signature and changes nothing", async () => {
    const a = await signup();
    const e = checkoutDone(a.id, "cus_forged");
    expect((await webhook(e, { header: null })).status).toBe(400);
    expect((await webhook(e, { secret: "whsec_attacker" })).status).toBe(400);
    expect((await webhook(e, { nowSec: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400); // captured an hour ago
    const raw = JSON.stringify(e);
    const sig = await signStripePayload(raw, SECRET);
    const tampered = await SELF.fetch(`${BASE}/v1/billing/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig }, body: raw.replace(a.id, "spzzzzzzzzzz") });
    expect(tampered.status).toBe(400);
    expect((await spaceInfo(a.owner)).usage).toMatchObject({ plan: "free", has_billing_account: false });
  });

  it("checkout.session.completed makes the space paid, once: replaying the event is a no-op", async () => {
    const a = await signup();
    const e = checkoutDone(a.id, "cus_replay");
    const first = await webhook(e);
    expect(first.status).toBe(200);
    expect(await hookResult(first)).toBe("applied");
    expect((await spaceInfo(a.owner)).usage).toMatchObject({ plan: "paid", has_billing_account: true });
    // the plan is moved by hand to prove a replay does not re-apply
    const down = evt("customer.subscription.deleted", { customer: "cus_replay", status: "canceled" });
    expect(await hookResult(await webhook(down))).toBe("applied");
    expect((await spaceInfo(a.owner)).usage.plan).toBe("free");
    expect(await hookResult(await webhook(e))).toBe("duplicate"); // same event id again
    expect(await hookResult(await webhook(down))).toBe("duplicate");
    expect((await spaceInfo(a.owner)).usage.plan).toBe("free");
  });

  it("subscription updates, payment failures and cancellation move the plan; an older event cannot undo a newer one", async () => {
    const a = await signup();
    const cus = await makePaid(a);
    const now = Math.floor(Date.now() / 1000);
    expect(await hookResult(await webhook(evt("invoice.payment_failed", { customer: cus }, now + 10)))).toBe("applied");
    expect((await spaceInfo(a.owner)).usage.plan).toBe("free");
    expect(await hookResult(await webhook(evt("customer.subscription.updated", { customer: cus, status: "active" }, now + 20)))).toBe("applied"); // payment recovered
    expect((await spaceInfo(a.owner)).usage.plan).toBe("paid");
    expect(await hookResult(await webhook(evt("customer.subscription.updated", { customer: cus, status: "past_due" }, now + 30)))).toBe("applied");
    expect((await spaceInfo(a.owner)).usage.plan).toBe("free");
    // arrives late: created before the past_due above, so it must not flip the plan back
    expect(await hookResult(await webhook(evt("customer.subscription.updated", { customer: cus, status: "active" }, now + 15)))).toBe("stale");
    expect((await spaceInfo(a.owner)).usage.plan).toBe("free");
    expect(await hookResult(await webhook(evt("customer.subscription.updated", { customer: cus, status: "trialing" }, now + 40)))).toBe("applied");
    expect(await hookResult(await webhook(evt("customer.subscription.deleted", { customer: cus, status: "canceled" }, now + 50)))).toBe("applied");
    expect((await spaceInfo(a.owner)).usage.plan).toBe("free");
  });

  it("events about other products, unknown customers or unknown spaces change nothing", async () => {
    const a = await signup();
    // somebody else's checkout on the same Stripe account
    const other = evt("checkout.session.completed", { mode: "subscription", client_reference_id: "user_42", metadata: {}, customer: "cus_other", payment_status: "paid" });
    expect(await hookResult(await webhook(other))).toBe("ignored");
    // a customer we never attached to a space
    expect(await hookResult(await webhook(evt("customer.subscription.updated", { customer: "cus_nobody", status: "active" })))).toBe("ignored");
    expect(await hookResult(await webhook(evt("customer.created", { id: "cus_x" })))).toBe("ignored");
    // a well-formed checkout for a space that does not exist: ignored, and its subscription is cancelled so it is not left running
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer: "cus_ghost", status: "all", limit: "100" } }).reply(200, { data: [{ id: "sub_ghost", status: "active" }] });
    stripe().intercept({ path: "/v1/subscriptions/sub_ghost", method: "DELETE", query: { invoice_now: "true", prorate: "false" } }).reply(200, { id: "sub_ghost", status: "canceled" });
    expect(await hookResult(await webhook(checkoutDone("spghost00000", "cus_ghost")))).toBe("ignored");
    fetchMock.assertNoPendingInterceptors();
    expect((await spaceInfo(a.owner)).usage).toMatchObject({ plan: "free", has_billing_account: false });
  });

  it("one space's billing events never touch another space (cross-space isolation)", async () => {
    const a = await signup();
    const b = await signup();
    const cusA = await makePaid(a);
    expect((await spaceInfo(b.owner)).usage).toMatchObject({ plan: "free", has_billing_account: false });
    // A's customer cancels: A goes free, B (its own customer) stays paid
    await makePaid(b);
    expect(await hookResult(await webhook(evt("customer.subscription.deleted", { customer: cusA, status: "canceled" })))).toBe("applied");
    expect((await spaceInfo(a.owner)).usage.plan).toBe("free");
    expect((await spaceInfo(b.owner)).usage.plan).toBe("paid");
    // an event for B's customer lands on B's row only
    expect(await hookResult(await webhook(evt("invoice.payment_failed", { customer: `cus_${b.id}` })))).toBe("applied");
    expect((await spaceInfo(a.owner)).usage.plan).toBe("free");
    expect((await spaceInfo(b.owner)).usage.plan).toBe("free");
  });
});

// ------------------------------------------------------------------ reporting usage to Stripe

const report = (space?: string) => call("POST", "/v1/admin/billing/report", ADMIN, space ? { space } : {});

describe("usage reporting", () => {
  it("sends the overage once per window with a stable identifier, and nothing when nothing is new", async () => {
    const a = await agentSpace();
    const cus = await makePaid(a);
    for (let i = 0; i < ALLOWANCE + 4; i++) await submit(a); // 10 events, allowance 6: overage 4
    await untilEvents(a.owner, ALLOWANCE + 4);
    const sent: Array<Record<string, string>> = [];
    const meterOk = () => stripe().intercept({ path: "/v1/billing/meter_events", method: "POST" }).reply(200, (o) => (sent.push(form(String(o.body))), { object: "billing.meter_event" }));
    meterOk();
    const r1 = (await (await report(a.id)).json()) as { sent: number; events: number; failed: number };
    expect(r1).toMatchObject({ sent: 1, events: 4, failed: 0 });
    expect(sent[0]).toMatchObject({ event_name: "weft_agent_events", identifier: `weft:${a.id}:${month}:0-4`, "payload[stripe_customer_id]": cus, "payload[value]": "4" });
    expect(Number(sent[0]!.timestamp)).toBeGreaterThan(Date.now() / 1000 - 60);
    // nothing new: no call (the mock has no interceptor left, so a call would fail the report)
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 0, failed: 0 });
    // three more events: the next window starts where the last ended
    for (let i = 0; i < 3; i++) await submit(a);
    await untilEvents(a.owner, ALLOWANCE + 7);
    meterOk();
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 1, events: 3 });
    expect(sent[1]).toMatchObject({ identifier: `weft:${a.id}:${month}:4-7`, "payload[value]": "3" });
    fetchMock.assertNoPendingInterceptors();
  });

  it("a failed or lost report is retried as the SAME window, so the retry cannot be billed twice", async () => {
    const a = await agentSpace();
    await makePaid(a);
    for (let i = 0; i < ALLOWANCE + 2; i++) await submit(a);
    await untilEvents(a.owner, ALLOWANCE + 2);
    const sent: Array<Record<string, string>> = [];
    const meter = (status: number) =>
      stripe()
        .intercept({ path: "/v1/billing/meter_events", method: "POST" })
        .reply(status, (o) => (sent.push(form(String(o.body))), status === 200 ? { object: "billing.meter_event" } : { error: { message: "boom" } }));
    meter(500);
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 0, failed: 1 });
    // usage grows while Stripe is down
    for (let i = 0; i < 3; i++) await submit(a);
    await untilEvents(a.owner, ALLOWANCE + 5);
    meter(200);
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 1, events: 2 });
    // the retry carried the original window (0-2), identifier and all; the growth goes in the next one
    expect(sent.map((s) => s.identifier)).toEqual([`weft:${a.id}:${month}:0-2`, `weft:${a.id}:${month}:0-2`]);
    meter(200);
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 1, events: 3 });
    expect(sent[2]).toMatchObject({ identifier: `weft:${a.id}:${month}:2-5`, "payload[value]": "3" });
    fetchMock.assertNoPendingInterceptors();
  });

  it("when Stripe says the identifier already exists (the first answer was lost), the window counts as reported", async () => {
    const a = await agentSpace();
    await makePaid(a);
    for (let i = 0; i < ALLOWANCE + 3; i++) await submit(a);
    await untilEvents(a.owner, ALLOWANCE + 3);
    // what Stripe really answers for a repeated identifier (observed in test mode): 400, not a silent accept
    stripe()
      .intercept({ path: "/v1/billing/meter_events", method: "POST" })
      .reply(400, { error: { type: "invalid_request_error", message: `An event already exists with identifier weft:${a.id}:${month}:0-3.` } });
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 1, events: 3, failed: 0 });
    // and the cursor moved: nothing is pending, so nothing is sent again
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 0, failed: 0 });
    fetchMock.assertNoPendingInterceptors();
  });

  it("a space with no Stripe customer, or with usage inside its allowance, reports nothing", async () => {
    const a = await agentSpace();
    for (let i = 0; i < 3; i++) await submit(a);
    await untilEvents(a.owner, 3);
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 0, failed: 0 });
    await makePaid(a);
    expect(await (await report(a.id)).json()).toMatchObject({ sent: 0, failed: 0 }); // 3 of 6 used: no overage
  });

  it("admin billing endpoints need the admin token", async () => {
    const a = await signup();
    expect((await call("POST", "/v1/admin/billing/report", a.owner, {})).status).toBe(401);
    expect((await call("GET", "/v1/admin/billing", a.owner)).status).toBe(401);
    const r = await call("GET", "/v1/admin/billing", ADMIN);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ type: "billing", enabled: true, month });
  });
});

// ------------------------------------------------------------------ erase

describe("erasing a space cancels its subscription first", () => {
  it("reports what is owed, cancels the subscription, then erases", async () => {
    const a = await agentSpace();
    const cus = await makePaid(a);
    for (let i = 0; i < ALLOWANCE + 2; i++) await submit(a);
    await untilEvents(a.owner, ALLOWANCE + 2);
    const calls: string[] = [];
    stripe().intercept({ path: "/v1/billing/meter_events", method: "POST" }).reply(200, (o) => (calls.push(`meter ${form(String(o.body)).identifier}`), { object: "billing.meter_event" }));
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer: cus, status: "all", limit: "100" } }).reply(200, { data: [{ id: "sub_live", status: "active" }, { id: "sub_old", status: "canceled" }] });
    stripe().intercept({ path: "/v1/subscriptions/sub_live", method: "DELETE", query: { invoice_now: "true", prorate: "false" } }).reply(200, () => (calls.push("cancel sub_live"), { id: "sub_live", status: "canceled" }));
    const r = await call("DELETE", "/v1/space", a.owner);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ type: "space.erased", status: "erased" });
    expect(calls).toEqual([`meter weft:${a.id}:${month}:0-2`, "cancel sub_live"]);
    fetchMock.assertNoPendingInterceptors();
    expect((await call("GET", "/v1/space", a.owner)).status).toBe(401);
    // nothing about the space is left in the billing tables
    const stub = env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
    expect(await runInDurableObject(stub, (i: Registry) => [...(i as any).sql.exec("SELECT space FROM space_billing WHERE space = ?", a.id)].length + [...(i as any).sql.exec("SELECT space FROM usage WHERE space = ?", a.id)].length)).toBe(0);
  });

  it("if Stripe cannot cancel, the space is already unreachable and the erase finishes when Stripe is back", async () => {
    const a = await agentSpace();
    const cus = await makePaid(a);
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer: cus, status: "all", limit: "100" } }).reply(503, { error: { message: "down" } });
    const r = await call("DELETE", "/v1/space", a.owner);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("retried automatically");
    expect((await call("GET", "/v1/space", a.owner)).status).toBe(401); // unreachable at once
    // Stripe recovers; the Registry alarm retries and the erase completes (the alarm also reports every other space's leftover overage)
    meterSink();
    stripe().intercept({ path: "/v1/subscriptions", method: "GET", query: { customer: cus, status: "all", limit: "100" } }).reply(200, { data: [{ id: "sub_x", status: "active" }] });
    stripe().intercept({ path: "/v1/subscriptions/sub_x", method: "DELETE", query: { invoice_now: "true", prorate: "false" } }).reply(200, { id: "sub_x", status: "canceled" });
    const stub = env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
    await runDurableObjectAlarm(stub);
    const status = await runInDurableObject(stub, (i: Registry) => [...(i as any).sql.exec("SELECT status FROM spaces WHERE id = ?", a.id)][0]?.status);
    expect(status).toBe("erased");
  });

  it("a space that never subscribed is erased without any Stripe call", async () => {
    const a = await signup();
    expect((await call("DELETE", "/v1/space", a.owner)).status).toBe(200);
  });
});

// ------------------------------------------------------------------ the hourly alarm (runs last: it reports every space)

describe("the Registry alarm reports usage", () => {
  it("a paid space with overage gets its meter event from the alarm, with no cron trigger", async () => {
    const a = await agentSpace();
    const cus = await makePaid(a);
    for (let i = 0; i < ALLOWANCE + 1; i++) await submit(a);
    await untilEvents(a.owner, ALLOWANCE + 1);
    const stub = env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).not.toBeNull(); // recordUsage armed it for a space with a Stripe customer
    meterSink();
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    expect(alarmSeen).toContain(`weft:${a.id}:${month}:0-1`);
    void cus;
  });
});

