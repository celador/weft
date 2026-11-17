// Stripe, as little of it as hosted billing needs: a fetch-based client (Workers have no
// Node SDK), webhook signature verification, and the configuration check that keeps the whole
// feature off until an operator sets the secrets (docs/pricing.md).

/** Pinned so the shape of objects and webhook payloads does not move under us. */
export const STRIPE_VERSION = "2025-09-30.clover";
const STRIPE_API = "https://api.stripe.com";
export const DEFAULT_METER_EVENT = "weft_agent_events";

export interface StripeEnv {
  /** Secret or restricted key. Test mode in tests and previews: sk_test_ / rk_test_. */
  STRIPE_SECRET_KEY?: string;
  /** Signing secret of the webhook endpoint (whsec_...). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Weft Pro, per seat, billed monthly (price_...; scripts/stripe-setup.mjs prints it). */
  STRIPE_PRICE_PRO_MONTH?: string;
  /** Weft Pro, per seat, billed yearly. */
  STRIPE_PRICE_PRO_YEAR?: string;
  /** Weft Commercial License, per seat, billed yearly (optional: without both license prices the license is not on sale). */
  STRIPE_PRICE_LICENSE_YEAR?: string;
  /** Weft Commercial License, per seat, paid once (never renews). */
  STRIPE_PRICE_LICENSE_LIFETIME?: string;
  /** Name of the Billing Meter's event (default weft_agent_events): legacy usage-plan subscriptions only. */
  STRIPE_METER_EVENT_NAME?: string;
  /** Optional Customer Portal configuration (bpc_...); the account default is used when unset. */
  STRIPE_PORTAL_CONFIG_ID?: string;
  /** Public origin of this gateway for Checkout return pages; falls back to the request's origin. */
  WEFT_PUBLIC_URL?: string;
}

export type StripeConfig = {
  key: string;
  webhookSecret: string;
  prices: { month: string; year: string };
  /** The Commercial License prices, when both are set (docs/pricing.md). */
  license?: { year: string; lifetime: string };
  meterEvent: string;
  portalConfig?: string;
};

/**
 * The billing configuration, or null when billing is off. The key, the webhook secret and both Pro
 * prices must be present and look right; anything less is "off", so a half-configured gateway never
 * enforces an allowance it cannot sell its way out of. (STRIPE_PRICE_ID, the legacy metered price, is
 * no longer read: a gateway that has only it is off until the Pro prices are set.)
 */
export function stripeConfig(env: StripeEnv): StripeConfig | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const month = env.STRIPE_PRICE_PRO_MONTH?.trim();
  const year = env.STRIPE_PRICE_PRO_YEAR?.trim();
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) return null;
  if (!webhookSecret || !webhookSecret.startsWith("whsec_")) return null;
  if (!month || !month.startsWith("price_") || !year || !year.startsWith("price_")) return null;
  const meterEvent = env.STRIPE_METER_EVENT_NAME?.trim() || DEFAULT_METER_EVENT;
  const portalConfig = env.STRIPE_PORTAL_CONFIG_ID?.trim();
  const lYear = env.STRIPE_PRICE_LICENSE_YEAR?.trim();
  const lOnce = env.STRIPE_PRICE_LICENSE_LIFETIME?.trim();
  const license = lYear?.startsWith("price_") && lOnce?.startsWith("price_") ? { year: lYear, lifetime: lOnce } : undefined;
  return { key, webhookSecret, prices: { month, year }, ...(license ? { license } : {}), meterEvent, ...(portalConfig ? { portalConfig } : {}) };
}

/** What the gateway needs from a Stripe subscription: status, and the Pro seats and interval when it is a Pro one. */
export type SubscriptionFacts = {
  id: string;
  customer?: string;
  status: string;
  seats?: number;
  interval?: "month" | "year";
  pro: boolean;
  periodEnd?: number;
  /** The first item's price id and quantity (the Commercial License is told apart by its price). */
  priceId?: string;
  quantity?: number;
  /** Start of the current period: a renewal that failed leaves the license paid only up to here. */
  periodStart?: number;
  cancelAtPeriodEnd?: boolean;
  /** Set on a subscription the buyer cancelled (Stripe's `ended_at`). */
  endedAt?: number;
  metadata?: Record<string, string>;
};

type StripeSubscription = {
  id?: unknown;
  status?: unknown;
  customer?: unknown;
  current_period_end?: unknown;
  current_period_start?: unknown;
  cancel_at_period_end?: unknown;
  ended_at?: unknown;
  metadata?: unknown;
  items?: { data?: Array<{ quantity?: unknown; current_period_end?: unknown; current_period_start?: unknown; price?: { id?: unknown; recurring?: { interval?: unknown; usage_type?: unknown } } }> };
};

/**
 * Read a subscription object (from the API or from a `customer.subscription.*` event). It is Pro when its
 * item is one of our Pro prices; the seats are that item's quantity. A legacy metered subscription has no
 * quantity and is not Pro.
 */
