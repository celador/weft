#!/usr/bin/env node
// Create (or find) the Stripe objects hosted billing needs, idempotently, from the values in docs/pricing.md
// ("pricing-config" block): the "Weft Pro" product, its two licensed per-seat prices (monthly and yearly, found by
// lookup key), a Customer Portal configuration that lets a customer change seats and cancel, and (with --webhook)
// the webhook endpoint. Safe to run again: everything is looked up by a stable key first.
//
//   node scripts/stripe-setup.mjs                     # test mode: key from $STRIPE_KEY or keychain `weft-stripe-test-key`
//   node scripts/stripe-setup.mjs --live              # live mode: key from $STRIPE_KEY or keychain `weft-stripe-live-key`
//   node scripts/stripe-setup.mjs --webhook https://weft-hosted.elier.ai/v1/billing/stripe/webhook
//   node scripts/stripe-setup.mjs --webhook URL --wrangler-args "--env hosted"   # also `wrangler secret put` the secrets
//   node scripts/stripe-setup.mjs --delete-webhook URL  # remove an endpoint (E2E clean-up)
//   node scripts/stripe-setup.mjs --legacy-usage      # also the superseded usage objects (meter, metered price, portal)
//
// A test key never creates live objects and a live key needs --live: the mode is printed first.
// The webhook signing secret exists only at creation; it goes straight into `wrangler secret put` (stdin)
// or, without --wrangler-args, is not shown at all. Nothing secret is ever printed.
//
// Prices are in USD cents (`unit_amount`), per seat: Checkout sells a quantity of them (the seats).

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STRIPE_VERSION = "2025-09-30.clover"; // keep equal to apps/gateway/src/stripe.ts (a test checks)
export const PRODUCT_ID = "weft_hosted"; // legacy usage product; a custom product id makes "find or create" exact, with no search lag
export const PRICE_LOOKUP_KEY = "weft_hosted_agent_events";
export const PRO_LOOKUP_KEYS = { month: "weft_pro_user_month", year: "weft_pro_user_year" };
export const WEBHOOK_EVENTS = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed"];

/** The machine-readable block in docs/pricing.md. */
export function parsePricingConfig(markdown) {
  const m = /```json pricing-config\n([\s\S]*?)\n```/.exec(markdown);
  if (!m) throw new Error("docs/pricing.md has no ```json pricing-config block");
  const cfg = JSON.parse(m[1]);
  for (const k of ["currency", "free_events_per_month", "pro"]) if (cfg[k] === undefined) throw new Error(`pricing-config lacks ${k}`);
  for (const k of ["product_id", "product_name", "usd_per_user_month", "usd_per_user_year", "fair_use_events_per_seat_month", "max_seats"]) if (cfg.pro[k] === undefined) throw new Error(`pricing-config lacks pro.${k}`);
  if (!(cfg.pro.usd_per_user_month > 0) || !(cfg.pro.usd_per_user_year > 0)) throw new Error("Pro prices must be positive");
  if (cfg.legacy_usage && !(cfg.legacy_usage.usd_per_1000_events > 0)) throw new Error("legacy_usage.usd_per_1000_events must be positive");
  return cfg;
}

/** Whole cents for a dollar price (Stripe's `unit_amount`). */
export const cents = (usd) => Math.round(usd * 100);

/** Cents per single event as the decimal string Stripe wants (`unit_amount_decimal`), at most 12 decimals. */
export function centsPerEvent(usdPer1000) {
  const cents = (usdPer1000 * 100) / 1000;
  return String(Number(cents.toFixed(12)));
}

function form(params) {
  const out = [];
  const add = (k, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${k}[${i}]`, x));
    else if (typeof v === "object") for (const [kk, vv] of Object.entries(v)) add(`${k}[${kk}]`, vv);
    else out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.join("&");
}

/** A tiny Stripe client over `fetch`; `request` returns undefined on 404. */
export function stripeClient(key, fetchFn = fetch) {
  return async function request(method, path, params = {}) {
    const body = form(params);
    const res = await fetchFn(`https://api.stripe.com${path}${method === "GET" && body ? `?${body}` : ""}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "stripe-version": STRIPE_VERSION, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${res.status} ${String(json?.error?.message ?? "").replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_*]+/g, "[redacted]")}`);
    return json;
  };
}

