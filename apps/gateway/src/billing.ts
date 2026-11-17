// Billing for hosted spaces (docs/pricing.md): Weft Pro (per user, monthly or yearly), the free plan's
// allowance gate and the usage meter. Everything here is inert until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_PRO_MONTH and STRIPE_PRICE_PRO_YEAR are all set (stripeConfig): without them the billing routes
// answer 503 and no allowance is enforced. Usage is counted either way.
//
//   POST /v1/space/billing/checkout {interval, seats}  owner key -> Stripe Checkout URL (Pro, per seat)
//   POST /v1/space/billing/portal     owner key -> Stripe Customer Portal URL (seats, card, invoices, cancel)
//   POST /v1/space/billing/claim {code}   owner key: bind a web purchase (claim code) to this space
//   GET  /buy?interval=month|year&seats=N[&utm_*]   no auth: 303 to Stripe Checkout for Pro, before any space exists
//   POST /v1/billing/claim {session_id}   no auth (the welcome page): a one-time claim code for that purchase
//   POST /v1/billing/stripe/webhook   Stripe -> plan changes (signature verified, idempotent on event id)
//   GET  /billing/done | /billing/cancelled   where Checkout and the Portal send the browser back (CLI-first)
//   POST /v1/admin/billing/report     send unreported legacy-plan overage to Stripe now (also runs hourly)
//   POST /v1/admin/billing/reset-usage {month}        zero a month's counters (go-live)
//   POST /v1/admin/spaces/{id}/allowance {events|null}   override one space's free allowance
//   GET  /v1/admin/billing            plan counts, Pro seats, fair use, unclaimed purchases

import type { Registry, SpaceGrant, Utm } from "./registry";
import { StripeError, cancelCustomerSubscriptions, fetchSubscription, stripeConfig, stripeRequest, subscriptionFacts, verifyStripeSignature, type StripeConfig, type StripeEnv, type SubscriptionFacts } from "./stripe";
import { freeEvents, isInterval, MAX_SEATS, monthKey, parseSeats, type Interval, type Plan } from "./usage";

export interface BillingEnv extends StripeEnv {
  WEFT_REGISTRY: DurableObjectNamespace<Registry>;
  WEFT_FREE_EVENTS?: string;
  /** Where Stripe sends a web buyer after paying; `?session_id={CHECKOUT_SESSION_ID}` is appended (default https://weft.mx/welcome/). */
  WEFT_WELCOME_URL?: string;
  /** Where Stripe sends a web buyer who backs out (default https://weft.mx/pricing/). */
  WEFT_PRICING_URL?: string;
  /** Comma-separated origins whose pages may call POST /v1/billing/claim from a browser (default https://weft.mx,https://www.weft.mx). */
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
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,250}$/;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DEFAULT_WELCOME = "https://weft.mx/welcome/";
const DEFAULT_PRICING = "https://weft.mx/pricing/";
const DEFAULT_SITE_ORIGINS = "https://weft.mx,https://www.weft.mx";
/** Marketing parameters /buy passes into the Checkout Session's metadata (Stripe keeps them, the gateway does not). */
const PASSTHROUGH = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"] as const;

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

/** `POST /v1/space/billing/checkout`, `/portal` and `/claim`, after the space owner key has been verified. */
export async function spaceBilling(req: Request, env: BillingEnv, k: Omit<Kit, "respond">, space: string, action: "checkout" | "portal" | "claim"): Promise<Response> {
  const cfg = requireBilling(env, k);
  const reg = registry(env);
  if (action === "claim") return claimRedeem(req, env, k, cfg, space);
  const st = await reg.spaceUsage(space);
  if (!st) k.fail("unauthorized", "space not found");
  const customer = (await reg.stripeCustomer(space)) ?? undefined;
  const base = origin(env, req);
  try {
    if (action === "checkout") {
      const choice = proChoice(await k.readJson(req, true), k);
      if (st!.plan === "paid") k.fail("invalid_message", "this space is already on a paid plan; change seats or cancel with `npx @celador/weft billing`", { issues: [{ path: "", message: "already paid" }] });
      const s = await stripeRequest<CheckoutSession>(cfg.key, "POST", "/v1/checkout/sessions", {
        mode: "subscription",
        line_items: [proLine(cfg, choice.interval, choice.seats)],
        client_reference_id: space,
        metadata: { weft_space: space, weft_plan: "pro" },
        subscription_data: { metadata: { weft_space: space, weft_plan: "pro" } },
        allow_promotion_codes: true,
        // Bill in USD like the price (Adaptive Pricing would show and charge a converted amount).
        adaptive_pricing: { enabled: false },
        success_url: `${base}/billing/done`,
        cancel_url: `${base}/billing/cancelled`,
        ...(customer ? { customer } : {}),
      });
      if (!s.url) throw new StripeError(502, "no_url", "Stripe returned no Checkout URL");
      return k.json({ type: "billing.checkout", url: s.url, interval: choice.interval, seats: choice.seats }, 201);
    }
    if (!customer) k.fail("invalid_message", "this space has no billing account yet; run `npx @celador/weft upgrade` first", { issues: [{ path: "", message: "no billing account" }] });
    const s = await stripeRequest<{ url: string }>(cfg.key, "POST", "/v1/billing_portal/sessions", {
      customer,
      return_url: `${base}/billing/done`,
      ...(cfg.portalConfig ? { configuration: cfg.portalConfig } : {}),
    });
    return k.json({ type: "billing.portal", url: s.url }, 201);
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    console.error("billing: stripe", action, e.status, e.code ?? "", e.message);
    return k.fail("unavailable", `Stripe could not start ${action === "checkout" ? "checkout" : "the billing portal"}; try again in a minute`);
  }
}

