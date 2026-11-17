// Billing for hosted spaces (docs/pricing.md): Weft Pro (per user, monthly or yearly), the free plan's
// allowance gate and the usage meter. Everything here is inert until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_PRO_MONTH and STRIPE_PRICE_PRO_YEAR are all set (stripeConfig): without them the billing routes
// answer 503 and no allowance is enforced. Usage is counted either way.
//
//   POST /v1/account/billing/checkout {interval, seats}   Clerk session (weft.mx/account/): Checkout for the account (accounts.ts)
//   POST /v1/account/billing/checkout {product: "license", term: year|lifetime, seats}   the Commercial License (accounts.ts)
//   POST /v1/account/billing/portal                       Clerk session: the account's Customer Portal
//   POST /v1/space/billing/checkout {interval, seats}  owner key -> Checkout for the space's ACCOUNT (a space with no
//                                     account gets 403 login_required on a gateway with accounts: `weft login` first)
//   POST /v1/space/billing/portal     owner key -> Stripe Customer Portal URL (seats, card, invoices, cancel)
//   POST /v1/billing/stripe/webhook   Stripe -> plan changes (signature verified, idempotent on event id)
//   GET  /billing/done | /billing/cancelled   where Checkout and the Portal send the browser back (CLI-first)
//   POST /v1/admin/billing/report     send unreported legacy-plan overage to Stripe now (also runs hourly)
//   POST /v1/admin/billing/reset-usage {month}        zero a month's counters (go-live)
//   POST /v1/admin/spaces/{id}/allowance {events|null}   override one space's free allowance
//   GET  /v1/admin/billing            plan counts, Pro seats, fair use, accounts
//
// Paying on the web always happens signed in (an account); the anonymous `/buy` + claim code path is gone.

import type { Registry, SpaceGrant, Utm } from "./registry";
import { clerkConfig, type ClerkEnv } from "./clerk";
import { StripeError, cancelCustomerSubscriptions, fetchSubscription, stripeConfig, stripeRequest, subscriptionFacts, verifyStripeSignature, type StripeConfig, type StripeEnv, type SubscriptionFacts } from "./stripe";
import { freeEvents, isInterval, MAX_SEATS, monthKey, parseSeats, type Interval, type Plan } from "./usage";

export interface BillingEnv extends StripeEnv, ClerkEnv {
  WEFT_REGISTRY: DurableObjectNamespace<Registry>;
  WEFT_FREE_EVENTS?: string;
  /** The signed-in account page: Checkout started there returns to `?checkout=done|cancelled` (default https://weft.mx/account/). */
  WEFT_ACCOUNT_URL?: string;
  /** Comma-separated origins whose pages may call the account and login routes from a browser (default weft.mx, www.weft.mx and the site preview). */
  WEFT_SITE_ORIGINS?: string;
}

type ErrCode = "unauthorized" | "forbidden" | "not_found" | "invalid_message" | "unavailable" | "rate_limited";
/** What the billing routes need from the gateway: error mapping, JSON responses, body parsing, per-network throttles. */
export type BillingKit = {
  fail: (code: ErrCode, message: string, details?: Record<string, unknown>) => never;
  json: (body: unknown, status?: number, extra?: Record<string, string>) => Response;
  readJson: (req: Request, optional?: boolean) => Promise<unknown>;
  /** Throttle by the caller's network (and any extra keys, e.g. `space:<id>`) in a named bucket; fails with rate_limited. */
  throttle: (req: Request, bucket: string, extraKeys?: string[]) => Promise<void>;
  /** An error thrown by `fail` as the gateway's error response (anything else is rethrown). */
  respond: (e: unknown) => Response;
};
type Kit = BillingKit;

const SPACE_ID = /^sp[a-z0-9]{10}$/;
export const ACCOUNT_ID = /^user_[A-Za-z0-9]{8,64}$/;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DEFAULT_ACCOUNT_URL = "https://weft.mx/account/";
const DEFAULT_SITE_ORIGINS = "https://weft.mx,https://www.weft.mx,https://weft-site-preview.elier.ai";