/**
 * Weft Pro: find or create the product, the two per-seat prices and the portal configuration. Returns their ids.
 * `log` gets one line per step ("found" / "created" / "updated"). Never creates a second of anything: rerunning
 * only reports. A changed amount makes a new price that takes over the lookup key (existing subscribers keep theirs).
 */
export async function setup(request, cfg, log = () => {}) {
  const pro = cfg.pro;
  let product = await request("GET", `/v1/products/${pro.product_id}`);
  if (product && product.active) log(`product  found    ${product.id}`);
  else {
    product = product
      ? await request("POST", `/v1/products/${pro.product_id}`, { active: true })
      : await request("POST", "/v1/products", { id: pro.product_id, name: pro.product_name, description: "Hosted Weft for teams of coding agents, per user. No event cut-off.", metadata: { weft: "pro" } });
    log(`product  created  ${product.id}`);
  }
  const prices = {};
  for (const interval of ["month", "year"]) {
    const amount = cents(interval === "month" ? pro.usd_per_user_month : pro.usd_per_user_year);
    const key = PRO_LOOKUP_KEYS[interval];
    const found = await request("GET", "/v1/prices", { "lookup_keys[0]": key, active: true, limit: 10 });
    let price = found.data.find((p) => p.product === pro.product_id && p.currency === cfg.currency && p.unit_amount === amount && p.recurring?.interval === interval && p.recurring?.usage_type === "licensed");
    const label = `$${(amount / 100).toFixed(2)} per user per ${interval}`;
    if (price) log(`price    found    ${price.id} (${label})`);
    else {
      price = await request("POST", "/v1/prices", {
        product: pro.product_id,
        currency: cfg.currency,
        unit_amount: amount,
        billing_scheme: "per_unit",
        recurring: { interval, usage_type: "licensed" },
        lookup_key: key,
        transfer_lookup_key: true,
        nickname: `Weft Pro, per user, ${interval === "month" ? "monthly" : "yearly"}`,
        metadata: { weft: "pro", fair_use_events_per_seat_month: String(pro.fair_use_events_per_seat_month) },
      });
      log(`price    created  ${price.id} (${label})${found.data.length ? "; the previous price keeps its subscribers but is no longer the lookup key" : ""}`);
    }
    prices[interval] = price.id;
  }

  // Customer Portal: change the number of seats (prorated) or switch monthly/yearly, cancel at the end of the paid period,
  // update the card, see invoices.
  const features = {
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["quantity", "price"],
      proration_behavior: "create_prorations",
      products: [{ product: pro.product_id, prices: [prices.month, prices.year] }],
    },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
  };
  const configs = await request("GET", "/v1/billing_portal/configurations", { limit: 100, active: true });
  let portal = configs.data.find((c) => c.metadata?.weft === "pro");
  const current = (c) => {
    const u = c.features?.subscription_update;
    const listed = (u?.products ?? []).find((p) => p.product === pro.product_id)?.prices ?? [];
    return u?.enabled && (u.default_allowed_updates ?? []).includes("quantity") && listed.includes(prices.month) && listed.includes(prices.year) && c.features?.subscription_cancel?.mode === "at_period_end";
  };
  if (portal && !current(portal)) {
    portal = await request("POST", `/v1/billing_portal/configurations/${portal.id}`, { features });
    log(`portal   updated  ${portal.id} (seat changes for the current prices, cancel at period end)`);
  } else if (portal) log(`portal   found    ${portal.id}`);
  else {
    portal = await request("POST", "/v1/billing_portal/configurations", { business_profile: { headline: "Weft Pro: change seats, payment method or cancel" }, features, metadata: { weft: "pro" } });
    log(`portal   created  ${portal.id}`);
  }
  return { product: product.id, prices, portal: portal.id };
}

/**
 * The superseded usage-based objects (docs/pricing.md, history): meter, product, metered price and its portal
 * configuration, from `pricing-config.legacy_usage`. Only with --legacy-usage.
 */
