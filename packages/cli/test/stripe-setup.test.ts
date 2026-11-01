// scripts/stripe-setup.mjs: reads its values from docs/pricing.md, is idempotent, and keeps test and live apart.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "stripe-setup.mjs");
const load = () => import(/* @vite-ignore */ SCRIPT) as Promise<{
  parsePricingConfig(md: string): Record<string, unknown> & { usd_per_1000_events: number; free_events_per_month: number; meter_event_name: string; currency: string; product_name: string; meter_display_name: string };
  centsPerEvent(usd: number): string;
  setup(request: unknown, cfg: unknown, log?: (l: string) => void): Promise<{ meter: string; product: string; price: string; portal: string }>;
  ensureWebhook(request: unknown, url: string, log?: (l: string) => void): Promise<{ id: string; secret?: string }>;
  stripeClient(key: string, f: typeof fetch): (m: string, p: string, params?: Record<string, unknown>) => Promise<any>;
  STRIPE_VERSION: string;
  PRICE_LOOKUP_KEY: string;
  PRODUCT_ID: string;
}>;

/** An in-memory Stripe: just enough of meters, products, prices, portal configurations and webhook endpoints. */
function fakeStripe() {
  const db = { meters: [] as any[], products: new Map<string, any>(), prices: [] as any[], portals: [] as any[], hooks: [] as any[], posts: [] as string[] };
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;
  return {
    db,
    async request(method: string, path: string, params: Record<string, any> = {}) {
      if (method === "POST") db.posts.push(path);
      if (method === "GET" && path === "/v1/billing/meters") return { data: db.meters };
      if (method === "POST" && path === "/v1/billing/meters") return db.meters[db.meters.push({ id: id("mtr"), status: "active", event_name: params.event_name, ...params }) - 1];
      if (method === "GET" && path.startsWith("/v1/products/")) return db.products.get(path.split("/").pop()!);
      if (method === "POST" && path === "/v1/products") return (db.products.set(params.id, { id: params.id, active: true, ...params }), db.products.get(params.id));
      if (method === "GET" && path === "/v1/prices") return { data: db.prices.filter((p) => p.active && p.lookup_key === params["lookup_keys[0]"]) };
      if (method === "POST" && path === "/v1/prices") {
        if (params.transfer_lookup_key) for (const p of db.prices) if (p.lookup_key === params.lookup_key) p.lookup_key = null;
        const price = { id: id("price"), active: true, product: params.product, currency: params.currency, recurring: params.recurring, unit_amount_decimal: params.unit_amount_decimal, lookup_key: params.lookup_key };
        db.prices.push(price);
        return price;
      }
      if (method === "GET" && path === "/v1/billing_portal/configurations") return { data: db.portals };
      if (method === "POST" && path === "/v1/billing_portal/configurations") return db.portals[db.portals.push({ id: id("bpc"), metadata: params.metadata, features: params.features }) - 1];
      if (method === "POST" && path.startsWith("/v1/billing_portal/configurations/")) return Object.assign(db.portals.find((c) => path.endsWith(c.id)), { features: params.features });
      if (method === "GET" && path === "/v1/webhook_endpoints") return { data: db.hooks };
      if (method === "POST" && path === "/v1/webhook_endpoints") return db.hooks[db.hooks.push({ id: id("we"), url: params.url, status: "enabled", secret: "whsec_fake", enabled_events: params.enabled_events }) - 1];
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

describe("scripts/stripe-setup.mjs", () => {
  it("reads its values from the pricing-config block in docs/pricing.md", async () => {
    const m = await load();
    const cfg = m.parsePricingConfig(readFileSync(join(ROOT, "docs", "pricing.md"), "utf8"));
    expect(cfg).toMatchObject({ meter_event_name: "weft_agent_events", currency: "usd" });
    expect(cfg.usd_per_1000_events).toBeGreaterThan(0);
    expect(() => m.parsePricingConfig("no block here")).toThrow(/pricing-config/);
  });

  it("converts dollars per 1,000 events to Stripe's cents-per-event decimal", async () => {
    const m = await load();
    expect(m.centsPerEvent(1)).toBe("0.1");
    expect(m.centsPerEvent(0.5)).toBe("0.05");
    expect(m.centsPerEvent(2.5)).toBe("0.25");
  });

  it("creates the meter, product, metered price and portal once; a second run creates nothing", async () => {
    const m = await load();
    const cfg = m.parsePricingConfig(readFileSync(join(ROOT, "docs", "pricing.md"), "utf8"));
    const s = fakeStripe();
    const log1: string[] = [];
    const ids = await m.setup(s.request, cfg, (l) => log1.push(l));
    expect(log1.every((l) => /created/.test(l))).toBe(true);
    const price = s.db.prices[0];
    expect(price).toMatchObject({ product: "weft_hosted", currency: "usd", lookup_key: "weft_hosted_agent_events", unit_amount_decimal: m.centsPerEvent(cfg.usd_per_1000_events) });
    expect(price.recurring).toMatchObject({ interval: "month", usage_type: "metered", meter: ids.meter });
    const postsAfterFirst = s.db.posts.length;
    const log2: string[] = [];
    const again = await m.setup(s.request, cfg, (l) => log2.push(l));
    expect(again).toEqual(ids);
    expect(log2.every((l) => /found/.test(l))).toBe(true);
    expect(s.db.posts.length).toBe(postsAfterFirst); // not a single write
  });

  it("an older portal configuration is updated to cancel immediately, once", async () => {
    const m = await load();
    const cfg = m.parsePricingConfig(readFileSync(join(ROOT, "docs", "pricing.md"), "utf8"));
    const s = fakeStripe();
    await m.setup(s.request, cfg);
    s.db.portals[0].features = { subscription_cancel: { mode: "at_period_end" } };
    const log: string[] = [];
    await m.setup(s.request, cfg, (l) => log.push(l));
    expect(log.find((l) => l.startsWith("portal"))).toContain("updated");
    expect(s.db.portals[0].features.subscription_cancel).toMatchObject({ mode: "immediately", proration_behavior: "none" });
    expect(s.db.portals).toHaveLength(1);
  });

  it("a changed price makes a new price that takes over the lookup key", async () => {
    const m = await load();
    const cfg = m.parsePricingConfig(readFileSync(join(ROOT, "docs", "pricing.md"), "utf8"));
    const s = fakeStripe();
    const first = await m.setup(s.request, cfg);
    const second = await m.setup(s.request, { ...cfg, usd_per_1000_events: cfg.usd_per_1000_events * 2 });
    expect(second.price).not.toBe(first.price);
    expect(second.meter).toBe(first.meter);
    expect(s.db.prices.filter((p) => p.lookup_key === "weft_hosted_agent_events")).toHaveLength(1);
  });

  it("registers the webhook endpoint once, with the four events the gateway reads", async () => {
    const m = await load();
    const s = fakeStripe();
    const a = await m.ensureWebhook(s.request, "https://x.example/v1/billing/stripe/webhook");
    expect(a.secret).toBe("whsec_fake");
    expect(s.db.hooks[0].enabled_events).toEqual(["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed"]);
    const b = await m.ensureWebhook(s.request, "https://x.example/v1/billing/stripe/webhook");
    expect(b).toEqual({ id: a.id }); // no second endpoint, and no secret to show again
    expect(s.db.hooks).toHaveLength(1);
  });

  it("pins the same Stripe API version as the gateway", async () => {
    const m = await load();
    const src = readFileSync(join(ROOT, "apps", "gateway", "src", "stripe.ts"), "utf8");
    expect(/STRIPE_VERSION = "([^"]+)"/.exec(src)![1]).toBe(m.STRIPE_VERSION);
  });

  it("redacts a key quoted back in a Stripe error", async () => {
    const m = await load();
    const call = m.stripeClient("sk_test_x", (async () => new Response(JSON.stringify({ error: { message: "Invalid API Key provided: sk_test_****abcd" } }), { status: 401 })) as typeof fetch);
    await expect(call("GET", "/v1/billing/meters")).rejects.toThrow(/\[redacted\]/);
    await expect(call("GET", "/v1/billing/meters")).rejects.not.toThrow(/sk_test/);
  });

  it("keeps test and live apart before any network call", () => {
    const run = (key: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, STRIPE_KEY: key }, encoding: "utf8" });
    const live = run("sk_live_not_a_real_key");
    expect(live.status).toBe(1);
    expect(live.stderr).toContain("pass --live");
    const liveOnTest = run("sk_test_not_a_real_key", "--live");
    expect(liveOnTest.status).toBe(1);
    expect(liveOnTest.stderr).toContain("test key");
    const junk = run("pk_test_publishable");
    expect(junk.status).toBe(1);
    expect(junk.stderr).toContain("not a Stripe secret");
    for (const r of [live, liveOnTest, junk]) expect(r.stdout + r.stderr).not.toMatch(/sk_live_not|sk_test_not|pk_test_pub/);
  });
});