function registry(env: BillingEnv) {
  return env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
}

function requireBilling(env: BillingEnv, k: Pick<Kit, "fail">): StripeConfig {
  const cfg = stripeConfig(env);
  if (!cfg) k.fail("unavailable", "billing is not enabled on this gateway (hosted billing is off; self-hosted and local gateways are free)");
  return cfg!;
}

const origin = (env: BillingEnv, req: Request) => env.WEFT_PUBLIC_URL?.trim().replace(/\/+$/, "") || new URL(req.url).origin;
const planOf = (status: string): Plan => (status === "active" || status === "trialing" ? "paid" : "free");

// ------------------------------------------------------------------ allowance gate and meter

type Live = { over: boolean; events: number; allowance: number; exp: number };
const live = new Map<string, Live>();
const LIVE_MS = 10_000;

/**
 * The 429 for a free space that has used its allowance, or undefined to let the submit through.
 * Reads state the isolate already has (the cached grant, refreshed by the meter's last flush): no
 * Durable Object call. Off while billing is not configured. Pro spaces are never refused.
 */
export function overAllowance(env: BillingEnv, g: SpaceGrant, json: Kit["json"]): Response | undefined {
  if (!g.space || !stripeConfig(env)) return undefined;
  const s = live.get(g.space);
  const over = s && s.exp > Date.now() ? s.over : g.over_allowance === true;
  if (!over) return undefined;
  const allowance = s?.allowance ?? freeEvents(env);
  return json(
    {
      type: "error",
      error: {
        code: "over_allowance",
        message: `This space used its ${allowance.toLocaleString("en-US")} free events for ${monthKey()}. Run \`npx @celador/weft upgrade\` for Weft Pro (per user, no event cap) to keep coordinating; until then your agents work uncoordinated.`,
        retryable: false,
        details: { allowance, month: monthKey(), upgrade: "npx @celador/weft upgrade" },
      },
    },
    429,
  );
}

const pending = new Map<string, number>();
let draining = false;

/**
 * Count one agent event for a space. Counts are coalesced per isolate and written to the Registry in the
 * background (`waitUntil`), so a submit never waits on the Registry and a burst is one Registry call.
 */
export function meterEvent(env: BillingEnv, ctx: { waitUntil(p: Promise<unknown>): void }, g: SpaceGrant): void {
  if (!g.space) return;
  pending.set(g.space, (pending.get(g.space) ?? 0) + 1);
  if (draining) return;
  draining = true;
  ctx.waitUntil(drain(env));
}

async function drain(env: BillingEnv): Promise<void> {
  try {
    while (pending.size) {
      const batch = [...pending];
      pending.clear();
      try {
        const states = await registry(env).recordUsage(batch);
        for (const [space, st] of Object.entries(states)) live.set(space, { over: st.over, events: st.events, allowance: st.allowance, exp: Date.now() + LIVE_MS });
        if (live.size > 5000) for (const [s, v] of live) if (v.exp < Date.now()) live.delete(s);
      } catch (e) {
        // Put the counts back; the next submit retries.
        for (const [s, n] of batch) pending.set(s, (pending.get(s) ?? 0) + n);
        console.error("billing: could not record usage", e instanceof Error ? e.message : String(e));
        break;
      }
    }
  } finally {
    draining = false;
  }
}

// ------------------------------------------------------------------ Checkout for Pro

type CheckoutSession = { id: string; url: string | null };

/** The Pro line item: per seat, the buyer can change the number of seats on the Checkout page. */
const proLine = (cfg: StripeConfig, interval: Interval, seats: number) => ({
  price: cfg.prices[interval],
  quantity: seats,
  adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_SEATS },
});