export async function setupLegacyUsage(request, cfg, log = () => {}) {
  cfg = { currency: cfg.currency, free_events_per_month: cfg.free_events_per_month, ...cfg.legacy_usage };
  // Meter: by event name.
  const meters = await request("GET", "/v1/billing/meters", { limit: 100 });
  let meter = meters.data.find((m) => m.event_name === cfg.meter_event_name && m.status === "active");
  if (meter) log(`meter    found    ${meter.id} (${meter.event_name})`);
  else {
    meter = await request("POST", "/v1/billing/meters", {
      display_name: cfg.meter_display_name,
      event_name: cfg.meter_event_name,
      default_aggregation: { formula: "sum" },
      customer_mapping: { event_payload_key: "stripe_customer_id", type: "by_id" },
      value_settings: { event_payload_key: "value" },
    });
    log(`meter    created  ${meter.id} (${meter.event_name})`);
  }

  // Product: a fixed id.
  let product = await request("GET", `/v1/products/${PRODUCT_ID}`);
  if (product && product.active) log(`product  found    ${product.id}`);
  else {
    product = product
      ? await request("POST", `/v1/products/${PRODUCT_ID}`, { active: true })
      : await request("POST", "/v1/products", { id: PRODUCT_ID, name: cfg.product_name, description: "Hosted Weft: usage-based, billed monthly on agent events above the free allowance. No seats.", metadata: { weft: "hosted" } });
    log(`product  created  ${product.id}`);
  }

  // Price: by lookup key; a different amount or meter makes a new price that takes the key over.
  const want = centsPerEvent(cfg.usd_per_1000_events);
  const prices = await request("GET", "/v1/prices", { "lookup_keys[0]": PRICE_LOOKUP_KEY, active: true, limit: 10 });
  let price = prices.data.find((p) => p.product === PRODUCT_ID && p.currency === cfg.currency && p.recurring?.usage_type === "metered" && p.recurring?.meter === meter.id && Number(p.unit_amount_decimal) === Number(want));
  if (price) log(`price    found    ${price.id} (${want} cents per event = $${cfg.usd_per_1000_events.toFixed(2)} per 1,000)`);
  else {
    price = await request("POST", "/v1/prices", {
      product: PRODUCT_ID,
      currency: cfg.currency,
      unit_amount_decimal: want,
      billing_scheme: "per_unit",
      recurring: { interval: "month", usage_type: "metered", meter: meter.id },
      lookup_key: PRICE_LOOKUP_KEY,
      transfer_lookup_key: true,
      nickname: "Weft hosted agent events",
      metadata: { weft: "hosted", free_events_per_month: String(cfg.free_events_per_month) },
    });
    log(`price    created  ${price.id} (${want} cents per event = $${cfg.usd_per_1000_events.toFixed(2)} per 1,000)${prices.data.length ? "; the previous price keeps its subscribers but is no longer the lookup key" : ""}`);
  }

  // Customer Portal configuration: cancel at once, update card, invoice history.
  // A usage plan has nothing prepaid to run out, so cancelling takes effect immediately and the space goes back to the free plan.
  const features = {
    subscription_cancel: { enabled: true, mode: "immediately", proration_behavior: "none" },
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
  };
  const configs = await request("GET", "/v1/billing_portal/configurations", { limit: 100, active: true });
  let portal = configs.data.find((c) => c.metadata?.weft === "hosted");
  if (portal && portal.features?.subscription_cancel?.mode !== "immediately") {
    portal = await request("POST", `/v1/billing_portal/configurations/${portal.id}`, { features });
    log(`portal   updated  ${portal.id} (cancel takes effect immediately)`);
  } else if (portal) log(`portal   found    ${portal.id}`);
  else {
    portal = await request("POST", "/v1/billing_portal/configurations", { business_profile: { headline: "Weft hosted: manage your plan" }, features, metadata: { weft: "hosted" } });
    log(`portal   created  ${portal.id}`);
  }
  return { meter: meter.id, product: product.id, price: price.id, portal: portal.id };
}

