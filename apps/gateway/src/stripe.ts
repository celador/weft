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
  /** The metered price (price_...) created by scripts/stripe-setup.mjs. */
  STRIPE_PRICE_ID?: string;
  /** Name of the Billing Meter's event (default weft_agent_events). */
  STRIPE_METER_EVENT_NAME?: string;
  /** Optional Customer Portal configuration (bpc_...); the account default is used when unset. */
  STRIPE_PORTAL_CONFIG_ID?: string;
  /** Public origin of this gateway for Checkout return pages; falls back to the request's origin. */
  WEFT_PUBLIC_URL?: string;
}

export type StripeConfig = { key: string; webhookSecret: string; price: string; meterEvent: string; portalConfig?: string };

/**
 * The billing configuration, or null when billing is off. All three secrets must be present and
 * look right; anything less is "off", so a half-configured gateway never enforces an allowance it
 * cannot sell its way out of.
 */
export function stripeConfig(env: StripeEnv): StripeConfig | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const price = env.STRIPE_PRICE_ID?.trim();
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) return null;
  if (!webhookSecret || !webhookSecret.startsWith("whsec_")) return null;
  if (!price || !price.startsWith("price_")) return null;
  const meterEvent = env.STRIPE_METER_EVENT_NAME?.trim() || DEFAULT_METER_EVENT;
  const portalConfig = env.STRIPE_PORTAL_CONFIG_ID?.trim();
  return { key, webhookSecret, price, meterEvent, ...(portalConfig ? { portalConfig } : {}) };
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