/** `{interval, seats}` from a request body: interval month|year (default month), seats 1..MAX_SEATS (default 1). */
function proChoice(body: unknown, k: Pick<Kit, "fail">): { interval: Interval; seats: number } {
  const b = (body ?? {}) as { interval?: unknown; seats?: unknown };
  const interval = b.interval === undefined ? "month" : b.interval;
  if (!isInterval(interval)) k.fail("invalid_message", "interval must be month or year", { issues: [{ path: "/interval", message: "month|year" }] });
  const seats = b.seats === undefined ? 1 : parseSeats(b.seats);
  if (seats === undefined) k.fail("invalid_message", `seats must be a whole number from 1 to ${MAX_SEATS}`, { issues: [{ path: "/seats", message: `1..${MAX_SEATS}` }] });
  return { interval: interval as Interval, seats: seats! };
}

/** A Weft Pro Checkout Session for an account (client_reference_id = the Clerk user id), returning to `success`/`cancel`. */
export async function accountCheckout(cfg: StripeConfig, account: string, customer: string | null, choice: { interval: Interval; seats: number }, back: { success: string; cancel: string }, utm: Utm = {}): Promise<string> {
  const meta: Record<string, string> = { weft_account: account, weft_plan: "pro", ...(utm.source ? { utm_source: utm.source } : {}), ...(utm.campaign ? { utm_campaign: utm.campaign } : {}) };
  const s = await stripeRequest<CheckoutSession>(cfg.key, "POST", "/v1/checkout/sessions", {
    mode: "subscription",
    line_items: [proLine(cfg, choice.interval, choice.seats)],
    client_reference_id: account,
    metadata: meta,
    subscription_data: { metadata: { weft_account: account, weft_plan: "pro" } },
    allow_promotion_codes: true,
    // Bill in USD like the price (Adaptive Pricing would show and charge a converted amount).
    adaptive_pricing: { enabled: false },
    success_url: back.success,
    cancel_url: back.cancel,
    ...(customer ? { customer } : {}),
  });
  if (!s.url) throw new StripeError(502, "no_url", "Stripe returned no Checkout URL");
  return s.url;
}

export type LicenseChoice = { term: "year" | "lifetime"; seats: number };

/** `{term, seats}` for the Commercial License: term year|lifetime (default year), seats 1..MAX_SEATS (default 1). */
export function licenseChoice(body: unknown, k: Pick<Kit, "fail">): LicenseChoice {
  const b = (body ?? {}) as { term?: unknown; seats?: unknown };
  const term = b.term === undefined ? "year" : b.term;
  if (term !== "year" && term !== "lifetime") k.fail("invalid_message", "term must be year or lifetime", { issues: [{ path: "/term", message: "year|lifetime" }] });
  const seats = b.seats === undefined ? 1 : parseSeats(b.seats);
  if (seats === undefined) k.fail("invalid_message", `seats must be a whole number from 1 to ${MAX_SEATS}`, { issues: [{ path: "/seats", message: `1..${MAX_SEATS}` }] });
  return { term: term as LicenseChoice["term"], seats: seats! };
}

/**
 * A Commercial License Checkout Session for an account: yearly = a per-seat subscription, lifetime = a one-time
 * payment per seat. The buyer can change the number of seats on the Checkout page. Metadata `weft_product=license`
 * and the account id (also the client_reference_id) are how the webhook knows it.
 */
export async function licenseCheckout(cfg: StripeConfig, account: string, customer: string | null, choice: LicenseChoice, back: { success: string; cancel: string }, utm: Utm = {}): Promise<string> {
  const lic = cfg.license!;
  const tag = { weft_account: account, weft_product: "license", weft_term: choice.term };
  const meta: Record<string, string> = { ...tag, ...(utm.source ? { utm_source: utm.source } : {}), ...(utm.campaign ? { utm_campaign: utm.campaign } : {}) };
  const line = { price: choice.term === "year" ? lic.year : lic.lifetime, quantity: choice.seats, adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_SEATS } };
  const s = await stripeRequest<CheckoutSession>(cfg.key, "POST", "/v1/checkout/sessions", {
    mode: choice.term === "year" ? "subscription" : "payment",
    line_items: [line],
    client_reference_id: account,
    metadata: meta,
    ...(choice.term === "year"
      ? { subscription_data: { metadata: tag } }
      : { payment_intent_data: { metadata: tag }, invoice_creation: { enabled: true, invoice_data: { metadata: tag } }, ...(customer ? {} : { customer_creation: "always" }) }),
    allow_promotion_codes: true,
    adaptive_pricing: { enabled: false },
    success_url: back.success,
    cancel_url: back.cancel,
    ...(customer ? { customer } : {}),
  });
  if (!s.url) throw new StripeError(502, "no_url", "Stripe returned no Checkout URL");
  return s.url;
}

