// Stripe helpers: webhook signature verification (constant-time compare, timestamp tolerance, rotation),
// form encoding, and which events change a plan (intentOf).

import { describe, expect, it } from "vitest";
import { intentOf } from "../../src/billing";
import { formEncode, signStripePayload, stripeConfig, verifyStripeSignature } from "../../src/stripe";

const SECRET = "whsec_unit_secret";
const BODY = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", created: 1_800_000_000, data: { object: { customer: "cus_1", status: "active" } } });
const NOW = 1_800_000_100;

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed body", async () => {
    const h = await signStripePayload(BODY, SECRET, NOW);
    expect(await verifyStripeSignature(BODY, h, SECRET, { nowSec: NOW })).toEqual({ ok: true, timestamp: NOW });
  });

  it("rejects a different secret, a changed body and a changed timestamp", async () => {
    const h = await signStripePayload(BODY, SECRET, NOW);
    expect(await verifyStripeSignature(BODY, h, "whsec_other", { nowSec: NOW })).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifyStripeSignature(BODY + " ", h, SECRET, { nowSec: NOW })).toEqual({ ok: false, reason: "mismatch" });
    const forged = h.replace(`t=${NOW}`, `t=${NOW + 1}`);
    expect(await verifyStripeSignature(BODY, forged, SECRET, { nowSec: NOW })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("enforces the timestamp tolerance both ways (default 5 minutes)", async () => {
    const h = await signStripePayload(BODY, SECRET, NOW);
    expect((await verifyStripeSignature(BODY, h, SECRET, { nowSec: NOW + 299 })).ok).toBe(true);
    expect(await verifyStripeSignature(BODY, h, SECRET, { nowSec: NOW + 301 })).toEqual({ ok: false, reason: "timestamp" }); // replay of an old capture
    expect(await verifyStripeSignature(BODY, h, SECRET, { nowSec: NOW - 301 })).toEqual({ ok: false, reason: "timestamp" }); // from the future
    expect((await verifyStripeSignature(BODY, h, SECRET, { nowSec: NOW + 1000, toleranceSec: 2000 })).ok).toBe(true);
  });

  it("rejects missing and malformed headers without throwing", async () => {
    const good = await signStripePayload(BODY, SECRET, NOW);
    const v1 = good.split("v1=")[1]!;
    for (const h of [null, undefined, ""]) expect(await verifyStripeSignature(BODY, h, SECRET, { nowSec: NOW })).toEqual({ ok: false, reason: "missing" });
    for (const h of ["garbage", `t=abc,v1=${v1}`, `v1=${v1}`, `t=${NOW}`, `t=${NOW},v1=zz`, `t=${NOW},v1=${v1.slice(0, 62)}`, `t=${NOW},v0=${v1}`]) {
      expect(await verifyStripeSignature(BODY, h, SECRET, { nowSec: NOW }), h).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("accepts any one valid v1 among several (secret rotation) and ignores the junk ones", async () => {
    const good = await signStripePayload(BODY, SECRET, NOW);
    const v1 = good.split("v1=")[1]!;
    const other = (await signStripePayload(BODY, "whsec_old", NOW)).split("v1=")[1]!;
    expect((await verifyStripeSignature(BODY, `t=${NOW},v1=${other},v1=${v1}`, SECRET, { nowSec: NOW })).ok).toBe(true);
    expect((await verifyStripeSignature(BODY, `t=${NOW},v1=${v1},v1=${other}`, SECRET, { nowSec: NOW })).ok).toBe(true);
    expect((await verifyStripeSignature(BODY, `t=${NOW},v1=${other},v0=${v1}`, SECRET, { nowSec: NOW })).ok).toBe(false);
    expect((await verifyStripeSignature(BODY, `t=${NOW},v1=${other},v1=${"0".repeat(64)}`, SECRET, { nowSec: NOW })).ok).toBe(false);
  });
});

describe("formEncode", () => {
  it("uses Stripe's bracket notation for nested objects and arrays and drops undefined", () => {
    const s = formEncode({ mode: "subscription", line_items: [{ price: "price_1" }], subscription_data: { metadata: { weft_space: "spabc" } }, skipped: undefined, n: 3 });
    expect(decodeURIComponent(s).split("&")).toEqual(["mode=subscription", "line_items[0][price]=price_1", "subscription_data[metadata][weft_space]=spabc", "n=3"]);
  });
});

describe("stripeConfig", () => {
  const full = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_ID: "price_x" };
  it("is null unless all three secrets are present and shaped right", () => {
    expect(stripeConfig({})).toBeNull();
    expect(stripeConfig(full)).toMatchObject({ key: "sk_test_x", price: "price_x", meterEvent: "weft_agent_events" });
    expect(stripeConfig({ ...full, STRIPE_SECRET_KEY: "" })).toBeNull();
    expect(stripeConfig({ ...full, STRIPE_WEBHOOK_SECRET: undefined })).toBeNull();
    expect(stripeConfig({ ...full, STRIPE_PRICE_ID: "prod_x" })).toBeNull();
    expect(stripeConfig({ ...full, STRIPE_SECRET_KEY: "pk_test_x" })).toBeNull();
    expect(stripeConfig({ ...full, STRIPE_SECRET_KEY: "rk_live_x" })).not.toBeNull();
  });
});

describe("intentOf: which Stripe events change a plan", () => {
  const checkout = (o: Record<string, unknown>) => ({ id: "evt", type: "checkout.session.completed", created: 1, data: { object: { mode: "subscription", client_reference_id: "spabcdefghij", metadata: { weft_space: "spabcdefghij" }, customer: "cus_1", payment_status: "paid", ...o } } });

  it("a completed subscription checkout we created makes the space paid", () => {
    expect(intentOf(checkout({}))).toEqual({ space: "spabcdefghij", customer: "cus_1", plan: "paid", checkout: true });
    expect(intentOf(checkout({ payment_status: "no_payment_required" }))?.plan).toBe("paid");
    expect(intentOf(checkout({ customer: { id: "cus_2" } }))?.customer).toBe("cus_2");
  });

  it("ignores checkouts that are not ours or not paid (the same Stripe account serves other products)", () => {
    expect(intentOf(checkout({ metadata: {} }))).toBeNull();
    expect(intentOf(checkout({ metadata: { weft_space: "spzzzzzzzzzz" } }))).toBeNull(); // metadata disagrees with client_reference_id
    expect(intentOf(checkout({ client_reference_id: "user_123", metadata: { weft_space: "user_123" } }))).toBeNull(); // not a space id
    expect(intentOf(checkout({ client_reference_id: undefined }))).toBeNull();
    expect(intentOf(checkout({ mode: "payment" }))).toBeNull();
    expect(intentOf(checkout({ payment_status: "unpaid" }))).toBeNull();
    expect(intentOf(checkout({ customer: null }))).toBeNull();
  });

  it("maps subscription status and failures to a plan, by customer", () => {
    const sub = (type: string, status?: string) => ({ id: "e", type, created: 1, data: { object: { customer: "cus_1", ...(status ? { status } : {}) } } });
    expect(intentOf(sub("customer.subscription.updated", "active"))?.plan).toBe("paid");
    expect(intentOf(sub("customer.subscription.updated", "trialing"))?.plan).toBe("paid");
    for (const s of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]) expect(intentOf(sub("customer.subscription.updated", s))?.plan, s).toBe("free");
    expect(intentOf(sub("customer.subscription.deleted", "canceled"))?.plan).toBe("free");
    expect(intentOf(sub("invoice.payment_failed"))?.plan).toBe("free");
    expect(intentOf(sub("customer.created"))).toBeNull();
    expect(intentOf({ id: "e", type: "invoice.payment_failed", created: 1, data: { object: {} } })).toBeNull();
    expect(intentOf({ id: "e", type: "invoice.payment_failed", created: 1 })).toBeNull();
  });
});