/** Find or create the webhook endpoint. The signing secret exists only on creation: `secret` is undefined for an existing one. */
export async function ensureWebhook(request, url, log = () => {}) {
  const list = await request("GET", "/v1/webhook_endpoints", { limit: 100 });
  const hit = list.data.find((w) => w.url === url);
  if (hit) {
    log(`webhook  found    ${hit.id} (${hit.status}); its signing secret is shown only at creation: delete it (--delete-webhook) and rerun to get a new one`);
    return { id: hit.id };
  }
  const w = await request("POST", "/v1/webhook_endpoints", { url, enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_VERSION, description: "Weft hosted billing", metadata: { weft: "hosted" } });
  log(`webhook  created  ${w.id} -> ${url}`);
  return { id: w.id, secret: w.secret };
}

export async function deleteWebhook(request, url, log = () => {}) {
  const list = await request("GET", "/v1/webhook_endpoints", { limit: 100 });
  const hits = list.data.filter((w) => w.url === url);
  for (const w of hits) {
    await request("DELETE", `/v1/webhook_endpoints/${w.id}`);
    log(`webhook  deleted  ${w.id}`);
  }
  if (!hits.length) log("webhook  none for that URL");
  return hits.length;
}

// ------------------------------------------------------------------ CLI

function keyFor(live) {
  if (process.env.STRIPE_KEY) return process.env.STRIPE_KEY.trim();
  const service = live ? "weft-stripe-live-key" : "weft-stripe-test-key";
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    throw new Error(`no Stripe ${live ? "live" : "test"} key: set STRIPE_KEY or add it to the keychain: security add-generic-password -U -a weft -s ${service} -w`);
  }
}

/** `wrangler secret put NAME` with the value on stdin (never on a command line or in output). */
function putSecret(name, value, wranglerArgs) {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name, ...wranglerArgs.split(/\s+/).filter(Boolean)], { cwd: join(HERE, "..", "apps", "gateway"), input: `${value}\n`, encoding: "utf8", env: { ...process.env, CLOUDFLARE_API_TOKEN: "" } });
  if (r.status !== 0) throw new Error(`wrangler secret put ${name} failed (${r.status})`);
  console.log(`secret   set      ${name}`);
}

async function main(argv) {
  const flag = (n) => argv.includes(n);
  const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const live = flag("--live");
  const key = keyFor(live);
  const isLive = /^(sk|rk)_live_/.test(key);
  if (!/^(sk|rk)_(test|live)_/.test(key)) throw new Error("the key is not a Stripe secret or restricted key");
  if (isLive && !live) throw new Error("that is a LIVE key: pass --live to use it (nothing was done)");
  if (!isLive && live) throw new Error("--live was passed but the key is a test key (nothing was done)");
  console.log(isLive ? "LIVE MODE" : "TEST MODE");
  const request = stripeClient(key);
  const log = (l) => console.log(l);
  const del = val("--delete-webhook");
  if (del) {
    await deleteWebhook(request, del, log);
    return;
  }
  const cfg = parsePricingConfig(readFileSync(join(HERE, "..", "docs", "pricing.md"), "utf8"));
  const ids = await setup(request, cfg, log);
  if (flag("--legacy-usage")) await setupLegacyUsage(request, cfg, log);
  const wrangler = val("--wrangler-args");
  const hook = val("--webhook");
  let secret;
  if (hook) secret = (await ensureWebhook(request, hook, log)).secret;
  if (wrangler !== undefined) {
    putSecret("STRIPE_SECRET_KEY", key, wrangler);
    putSecret("STRIPE_PRICE_PRO_MONTH", ids.prices.month, wrangler);
    putSecret("STRIPE_PRICE_PRO_YEAR", ids.prices.year, wrangler);
    putSecret("STRIPE_PORTAL_CONFIG_ID", ids.portal, wrangler);
    if (secret) putSecret("STRIPE_WEBHOOK_SECRET", secret, wrangler);
    else if (hook) console.log("secret   skipped  STRIPE_WEBHOOK_SECRET (the endpoint already existed; see above)");
  } else {
    console.log(`\nSTRIPE_PRICE_PRO_MONTH=${ids.prices.month}\nSTRIPE_PRICE_PRO_YEAR=${ids.prices.year}\nSTRIPE_PORTAL_CONFIG_ID=${ids.portal}\n(set them and STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET with wrangler secret put, or rerun with --wrangler-args "--env hosted")`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`stripe-setup: ${e.message}`);
    process.exit(1);
  });
}
