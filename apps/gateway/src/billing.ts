// Usage-based billing for hosted spaces (docs/pricing.md): the Stripe-facing routes, the
// allowance gate and the usage meter. Everything here is inert until STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID are all set (stripeConfig): without them the billing
// routes answer 503 and no allowance is enforced. Usage is counted either way.
//
//   POST /v1/space/billing/checkout   owner key -> Stripe Checkout Session URL (subscription, metered price)
//   POST /v1/space/billing/portal     owner key -> Stripe Customer Portal URL
//   POST /v1/billing/stripe/webhook   Stripe -> plan changes (signature verified, idempotent on event id)
//   GET  /billing/done | /billing/cancelled   where Checkout and the Portal send the browser back
//   POST /v1/admin/billing/report     send unreported overage to Stripe now (also runs hourly)
//   POST /v1/admin/billing/reset-usage {month}        zero a month's counters (go-live)
//   POST /v1/admin/spaces/{id}/allowance {events|null}   override one space's free allowance
//   GET  /v1/admin/billing            plan counts and events this month

import type { Registry, SpaceGrant } from "./registry";
import { StripeError, cancelCustomerSubscriptions, stripeConfig, stripeRequest, verifyStripeSignature, type StripeConfig, type StripeEnv } from "./stripe";
import { freeEvents, monthKey, type Plan } from "./usage";

export interface BillingEnv extends StripeEnv {
  WEFT_REGISTRY: DurableObjectNamespace<Registry>;
  WEFT_FREE_EVENTS?: string;
}

type ErrCode = "unauthorized" | "forbidden" | "not_found" | "invalid_message" | "unavailable";
/** What the billing routes need from the gateway: error mapping, JSON responses, body parsing. */
export type BillingKit = {
  fail: (code: ErrCode, message: string, details?: Record<string, unknown>) => never;
  json: (body: unknown, status?: number, extra?: Record<string, string>) => Response;
  readJson: (req: Request, optional?: boolean) => Promise<unknown>;
};
type Kit = BillingKit;

const SPACE_ID = /^sp[a-z0-9]{10}$/;
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function registry(env: BillingEnv) {
  return env.WEFT_REGISTRY.get(env.WEFT_REGISTRY.idFromName("registry"));
}

function requireBilling(env: BillingEnv, k: Pick<Kit, "fail">): StripeConfig {
  const cfg = stripeConfig(env);
  if (!cfg) k.fail("unavailable", "billing is not enabled on this gateway (hosted usage billing is off; self-hosted and local gateways are free)");
  return cfg!;
}

const origin = (env: BillingEnv, req: Request) => env.WEFT_PUBLIC_URL?.trim().replace(/\/+$/, "") || new URL(req.url).origin;

// ------------------------------------------------------------------ allowance gate and meter

type Live = { over: boolean; events: number; allowance: number; exp: number };
const live = new Map<string, Live>();
const LIVE_MS = 10_000;

/**
 * The 429 for a free space that has used its allowance, or undefined to let the submit through.
 * Reads state the isolate already has (the cached grant, refreshed by the meter's last flush): no
 * Durable Object call. Off while billing is not configured.
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
        message: `This space used its ${allowance.toLocaleString("en-US")} free events for ${monthKey()}. Run \`npx @celador/weft upgrade\` to keep coordinating (usage-based, no seats); until then your agents work uncoordinated.`,
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

// ------------------------------------------------------------------ owner routes

type CheckoutSession = { id: string; url: string | null };

/** `POST /v1/space/billing/checkout` and `/portal`, after the space owner key has been verified. */
export async function spaceBilling(req: Request, env: BillingEnv, k: Kit, space: string, action: "checkout" | "portal"): Promise<Response> {
  const cfg = requireBilling(env, k);
  const reg = registry(env);
  const st = await reg.spaceUsage(space);
  if (!st) k.fail("unauthorized", "space not found");
  const customer = (await reg.stripeCustomer(space)) ?? undefined;
  const base = origin(env, req);
  try {
    if (action === "checkout") {
      if (st!.plan === "paid") k.fail("invalid_message", "this space is already on the paid plan; manage it with `npx @celador/weft billing`", { issues: [{ path: "", message: "already paid" }] });
      const s = await stripeRequest<CheckoutSession>(cfg.key, "POST", "/v1/checkout/sessions", {
        mode: "subscription",
        line_items: [{ price: cfg.price }],
        client_reference_id: space,
        metadata: { weft_space: space },
        subscription_data: { metadata: { weft_space: space } },
        success_url: `${base}/billing/done`,
        cancel_url: `${base}/billing/cancelled`,
        ...(customer ? { customer } : {}),
      });
      if (!s.url) throw new StripeError(502, "no_url", "Stripe returned no Checkout URL");
      return k.json({ type: "billing.checkout", url: s.url }, 201);
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

// ------------------------------------------------------------------ webhook

type StripeEvent = { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
export type Intent = { space?: string; customer?: string; plan: Plan; checkout: boolean };

const customerOf = (o: Record<string, unknown>): string | undefined => {
  const c = o.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string") return (c as { id: string }).id;
  return undefined;
};

/**
 * What a Stripe event means for a space's plan, or null when it is none of our business. The same Stripe
 * account may send events for other products to this endpoint; a checkout session counts only if it is a
 * subscription we created (our space id as client_reference_id AND in metadata), the rest only through a
 * customer we attached to a space.
 */
export function intentOf(ev: StripeEvent): Intent | null {
  const o = ev.data?.object;
  if (!o || typeof o !== "object") return null;
  const customer = customerOf(o);
  switch (ev.type) {
    case "checkout.session.completed": {
      const space = typeof o.client_reference_id === "string" ? o.client_reference_id : undefined;
      const meta = (o.metadata ?? {}) as Record<string, unknown>;
      if (o.mode !== "subscription" || !space || !SPACE_ID.test(space) || meta.weft_space !== space || !customer) return null;
      // A delayed payment method is not paid yet; customer.subscription.updated says when it is.
      if (o.payment_status !== "paid" && o.payment_status !== "no_payment_required") return null;
      return { space, customer, plan: "paid", checkout: true };
    }
    case "customer.subscription.updated":
      return customer ? { customer, plan: o.status === "active" || o.status === "trialing" ? "paid" : "free", checkout: false } : null;
    case "customer.subscription.deleted":
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
  const intent = intentOf(ev);
  if (!intent) return k.json({ received: true, result: "ignored" });
  const r = await registry(env).applyBillingEvent({
    id: ev.id,
    created: ev.created,
    plan: intent.plan,
    ...(intent.space ? { space: intent.space } : {}),
    ...(intent.customer ? { customer: intent.customer } : {}),
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

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style><h1>${title}</h1><p>${body}</p>`,
    { headers: PAGE_HEADERS },
  );
}

/** Routes that are not under /v1/space: the webhook and the two return pages. Null for any other path. */
export async function billingRoute(req: Request, env: BillingEnv, k: Kit, path: string): Promise<Response | null> {
  if (path === "/v1/billing/stripe/webhook" && req.method === "POST") return stripeWebhook(req, env, k);
  if (path === "/billing/done" && req.method === "GET") return page("Done", "Return to your terminal and run <code>npx @celador/weft usage</code>. The plan can take a few seconds to update.");
  if (path === "/billing/cancelled" && req.method === "GET") return page("Nothing changed", "You can close this tab. Run <code>npx @celador/weft upgrade</code> again whenever you like.");
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