export function subscriptionFacts(o: unknown, prices?: { month: string; year: string }, license?: { year: string }): SubscriptionFacts | null {
  const s = o as StripeSubscription;
  if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.status !== "string") return null;
  const customer = typeof s.customer === "string" ? s.customer : typeof (s.customer as { id?: unknown })?.id === "string" ? (s.customer as { id: string }).id : undefined;
  const item = s.items?.data?.[0];
  const priceId = typeof item?.price?.id === "string" ? item.price.id : undefined;
  const interval = item?.price?.recurring?.interval;
  const licensed = item?.price?.recurring?.usage_type !== "metered";
  const isLicense = Boolean(license && priceId === license.year);
  const pro = !isLicense && Boolean(item && licensed && (prices ? priceId === prices.month || priceId === prices.year : true) && (interval === "month" || interval === "year"));
  const q = item?.quantity;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const start = num(item?.current_period_start) ?? num(s.current_period_start);
  const meta = s.metadata && typeof s.metadata === "object" ? Object.fromEntries(Object.entries(s.metadata as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string> : undefined;
  return {
    id: s.id,
    status: s.status,
    ...(customer ? { customer } : {}),
    pro,
    ...(pro && typeof q === "number" && Number.isInteger(q) && q > 0 ? { seats: q } : {}),
    ...(pro ? { interval: interval as "month" | "year" } : {}),
    // The renewal date: on the item since Stripe API 2025-03-31, on the subscription before.
    ...(typeof item?.current_period_end === "number" ? { periodEnd: item.current_period_end } : typeof s.current_period_end === "number" ? { periodEnd: s.current_period_end } : {}),
    ...(priceId ? { priceId } : {}),
    ...(typeof q === "number" && Number.isInteger(q) && q > 0 ? { quantity: q } : {}),
    ...(start !== undefined ? { periodStart: start } : {}),
    ...(typeof s.cancel_at_period_end === "boolean" ? { cancelAtPeriodEnd: s.cancel_at_period_end } : {}),
    ...(num(s.ended_at) !== undefined ? { endedAt: num(s.ended_at)! } : {}),
    ...(meta ? { metadata: meta } : {}),
  };
}

export async function fetchSubscription(cfg: StripeConfig, id: string): Promise<SubscriptionFacts | null> {
  return subscriptionFacts(await stripeRequest<unknown>(cfg.key, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`), cfg.prices, cfg.license);
}

/** Stripe error text sometimes quotes a (masked) key; never let one reach a log or a response. */
const redact = (m: string) => m.replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_*]+/g, "[redacted]");

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** application/x-www-form-urlencoded with Stripe's bracket notation for nesting. */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const add = (k: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${k}[${i}]`, x));
    else if (typeof v === "object") for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) add(`${k}[${kk}]`, vv);
    else out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.join("&");
}

export async function stripeRequest<T>(
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  opts: { idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<T> {
  const body = formEncode(params);
  const url = `${STRIPE_API}${path}${method === "POST" || !body ? "" : `?${body}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "stripe-version": STRIPE_VERSION,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      ...(method === "POST" ? { body } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new StripeError(0, "network", `could not reach Stripe: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new StripeError(res.status, err?.code, redact(err?.message ?? `Stripe answered ${res.status}`));
  }
  return json as T;
}

/** Cancel every live subscription of a Stripe customer, invoicing what is metered so far. Returns how many. */
export async function cancelCustomerSubscriptions(cfg: StripeConfig, customer: string): Promise<number> {
  const subs = await stripeRequest<{ data: Array<{ id: string; status: string }> }>(cfg.key, "GET", "/v1/subscriptions", { customer, status: "all", limit: 100 });
  let n = 0;
  for (const s of subs.data) {
    if (s.status === "canceled" || s.status === "incomplete_expired") continue;
    await stripeRequest(cfg.key, "DELETE", `/v1/subscriptions/${encodeURIComponent(s.id)}`, { invoice_now: true, prorate: false });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------- webhook signature

const enc = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/;

function fromHex(h: string): Uint8Array {
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
}

export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: "missing" | "malformed" | "timestamp" | "mismatch" };

/**
 * Verify a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=<hex>...]`) over the raw body:
 * HMAC-SHA-256(secret, `${t}.${body}`). The comparison is crypto.subtle.verify, which is
 * constant-time. A timestamp further than `toleranceSec` from now (either way) is refused, so a
 * captured request cannot be replayed later. Several v1 entries are allowed (secret rotation).
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  opts: { nowSec?: number; toleranceSec?: number } = {},
): Promise<SignatureResult> {
  if (!header) return { ok: false, reason: "missing" };
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && HEX64.test(v)) sigs.push(v);
  }
  if (t === undefined || !sigs.length) return { ok: false, reason: "malformed" };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) return { ok: false, reason: "timestamp" };
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = enc.encode(`${t}.${payload}`);
  let match = false;
  // Check every candidate (no early exit) so timing does not reveal which one matched.
  for (const s of sigs) if (await crypto.subtle.verify("HMAC", k, fromHex(s), data)) match = true;
  return match ? { ok: true, timestamp: t } : { ok: false, reason: "mismatch" };
}

/** `Stripe-Signature` header for a body, as Stripe would send it (tests, scripts/stripe-setup.mjs --test-webhook). */
export async function signStripePayload(payload: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${nowSec}.${payload}`)));
  return `t=${nowSec},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