export async function portalUrl(cfg: StripeConfig, customer: string, returnUrl: string): Promise<string> {
  const s = await stripeRequest<{ url: string }>(cfg.key, "POST", "/v1/billing_portal/sessions", { customer, return_url: returnUrl, ...(cfg.portalConfig ? { configuration: cfg.portalConfig } : {}) });
  return s.url;
}

export const accountUrl = (env: BillingEnv) => env.WEFT_ACCOUNT_URL?.trim() || DEFAULT_ACCOUNT_URL;
export { proChoice, requireBilling };

/**
 * `POST /v1/space/billing/checkout` and `/portal`, after the space owner key has been verified. A space on an account
 * buys and manages the ACCOUNT's plan. On a gateway with accounts (Clerk configured), a space with no account is sent
 * through `weft login` first (403, details.reason login_required). Without accounts (a self-hosted gateway that sells
 * nothing has billing off anyway) the space itself is the customer, as before accounts existed.
 */
export async function spaceBilling(req: Request, env: BillingEnv, k: Omit<Kit, "respond">, space: string, action: "checkout" | "portal"): Promise<Response> {
  const cfg = requireBilling(env, k);
  const reg = registry(env);
  const st = await reg.spaceUsage(space);
  if (!st) k.fail("unauthorized", "space not found");
  const account = await reg.spaceAccount(space);
  const base = origin(env, req);
  const back = { success: `${base}/billing/done`, cancel: `${base}/billing/cancelled` };
  try {
    if (action === "checkout") {
      const choice = proChoice(await k.readJson(req, true), k);
      if (st!.plan === "paid") k.fail("invalid_message", "this space is already on a paid plan; change seats or cancel with `npx @celador/weft billing`", { issues: [{ path: "", message: "already paid" }] });
      if (account) {
        const a = await reg.accountCustomer(account);
        const url = await accountCheckout(cfg, account, a.customer, choice, back);
        return k.json({ type: "billing.checkout", url, interval: choice.interval, seats: choice.seats, account: true }, 201);
      }
      if (clerkConfig(env)) k.fail("forbidden", "Weft Pro is bought by an account: run `npx @celador/weft login` (it keeps this space), then `npx @celador/weft upgrade` again", { reason: "login_required", login: "npx @celador/weft login" });
      const customer = (await reg.stripeCustomer(space)) ?? undefined;
      const s = await stripeRequest<CheckoutSession>(cfg.key, "POST", "/v1/checkout/sessions", {
        mode: "subscription",
        line_items: [proLine(cfg, choice.interval, choice.seats)],
        client_reference_id: space,
        metadata: { weft_space: space, weft_plan: "pro" },
        subscription_data: { metadata: { weft_space: space, weft_plan: "pro" } },
        allow_promotion_codes: true,
        adaptive_pricing: { enabled: false },
        success_url: back.success,
        cancel_url: back.cancel,
        ...(customer ? { customer } : {}),
      });
      if (!s.url) throw new StripeError(502, "no_url", "Stripe returned no Checkout URL");
      return k.json({ type: "billing.checkout", url: s.url, interval: choice.interval, seats: choice.seats }, 201);
    }
    const customer = account ? (await reg.accountCustomer(account)).customer : await reg.stripeCustomer(space);
    if (!customer) k.fail("invalid_message", "this space has no billing account yet; run `npx @celador/weft upgrade` first", { issues: [{ path: "", message: "no billing account" }] });
    return k.json({ type: "billing.portal", url: await portalUrl(cfg, customer!, back.success) }, 201);
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    console.error("billing: stripe", action, e.status, e.code ?? "", e.message);
    return k.fail("unavailable", `Stripe could not start ${action === "checkout" ? "checkout" : "the billing portal"}; try again in a minute`);
  }
}

