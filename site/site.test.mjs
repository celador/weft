// node --test site/site.test.mjs   (site pages, site.js config, worker.js events, funnel sales columns; no network)
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatReport, siteEvents } from "./funnel.mjs";
import { eventPoint, EVENTS } from "./worker.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUB = join(HERE, "public");
const pages = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith(".html")) pages.push(p); } })(PUB);
const siteJs = readFileSync(join(PUB, "assets", "site.js"), "utf8");
// The WEFT config object at the top of site.js, evaluated on its own.
const WEFT = new Function(`${siteJs.slice(siteJs.indexOf("const WEFT"), siteJs.indexOf("};", siteJs.indexOf("const WEFT")) + 2)}; return WEFT;`)();

test("the funnel events the site sends are the ones the Worker stores", () => {
  for (const e of ["view", "copy", "pricing_view", "buy_click", "welcome_view", "claim_ok"]) assert.ok(EVENTS.has(e), e);
  const sent = [...siteJs.matchAll(/track\("([a-z_]+)"/g)].map((m) => m[1]);
  for (const e of sent) assert.ok(EVENTS.has(e), `site.js sends ${e}, worker.js drops it`);
  assert.deepEqual(new Set(sent), new Set(["view", "copy", "pricing_view", "buy_click", "welcome_view", "claim_ok"]));
});

test("eventPoint keeps the campaign in blob5, cleans every field, drops unknown events", () => {
  const p = eventPoint({ e: "buy_click", w: "year-3", s: "YouTube", k: "Video-1<script>", c: "npx" });
  assert.deepEqual(p.blobs, ["buy_click", "year-3", "youtube", "npx", "video-1script"]);
  assert.deepEqual(p.indexes, ["buy_click"]);
  assert.equal(eventPoint({ e: "purchase" }), null);
  assert.equal(eventPoint(null), null);
  assert.equal(eventPoint({ e: "view" }).blobs[4], "");
});

test("siteEvents counts the sales path per day and per campaign", () => {
  const row = (event, placement, campaign, n = 1, day = "2026-11-17") => ({ day: `${day} 00:00:00`, event, placement, source: "youtube", campaign, n });
  const r = siteEvents([
    row("view", "start", "vid1", 10), row("pricing_view", "pricing", "vid1", 4), row("buy_click", "year-2", "vid1", 2),
    row("welcome_view", "paid", "vid1"), row("welcome_view", "no-session", "vid1"), row("claim_ok", "year", "vid1"),
    row("view", "home", "", 5, "2026-11-16"), row("copy", "hero", "", 1, "2026-11-16"),
  ]);
  assert.deepEqual(r.byDay["2026-11-17"], { pricingViews: 4, buyClicks: 2, paid: 1, claimed: 1 });
  assert.deepEqual(r.byDay["2026-11-16"], { copies: 1 });
  assert.deepEqual(Object.keys(r.byCampaign), ["vid1", "(none)"]);
  assert.deepEqual(r.byCampaign.vid1, { views: 14, copies: 0, pricingViews: 4, buyClicks: 2, paid: 1, claimed: 1 });
  assert.deepEqual(r.copiesBy, { "youtube/hero": 1 });
});

test("formatReport prints the sales columns, the sales line and the campaign table", () => {
  const out = formatReport({
    days: 1, notes: [], copiesBy: {}, viewsBySource: {},
    daily: [{ day: "2026-11-17", visits: 20, copies: 1, pricingViews: 4, buyClicks: 2, paid: 1, claimed: 1, downloads: 3, firstRuns: 1 }],
    totals: { visits: 20, copies: 1, pricingViews: 4, buyClicks: 2, paid: 1, claimed: 1, downloads: 3, firstRuns: 1, hostedSpacesAllTime: 5 },
    byCampaign: { vid1: { views: 14, copies: 0, pricingViews: 4, buyClicks: 2, paid: 1, claimed: 1 } },
  });
  assert.match(out, /^day +visits +copies +pricing +buys +paid +claimed +npm +first-runs$/m);
  assert.match(out, /^2026-11-17 +20 +1 +4 +2 +1 +1 +3 +1$/m);
  assert.match(out, /sales: 20 visits -> 4 pricing views -> 2 buy clicks \(50\.0% of pricing views\) -> 1 paid -> 1 claimed/);
  assert.match(out, /^vid1 +14 +0 +4 +2 +1 +1$/m);
});

test("every price and limit in the HTML matches the WEFT config in site.js", () => {
  const money = (n) => (Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${(Math.floor(n * 100) / 100).toFixed(2)}`);
  const want = {
    month: money(WEFT.prices.month), year: money(WEFT.prices.year), "year-monthly": money(WEFT.prices.year / 12),
    save: `${Math.round(100 * (1 - WEFT.prices.year / (12 * WEFT.prices.month)))}%`, pilot: money(WEFT.prices.pilot),
    "free-events": WEFT.freeHostedEvents.toLocaleString("en-US"), "fair-use": WEFT.fairUsePerSeat.toLocaleString("en-US"),
  };
  assert.equal(want["year-monthly"], "$8.16");
  assert.equal(want.save, "32%");
  let seen = 0;
  for (const p of pages) {
    for (const m of readFileSync(p, "utf8").matchAll(/data-fill="([\w-]+)">([^<]*)</g)) {
      assert.ok(want[m[1]], `${p}: unknown data-fill ${m[1]}`);
      assert.equal(m[2], want[m[1]], `${p}: fallback for ${m[1]}`);
      seen++;
    }
  }
  assert.ok(seen >= 10, `only ${seen} data-fill fallbacks found`);
  // The no-JS fallbacks on the pricing card: yearly is selected first.
  const pricing = readFileSync(join(PUB, "pricing", "index.html"), "utf8");
  assert.match(pricing, new RegExp(`data-pro-price>\\${want["year-monthly"]}<`));
  assert.match(pricing, new RegExp(`data-pro-unit>per user a month, billed \\${want.year} a year<`));
  assert.match(pricing, new RegExp(`href="${WEFT.hosted}/buy\\?interval=year&amp;seats=1" data-buy-pro`));
});

test("no stale claims anywhere on the site", () => {
  for (const p of [...pages, join(PUB, "assets", "site.js")]) {
    const t = readFileSync(p, "utf8");
    for (const bad of [/never per[- ](seat|developer)/i, /no per-seat/i, /research prototype/i, /TypeScript today/i, /\$1(\.00)? per 1,000/i, /before the conflict exists/i]) {
      assert.doesNotMatch(t, bad, `${p}: ${bad}`);
    }
  }
});

test("/start/ is a page, not a redirect; /welcome/ loads no third-party script", () => {
  assert.doesNotMatch(readFileSync(join(PUB, "_redirects"), "utf8"), /^\/start/m);
  const w = readFileSync(join(PUB, "welcome", "index.html"), "utf8");
  assert.doesNotMatch(w, /<script[^>]+src="https?:/);
  assert.match(w, /name="referrer" content="no-referrer"/);
  for (const s of ["loading", "ok", "claimed", "notfound", "network", "none"]) assert.match(w, new RegExp(`data-state="${s}"`));
});