// ------------------------------------------------------------------ web-first purchase: /buy, claim codes

const clean = (v: string) => v.replace(/[^\w.~ -]/g, "").slice(0, 100);

/**
 * `GET /buy?interval=month|year&seats=N`: a Weft Pro Checkout Session with no space yet, answered with a 303 to
 * Stripe. Optional utm_* / ref parameters go into the session's metadata (kept by Stripe, not by the gateway).
 * The buyer comes back to the welcome page with `?session_id=...`, which trades it for a claim code.
 */
async function buy(req: Request, env: BillingEnv, k: Kit): Promise<Response> {
  const cfg = stripeConfig(env);
  if (!cfg) return page("Not on sale here", "This gateway does not sell Weft Pro. Local and self-hosted Weft are free: <code>npx @celador/weft</code>", 503);
  try {
    await k.throttle(req, "buy");
  } catch {
    return page("Slow down", "Too many checkouts from your network in the last minute. Wait a minute and try again.", 429);
  }
  const q = new URL(req.url).searchParams;
  const interval = q.get("interval") ?? "month";
  const seats = parseSeats(q.get("seats") ?? "1");
  if (!isInterval(interval) || seats === undefined) return page("Check the link", `Use <code>/buy?interval=month</code> or <code>year</code> and <code>seats=</code> 1 to ${MAX_SEATS}.`, 400);
  const meta: Record<string, string> = { weft_purchase: "web", weft_plan: "pro" };
  for (const p of PASSTHROUGH) {
    const v = q.get(p);
    if (v && clean(v)) meta[p] = clean(v);
  }
  const welcome = env.WEFT_WELCOME_URL?.trim() || DEFAULT_WELCOME;
  try {
    const s = await stripeRequest<CheckoutSession>(cfg.key, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      line_items: [proLine(cfg, interval, seats)],
      metadata: meta,
      subscription_data: { metadata: { weft_purchase: "web", weft_plan: "pro" } },
      allow_promotion_codes: true,
      adaptive_pricing: { enabled: false },
      // {CHECKOUT_SESSION_ID} is filled in by Stripe. The session id is what the welcome page trades for a claim code.
      success_url: `${welcome}${welcome.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: env.WEFT_PRICING_URL?.trim() || DEFAULT_PRICING,
    });
    if (!s.url) throw new StripeError(502, "no_url", "Stripe returned no Checkout URL");
    return new Response(null, { status: 303, headers: { location: s.url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    console.error("billing: stripe buy", e.status, e.code ?? "", e.message);
    return page("Checkout is unavailable", "Stripe could not start checkout. Try again in a minute.", 503);
  }
}

type SessionObject = { id?: unknown; mode?: unknown; status?: unknown; payment_status?: unknown; amount_total?: unknown; customer?: unknown; subscription?: unknown; metadata?: Record<string, unknown> | null; client_reference_id?: unknown };

const idOf = (v: unknown): string | undefined => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : undefined);

/** A completed web purchase (ours, a subscription, paid or $0 due), as {session, customer, subscription, utm}; else null. */
function webPurchase(o: SessionObject): { session: string; customer: string; subscription: string; utm: Utm } | null {
  const session = idOf(o);
  const customer = idOf(o.customer);
  const subscription = idOf(o.subscription);
  if (o.metadata?.weft_purchase !== "web" || o.mode !== "subscription" || !session || !customer || !subscription || o.client_reference_id) return null;
  if (o.payment_status === "unpaid" && Number(o.amount_total ?? 0) > 0) return null;
  const m = o.metadata;
  const utm: Utm = {
    ...(typeof m.utm_source === "string" && clean(m.utm_source) ? { source: clean(m.utm_source) } : {}),
    ...(typeof m.utm_campaign === "string" && clean(m.utm_campaign) ? { campaign: clean(m.utm_campaign) } : {}),
  };
  return { session, customer, subscription, utm };
}

function corsHeaders(env: BillingEnv, req: Request): Record<string, string> {
  const o = req.headers.get("origin");
  if (!o) return {};
  const allowed = (env.WEFT_SITE_ORIGINS ?? DEFAULT_SITE_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(o)) return {};
  return { "access-control-allow-origin": o, vary: "Origin", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
}

function withHeaders(r: Response, h: Record<string, string>): Response {
  if (!Object.keys(h).length) return r;
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(h)) headers.set(k, v);
  return new Response(r.body, { status: r.status, headers });
}

/**
 * `POST /v1/billing/claim {session_id}`: the welcome page trades the Checkout Session id Stripe put in its URL for a
 * one-time claim code (1 hour, single use). If Stripe's webhook has not arrived yet, the purchase is read from
 * Stripe directly. Rate limited per network like /v1/pair. The code is only ever in this response body.
 */
async function claimStart(req: Request, env: BillingEnv, k: Kit): Promise<Response> {
  const cfg = requireBilling(env, k);
  await k.throttle(req, "claim");
  const body = ((await k.readJson(req, true)) ?? {}) as { session_id?: unknown };
  const session = body.session_id;
  if (typeof session !== "string" || !SESSION_ID.test(session)) k.fail("invalid_message", "session_id must be the cs_... id from the welcome page's address", { issues: [{ path: "/session_id", message: "cs_..." }] });
  const reg = registry(env);
  if ((await reg.purchase(session as string)).status === "unknown") {
    try {
      const s = await stripeRequest<SessionObject>(cfg.key, "GET", `/v1/checkout/sessions/${encodeURIComponent(session as string)}`);
      const p = s.status === "complete" ? webPurchase(s) : null;
      const facts = p ? await fetchSubscription(cfg, p.subscription) : null;
      if (p && facts?.pro && facts.seats && facts.interval)
        await reg.recordPurchase({ ...p, seats: facts.seats, interval: facts.interval, plan: planOf(facts.status), created: Math.floor(Date.now() / 1000) });
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      if (e.status !== 404) {
        console.error("billing: stripe claim lookup", e.status, e.code ?? "", e.message);
        k.fail("unavailable", "could not reach Stripe to check the purchase; try again in a minute");
      }
    }
  }
  const r = await reg.claimCodeCreate(session as string);
  if ("error" in r) {
    if (r.code === "unknown") k.fail("not_found", r.error, { status: "unknown" });
    // Already bound to a space: a 409 the welcome page tells apart from a failure.
    if (r.code === "claimed") return k.json({ type: "error", error: { code: "already_claimed", message: r.error, retryable: false, details: { status: "claimed" } } }, 409);
    k.fail("invalid_message", r.error, { status: r.code });
  }
  const ok = r as { code: string; expires_at: string; seats: number; interval: Interval; utm: Utm };
  return k.json(
    {
      type: "billing.claim",
      code: ok.code,
      expires_at: ok.expires_at,
      seats: ok.seats,
      interval: ok.interval,
      command: `npx @celador/weft --hosted --claim ${ok.code}`,
      ...(ok.utm.source ? { utm_source: ok.utm.source } : {}),
      ...(ok.utm.campaign ? { utm_campaign: ok.utm.campaign } : {}),
    },
    201,
  );
}

/** `POST /v1/space/billing/claim {code}` (owner key): the space becomes Pro with the purchase's seats. */
async function claimRedeem(req: Request, env: BillingEnv, k: Omit<Kit, "respond">, cfg: StripeConfig, space: string): Promise<Response> {
  await k.throttle(req, "redeem", [`space:${space}`]);
  const body = ((await k.readJson(req, true)) ?? {}) as { code?: unknown };
  if (typeof body.code !== "string" || !body.code || body.code.length > 64) k.fail("invalid_message", "code is required", { issues: [{ path: "/code", message: "string" }] });
  const r = await registry(env).claimRedeem(space, body.code as string);
  if ("error" in r) k.fail(r.code === "invalid" || r.code === "gone" ? "unauthorized" : "invalid_message", r.error, { status: r.code });
  const ok = r as { space: string; seats: number; interval: Interval; subscription: string | null };
  live.delete(space);
  // Best effort: label the subscription with its space in Stripe, so the operator can find it. The plan does not depend on it.
  if (ok.subscription) {
    try {
      await stripeRequest(cfg.key, "POST", `/v1/subscriptions/${encodeURIComponent(ok.subscription)}`, { metadata: { weft_space: space } });
    } catch (e) {
      console.error("billing: could not label the claimed subscription", e instanceof Error ? e.message : String(e));
    }
  }
  return k.json({ type: "billing.claimed", plan: "paid", product: "pro", seats: ok.seats, interval: ok.interval });
}

// ------------------------------------------------------------------ webhook

type StripeEvent = { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
export type Intent = {
  space?: string;
  customer?: string;
  plan: Plan;
  checkout: boolean;
  /** The subscription a checkout created (its seats and status are read from Stripe). */
  subscription?: string;
  /** A web purchase (GET /buy): its Checkout Session id. */
  purchase?: string;
  /** What a customer.subscription.* event says the subscription is now. */
  facts?: SubscriptionFacts;
  /** A web purchase's marketing link (utm_source / utm_campaign from the /buy link). */
  utm?: Utm;
};

/**
 * What a Stripe event means for a space's plan, or null when it is none of our business. The same Stripe
 * account may send events for other products to this endpoint; a checkout session counts only if it is a
 * subscription we created (our space id as client_reference_id AND in metadata, or a /buy purchase marked
 * weft_purchase=web), the rest only through a customer we attached to a space or to a purchase.
 */
export function intentOf(ev: StripeEvent, prices?: { month: string; year: string }): Intent | null {
  const o = ev.data?.object;
  if (!o || typeof o !== "object") return null;
  const customer = idOf(o.customer);
  switch (ev.type) {
    case "checkout.session.completed": {
      const web = webPurchase(o as SessionObject);
      if (web) return { customer: web.customer, plan: "paid", checkout: true, subscription: web.subscription, purchase: web.session, ...(Object.keys(web.utm).length ? { utm: web.utm } : {}) };
      const space = typeof o.client_reference_id === "string" ? o.client_reference_id : undefined;
      const meta = (o.metadata ?? {}) as Record<string, unknown>;
      if (o.mode !== "subscription" || !space || !SPACE_ID.test(space) || meta.weft_space !== space || !customer) return null;
      // A $0 first invoice (a metered subscription, a 100% coupon) may leave the session `unpaid` (seen in test mode): the card
      // was collected and the subscription exists. Only a session that still owes money (a delayed payment method) waits;
      // customer.subscription.updated says when that subscription turns active.
      if (o.payment_status === "unpaid" && Number(o.amount_total ?? 0) > 0) return null;
      const subscription = idOf(o.subscription);
      return { space, customer, plan: "paid", checkout: true, ...(subscription ? { subscription } : {}) };
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (!customer) return null;
      const facts = subscriptionFacts(o, prices);
      const plan = ev.type === "customer.subscription.deleted" ? "free" : o.status === "active" || o.status === "trialing" ? "paid" : "free";
      return { customer, plan, checkout: false, ...(facts?.pro ? { facts } : {}) };
    }
    case "invoice.payment_failed":
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
  const intent = intentOf(ev, cfg.prices);
  if (!intent) return k.json({ received: true, result: "ignored" });

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
  const pro = facts?.pro && facts.seats && facts.interval ? { seats: facts.seats, interval: facts.interval } : undefined;

  if (intent.purchase) {
    // A web purchase is Pro by construction; anything else carrying our marker is not something we sold.
    if (!pro || !intent.customer || !intent.subscription) return k.json({ received: true, result: "ignored" });
    const r = await reg.recordPurchase({ session: intent.purchase, customer: intent.customer, subscription: intent.subscription, seats: pro.seats, interval: pro.interval, plan, created: ev.created, eventId: ev.id, ...(intent.utm ? { utm: intent.utm } : {}) });
    return k.json({ received: true, result: r.result });
  }

  const r = await reg.applyBillingEvent({
    id: ev.id,
    created: ev.created,
    plan,
    ...(intent.space ? { space: intent.space } : {}),
    ...(intent.customer ? { customer: intent.customer } : {}),
    ...(pro ? { pro } : {}),
  });
  if (r.space) live.delete(r.space);
  // A checkout finished for a space that is gone: do not leave its subscription running.
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

/** Routes that are not under /v1/space: /buy, the claim code, the webhook and the two return pages. Null for any other path. */
export async function billingRoute(req: Request, env: BillingEnv, k: Kit, path: string): Promise<Response | null> {
  const m = req.method;
  if (path === "/v1/billing/stripe/webhook" && m === "POST") return stripeWebhook(req, env, k);
  if (path === "/buy" && m === "GET") return buy(req, env, k);
  if (path === "/v1/billing/claim") {
    // Called from the welcome page on the site, cross-origin: CORS for the site's own origins only, no credentials.
    const cors = corsHeaders(env, req);
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "cache-control": "no-store" } });
    if (m === "POST") return withHeaders(await claimStart(req, env, k).catch((e) => k.respond(e)), cors);
  }
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