export const clean = (v: string) => v.replace(/[^\w.~ -]/g, "").slice(0, 100);

export function corsHeaders(env: BillingEnv, req: Request): Record<string, string> {
  const o = req.headers.get("origin");
  if (!o) return {};
  const allowed = (env.WEFT_SITE_ORIGINS ?? DEFAULT_SITE_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(o)) return {};
  return { "access-control-allow-origin": o, vary: "Origin", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" };
}

export function withHeaders(r: Response, h: Record<string, string>): Response {
  if (!Object.keys(h).length) return r;
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(h)) headers.set(k, v);
  return new Response(r.body, { status: r.status, headers });
}

const idOf = (v: unknown): string | undefined => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : undefined);

// ------------------------------------------------------------------ webhook

type StripeEvent = { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
export type Intent = {
  space?: string;
  /** A checkout an account started (weft.mx/account/, or `weft upgrade` in a space on an account): the Clerk user id. */
  account?: string;
  customer?: string;
  plan: Plan;
  checkout: boolean;
  /** The subscription a checkout created (its seats and status are read from Stripe). */
  subscription?: string;
  /** What a customer.subscription.* event says the subscription is now. */
  facts?: SubscriptionFacts;
  /** A Commercial License purchase (never touches the Pro plan): a one-time Checkout (`session`) or a yearly subscription. */
  license?: { term: "year" | "lifetime"; session?: string; subscription?: string; deleted?: boolean };
};

/**
 * What a Stripe event means for a space's plan, or null when it is none of our business. The same Stripe
 * account may send events for other products to this endpoint; a checkout session counts only if it is a
 * subscription we created (our account or space id as client_reference_id AND in metadata), the rest only
 * through a customer we attached to an account or a space.
 */
const isLicenseMeta = (m: unknown) => Boolean(m && typeof m === "object" && (m as Record<string, unknown>).weft_product === "license");

/** Whether an invoice belongs to a Commercial License subscription (by its subscription's metadata or its line's price). */
function licenseInvoice(o: Record<string, unknown>, license?: { year: string; lifetime: string }): boolean {
  const parent = (o.parent ?? {}) as { subscription_details?: { metadata?: unknown } };
  if (isLicenseMeta(parent.subscription_details?.metadata) || isLicenseMeta((o.subscription_details as { metadata?: unknown } | undefined)?.metadata)) return true;
  const lines = ((o.lines as { data?: unknown[] } | undefined)?.data ?? []) as Array<{ price?: { id?: unknown }; pricing?: { price_details?: { price?: unknown } } }>;
  return Boolean(license && lines.some((l) => [l.price?.id, l.pricing?.price_details?.price].some((p) => p === license.year || p === license.lifetime)));
}

export function intentOf(ev: StripeEvent, prices?: { month: string; year: string }, license?: { year: string; lifetime: string }): Intent | null {
  const o = ev.data?.object;
  if (!o || typeof o !== "object") return null;
  const customer = idOf(o.customer);
  switch (ev.type) {
    case "checkout.session.completed": {
      const ref = typeof o.client_reference_id === "string" ? o.client_reference_id : undefined;
      const meta = (o.metadata ?? {}) as Record<string, unknown>;
      // The Commercial License (accounts only): a one-time payment, or a yearly subscription.
      if (isLicenseMeta(meta)) {
        if (!ref || !ACCOUNT_ID.test(ref) || meta.weft_account !== ref || !customer || typeof o.id !== "string") return null;
        if (o.mode === "payment") return o.payment_status === "paid" ? { account: ref, customer, plan: "paid", checkout: true, license: { term: "lifetime", session: o.id } } : null;
        if (o.mode !== "subscription") return null;
        if (o.payment_status === "unpaid" && Number(o.amount_total ?? 0) > 0) return null;
        const subscription = idOf(o.subscription);
        return subscription ? { account: ref, customer, plan: "paid", checkout: true, license: { term: "year", subscription } } : null;
      }
      if (o.mode !== "subscription" || !ref || !customer) return null;
      const account = ACCOUNT_ID.test(ref) && meta.weft_account === ref ? ref : undefined;
      const space = SPACE_ID.test(ref) && meta.weft_space === ref ? ref : undefined;
      if (!account && !space) return null;
      // A $0 first invoice (a metered subscription, a 100% coupon) may leave the session `unpaid` (seen in test mode): the card
      // was collected and the subscription exists. Only a session that still owes money (a delayed payment method) waits;
      // customer.subscription.updated says when that subscription turns active.
      if (o.payment_status === "unpaid" && Number(o.amount_total ?? 0) > 0) return null;
      const subscription = idOf(o.subscription);
      return { ...(account ? { account } : { space: space! }), customer, plan: "paid", checkout: true, ...(subscription ? { subscription } : {}) };
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (!customer) return null;
      const facts = subscriptionFacts(o, prices, license);
      // A yearly Commercial License: its own purchase row, never the account's Pro plan.
      if (facts && ((license && facts.priceId === license.year) || isLicenseMeta(o.metadata)))
        return { customer, plan: "paid", checkout: false, facts, license: { term: "year", subscription: facts.id, ...(ev.type === "customer.subscription.deleted" ? { deleted: true } : {}) } };
      const plan = ev.type === "customer.subscription.deleted" ? "free" : o.status === "active" || o.status === "trialing" ? "paid" : "free";
      return { customer, plan, checkout: false, ...(facts?.pro ? { facts } : {}) };
    }
    case "invoice.payment_failed":
      // A failed license renewal is handled by its subscription's own update (past_due); it never ends Pro.
      if (licenseInvoice(o, license)) return null;
      return customer ? { customer, plan: "free", checkout: false } : null;
    default:
      return null;
  }
}

export async function stripeWebhook(req: Request, env: BillingEnv, k: Kit): Promise<Response> {
  const cfg = requireBilling(env, k);
  const len = Number(req.headers.get("content-length") ?? "0");
  const tooLarge = () => k.json({ type: "error", error: { code: "payload_too_large", message: "webhook body too large", retryable: false } }, 413);
  if (len > MAX_WEBHOOK_BYTES) return tooLarge();
  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return tooLarge();
  const sig = await verifyStripeSignature(raw, req.headers.get("stripe-signature"), cfg.webhookSecret);
  if (!sig.ok) return k.json({ type: "error", error: { code: "invalid_message", message: `webhook signature rejected (${sig.reason})`, retryable: false } }, 400);
  let ev: StripeEvent;
  try {
    ev = JSON.parse(raw) as StripeEvent;
  } catch {
    return k.fail("invalid_message", "body is not JSON");
  }
  if (typeof ev.id !== "string" || typeof ev.created !== "number") return k.fail("invalid_message", "not a Stripe event");
  const intent = intentOf(ev, cfg.prices, cfg.license);
  if (!intent) return k.json({ received: true, result: "ignored" });
  if (intent.license) return licenseWebhook(env, ev as StripeEvent & { id: string; created: number }, intent, cfg, k);

  // A checkout's seats, interval and status live on the subscription it created: read it (a failure is a 503, and Stripe retries).
  let plan = intent.plan;
  let facts = intent.facts;
  const reg = registry(env);
  if (intent.checkout && intent.subscription) {
    // A replay of an event already applied needs no Stripe read.
    if (await reg.billingEventSeen(ev.id)) return k.json({ received: true, result: "duplicate" });
    try {
      const f = await fetchSubscription(cfg, intent.subscription);
      if (f) {
        facts = f;
        plan = planOf(f.status);
      }
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      console.error("billing: could not read the subscription of a checkout", e.status, e.code ?? "", e.message);
      return k.fail("unavailable", "could not read the subscription from Stripe; Stripe will retry");
    }
  }
  const pro = facts?.pro && facts.seats && facts.interval ? { seats: facts.seats, interval: facts.interval, ...(facts.periodEnd ? { periodEnd: facts.periodEnd } : {}) } : undefined;

  const r = await reg.applyBillingEvent({
    id: ev.id,
    created: ev.created,
    plan,
    ...(intent.space ? { space: intent.space } : {}),
    ...(intent.account ? { account: intent.account } : {}),
    ...(intent.customer ? { customer: intent.customer } : {}),
    ...(pro ? { pro } : {}),
  });
  if (r.space) live.delete(r.space);
  for (const sp of r.spaces ?? []) live.delete(sp);
  // A checkout finished for a space or account that is gone: do not leave its subscription running.
  if (r.result === "ignored" && intent.checkout && intent.customer) {
    try {
      await cancelCustomerSubscriptions(cfg, intent.customer);
    } catch (e) {
      console.error("billing: could not cancel a subscription for a missing space", e instanceof Error ? e.message : String(e));
      return k.fail("unavailable", "could not cancel the orphaned subscription; Stripe will retry");
    }
  }
  return k.json({ received: true, result: r.result });
}

/**
 * The license state a subscription's facts mean: active (or cancelling) until the end of the paid period; a renewal
 * that failed is paid only up to the start of the unpaid period; a cancelled one keeps what was paid for.
 */
export function licenseFromFacts(f: SubscriptionFacts, deleted = false): { status: "active" | "canceling" | "past_due" | "canceled"; validUntil: number | null } {
  if (deleted || f.status === "canceled" || f.status === "incomplete_expired") return { status: "canceled", validUntil: f.endedAt ?? f.periodEnd ?? null };
  if (f.status === "active" || f.status === "trialing") return { status: f.cancelAtPeriodEnd ? "canceling" : "active", validUntil: f.periodEnd ?? null };
  return { status: "past_due", validUntil: f.periodStart ?? Math.floor(Date.now() / 1000) };
}

/** Webhook, Commercial License part: record the purchase on the account (a Stripe read for a finished checkout). */
async function licenseWebhook(env: BillingEnv, ev: StripeEvent & { id: string; created: number }, intent: Intent, cfg: StripeConfig, k: Kit): Promise<Response> {
  const lic = intent.license!;
  if (!cfg.license) return k.json({ received: true, result: "ignored" });
  const reg = registry(env);
  if (intent.checkout && (await reg.billingEventSeen(ev.id))) return k.json({ received: true, result: "duplicate" });
  let row: Parameters<Registry["applyLicenseEvent"]>[0] | undefined;
  try {
    if (lic.term === "lifetime" && lic.session) {
      // Seats are the quantity the buyer settled on in Checkout: read from Stripe, only for our one-time price.
      const items = await stripeRequest<{ data?: Array<{ quantity?: number; price?: { id?: string } }> }>(cfg.key, "GET", `/v1/checkout/sessions/${encodeURIComponent(lic.session)}/line_items`, { limit: 10 });
      const item = (items.data ?? []).find((i) => i.price?.id === cfg.license!.lifetime);
      if (!item || !Number.isInteger(item.quantity) || item.quantity! < 1) return k.json({ received: true, result: "ignored" });
      row = { id: ev.id, created: ev.created, ref: lic.session, term: "lifetime", seats: item.quantity!, status: "active", validUntil: null };
    } else {
      const facts = intent.checkout && lic.subscription ? await fetchSubscription(cfg, lic.subscription) : intent.facts;
      if (!facts || facts.priceId !== cfg.license.year || !facts.quantity) return k.json({ received: true, result: "ignored" });
      row = { id: ev.id, created: ev.created, ref: facts.id, term: "year", seats: facts.quantity, ...licenseFromFacts(facts, lic.deleted) };
    }
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    console.error("billing: could not read a license purchase", e.status, e.code ?? "", e.message);
    return k.fail("unavailable", "could not read the purchase from Stripe; Stripe will retry");
  }
  const r = await reg.applyLicenseEvent({ ...row, ...(intent.account ? { account: intent.account } : {}), ...(intent.customer ? { customer: intent.customer } : {}) });
  // A yearly license bought for an account that is gone: do not leave it renewing.
  if (r.result === "ignored" && intent.checkout && lic.term === "year" && lic.subscription) {
    try {
      await stripeRequest(cfg.key, "DELETE", `/v1/subscriptions/${encodeURIComponent(lic.subscription)}`, {});
    } catch (e) {
      console.error("billing: could not cancel a license for a missing account", e instanceof Error ? e.message : String(e));
      return k.fail("unavailable", "could not cancel the orphaned subscription; Stripe will retry");
    }
  }
  return k.json({ received: true, result: r.result });
}

// ------------------------------------------------------------------ pages

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style><h1>${title}</h1><p>${body}</p>`,
    { status, headers: PAGE_HEADERS },
  );
}

/** Routes that are not under /v1/space: the webhook and the two return pages. Null for any other path. */
export async function billingRoute(req: Request, env: BillingEnv, k: Kit, path: string): Promise<Response | null> {
  const m = req.method;
  if (path === "/v1/billing/stripe/webhook" && m === "POST") return stripeWebhook(req, env, k);
  if (path === "/billing/done" && m === "GET") return page("Done", "Return to your terminal and run <code>npx @celador/weft usage</code>. The plan can take a few seconds to update.");
  if (path === "/billing/cancelled" && m === "GET") return page("Nothing changed", "You can close this tab. Run <code>npx @celador/weft upgrade</code> again whenever you like.");
  return null;
}

// ------------------------------------------------------------------ operator

export async function billingAdmin(req: Request, env: BillingEnv, k: Kit, path: string): Promise<Response | null> {
  const reg = registry(env);
  const m = req.method;
  if (path === "/v1/admin/billing" && m === "GET") return k.json({ type: "billing", enabled: stripeConfig(env) !== null, ...(await reg.billingSummary()) });
  if (path === "/v1/admin/billing/report" && m === "POST") {
    requireBilling(env, k);
    const body = ((await k.readJson(req, true)) ?? {}) as { space?: unknown };
    return k.json({ type: "billing.report", ...(await reg.reportUsage(typeof body.space === "string" ? body.space : undefined)) });
  }
  if (path === "/v1/admin/billing/reset-usage" && m === "POST") {
    const body = (await k.readJson(req)) as { month?: unknown };
    if (typeof body?.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)) k.fail("invalid_message", "month must be YYYY-MM", { issues: [{ path: "/month", message: "YYYY-MM" }] });
    return k.json({ type: "billing.reset", month: body.month, counters: await reg.resetUsage(body.month as string) });
  }
  const am = /^\/v1\/admin\/spaces\/([^/]+)\/allowance$/.exec(path);
  if (am && m === "POST") {
    const body = (await k.readJson(req)) as { events?: unknown };
    const ev = body?.events;
    if (ev !== null && !(typeof ev === "number" && Number.isInteger(ev) && ev >= 0 && ev <= 1e9)) k.fail("invalid_message", "events must be a non-negative integer or null", { issues: [{ path: "/events", message: "integer|null" }] });
    const space = decodeURIComponent(am[1]!);
    if (!(await reg.setAllowance(space, ev as number | null))) k.fail("not_found", "no such active space");
    live.delete(space);
    return k.json({ type: "billing.allowance", space, events: ev });
  }
  return null;
}
