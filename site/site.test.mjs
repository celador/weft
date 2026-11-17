// node --test site/site.test.mjs   (site pages, site.js config, worker.js events, funnel sales columns; no network)
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatReport, siteEvents } from "./funnel.mjs";
import { deleteAccount, eventPoint, EVENTS, verifySession } from "./worker.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUB = join(HERE, "public");
const pages = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith(".html")) pages.push(p); } })(PUB);
const siteJs = readFileSync(join(PUB, "assets", "site.js"), "utf8");
// The WEFT config object at the top of site.js, evaluated on its own.
const WEFT = new Function(`${siteJs.slice(siteJs.indexOf("const WEFT"), siteJs.indexOf("};", siteJs.indexOf("const WEFT")) + 2)}; return WEFT;`)();

const accountJs = readFileSync(join(PUB, "assets", "account.js"), "utf8");
test("the funnel events the site sends are the ones the Worker stores", () => {
  const sent = [...`${siteJs}${accountJs}`.matchAll(/track\("([a-z_]+)"/g)].map((m) => m[1]);
  for (const e of sent) assert.ok(EVENTS.has(e), `the site sends ${e}, worker.js drops it`);
  assert.deepEqual(new Set(sent), new Set(EVENTS));
});

test("eventPoint keeps the campaign in blob5, cleans every field, drops unknown events", () => {
  const p = eventPoint({ e: "buy_click", w: "year-3", s: "YouTube", k: "Video-1<script>", c: "npx" });
  assert.deepEqual(p.blobs, ["buy_click", "year-3", "youtube", "npx", "video-1script"]);
  assert.deepEqual(p.indexes, ["buy_click"]);
  assert.equal(eventPoint({ e: "purchase" }), null);
  assert.equal(eventPoint(null), null);
  assert.equal(eventPoint({ e: "view" }).blobs[4], "");
});

test("siteEvents counts the site part of the sales path per day and per campaign", () => {
  const row = (event, placement, campaign, n = 1, day = "2026-11-17") => ({ day: `${day} 00:00:00`, event, placement, source: "youtube", campaign, n });
  const r = siteEvents([
    row("view", "start", "vid1", 10), row("pricing_view", "pricing", "vid1", 4), row("buy_click", "year-2", "vid1", 2),
    row("signup_view", "buy", "vid1"), row("checkout_start", "year-2", "vid1"),
    row("view", "home", "", 5, "2026-11-16"), row("copy", "hero", "", 1, "2026-11-16"),
  ]);
  assert.deepEqual(r.byDay["2026-11-17"], { pricingViews: 4, buyClicks: 2 });
  assert.deepEqual(r.byDay["2026-11-16"], { copies: 1 });
  assert.deepEqual(Object.keys(r.byCampaign), ["vid1", "(none)"]);
  assert.deepEqual(r.byCampaign.vid1, { views: 14, copies: 0, pricingViews: 4, buyClicks: 2, signups: 0, paid: 0 });
  assert.deepEqual(r.copiesBy, { "youtube/hero": 1 });
});

test("formatReport prints the sales columns (sign-ups and paid accounts), the sales line and the campaign table", () => {
  const out = formatReport({
    days: 1, notes: [], copiesBy: {}, viewsBySource: {},
    daily: [{ day: "2026-11-17", visits: 20, copies: 1, pricingViews: 4, buyClicks: 2, signups: 3, paid: 1, downloads: 3, firstRuns: 1 }],
    totals: { visits: 20, copies: 1, pricingViews: 4, buyClicks: 2, signups: 3, paid: 1, downloads: 3, firstRuns: 1, hostedSpacesAllTime: 5 },
    byCampaign: { vid1: { views: 14, copies: 0, pricingViews: 4, buyClicks: 2, signups: 3, paid: 1 } },
  });
  assert.match(out, /^day +visits +copies +pricing +buys +signups +paid +npm +first-runs$/m);
  assert.match(out, /^2026-11-17 +20 +1 +4 +2 +3 +1 +3 +1$/m);
  assert.match(out, /sales: 20 visits -> 4 pricing views -> 2 buy clicks \(50\.0% of pricing views\); 3 sign-ups -> 1 paid \(33\.3% of sign-ups\)/);
  assert.match(out, /^vid1 +14 +0 +4 +2 +3 +1$/m);
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
  // Get Pro goes through the account page (sign up first when signed out), never to an anonymous checkout.
  assert.match(pricing, /href="\/account\/\?buy=year&amp;seats=1" data-buy-pro/);
  assert.equal(WEFT.account, "/account/");
});

test("no stale claims anywhere on the site", () => {
  for (const p of [...pages, join(PUB, "assets", "site.js")]) {
    const t = readFileSync(p, "utf8");
    for (const bad of [/never per[- ](seat|developer)/i, /no per-seat/i, /research prototype/i, /TypeScript today/i, /\$1(\.00)? per 1,000/i, /before the conflict exists/i]) {
      assert.doesNotMatch(t, bad, `${p}: ${bad}`);
    }
  }
});

test("/start/ is a page; the old /welcome/ redirects to /account/; signed-in pages carry no tracking beacon and no referrer", () => {
  const redirects = readFileSync(join(PUB, "_redirects"), "utf8");
  assert.doesNotMatch(redirects, /^\/start/m);
  assert.match(redirects, /^\/welcome\/\* \/account\/ 301$/m);
  for (const p of ["account", "cli", "sign-in", "sign-up"]) {
    const h = readFileSync(join(PUB, p, "index.html"), "utf8");
    assert.match(h, /name="referrer" content="no-referrer"/, p);
    assert.match(h, /name="robots" content="noindex, nofollow"/, p);
    assert.doesNotMatch(h, /cloudflareinsights/, p);
    assert.match(h, /<script src="\/weft-config\.js"><\/script>/, p);
  }
  // Clerk's script comes only from the Weft application's own Frontend API (config), never a hard-coded host.
  assert.match(accountJs, /const base = `https:\/\/\$\{CFG\.clerkFrontendApi\}\/npm`/);
  assert.match(accountJs, /\$\{base\}\/@clerk\/clerk-js@6\/dist\/clerk\.browser\.js/);
  assert.match(accountJs, /\$\{base\}\/@clerk\/ui@1\/dist\/ui\.browser\.js/);
  assert.doesNotMatch(accountJs, /clerk\.elier\.ai/);
  // a redirect target is a path on this site, never another origin
  const safe = new Function(`${accountJs.slice(accountJs.indexOf("const safeNext"), accountJs.indexOf(";", accountJs.indexOf("const safeNext")) + 1)} return safeNext;`)();
  assert.equal(safe("/account/?buy=year&seats=2"), "/account/?buy=year&seats=2");
  for (const bad of ["//evil.test/x", "https://evil.test", "javascript:alert(1)", "/\\evil.test"]) assert.equal(safe(bad), "/account/", bad);
  // every page with the main nav offers Sign in and Sign up
  for (const p of pages) {
    const h = readFileSync(p, "utf8");
    if (!h.includes('aria-label="Primary"') || /data-page="(account|cli|sign-in|sign-up)"/.test(h)) continue;
    assert.match(h, /href="\/sign-in\/">Sign in</, p);
    assert.match(h, /href="\/sign-up\/">Sign up</, p);
  }
});

// ---------- POST /api/account/delete (site worker; Clerk secret only here) ----------

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function keypair() {
  const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", k.publicKey);
  return { priv: k.privateKey, jwks: { keys: [{ ...pub, kid: "ins_test", alg: "RS256", use: "sig" }] } };
}
async function sign(priv, claims, kid = "ins_test") {
  const body = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(claims)}`;
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(body))).toString("base64url");
  return `${body}.${sig}`;
}
const ISS = "https://clerk.weft.test";
const ORIGIN = "https://weft.test";
const now = () => Math.floor(Date.now() / 1000);

test("verifySession: Weft application only, this site only, not expired, untampered", async () => {
  const { priv, jwks } = await keypair();
  const good = { iss: ISS, sub: "user_2abcdefGHIJK", azp: ORIGIN, exp: now() + 60, nbf: now() - 1 };
  assert.equal(await verifySession(await sign(priv, good), { issuer: ISS, origin: ORIGIN, jwks }), "user_2abcdefGHIJK");
  for (const [why, claims] of [["issuer", { ...good, iss: "https://clerk.elier.ai" }], ["azp", { ...good, azp: "https://evil.test" }], ["expired", { ...good, exp: now() - 60 }]]) {
    await assert.rejects(verifySession(await sign(priv, claims), { issuer: ISS, origin: ORIGIN, jwks }), new RegExp(why));
  }
  const t = await sign(priv, good);
  const forged = `${t.split(".")[0]}.${enc({ ...good, sub: "user_2someoneELSE1" })}.${t.split(".")[2]}`;
  await assert.rejects(verifySession(forged, { issuer: ISS, origin: ORIGIN, jwks }), /signature/);
});

test("deleteAccount: the gateway erases first, then only the caller's own Clerk user; a gateway failure deletes nothing at Clerk", async () => {
  const { priv, jwks } = await keypair();
  const env = { CLERK_SECRET_KEY: "sk_test_site_only", CLERK_FRONTEND_API: "clerk.weft.test", WEFT_GATEWAY_URL: "https://gw.test" };
  const token = await sign(priv, { iss: ISS, sub: "user_2abcdefGHIJK", azp: ORIGIN, exp: now() + 60 });
  const req = (t = token) => new Request(`${ORIGIN}/api/account/delete`, { method: "POST", headers: { authorization: `Bearer ${t}` } });
  const calls = [];
  const ok = async (url, init) => {
    calls.push(`${init.method} ${url} ${init.headers.authorization === `Bearer ${token}` ? "user-token" : init.headers.authorization === "Bearer sk_test_site_only" ? "clerk-secret" : "?"}`);
    return url.startsWith("https://gw.test") ? Response.json({ deleted: true, subscriptions_cancelled: 1, spaces: [{ space: "spaaaaaaaaaa" }] }) : new Response("{}", { status: 200 });
  };
  const r = await deleteAccount(req(), env, { fetchFn: ok, origin: ORIGIN, jwks });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { deleted: true, spaces_erased: 1, subscriptions_cancelled: 1 });
  assert.deepEqual(calls, ["DELETE https://gw.test/v1/account user-token", "DELETE https://api.clerk.com/v1/users/user_2abcdefGHIJK clerk-secret"]);

  calls.length = 0;
  const gwDown = async (url, init) => (calls.push(url), url.startsWith("https://gw.test") ? Response.json({ type: "error", error: { message: "could not cancel" } }, { status: 503 }) : new Response("{}"));
  const r2 = await deleteAccount(req(), env, { fetchFn: gwDown, origin: ORIGIN, jwks });
  assert.equal(r2.status, 502);
  assert.deepEqual(calls, ["https://gw.test/v1/account"]);

  // another site's token, a forged one, no token, or GET: nothing is called
  calls.length = 0;
  const other = await sign(priv, { iss: ISS, sub: "user_2abcdefGHIJK", azp: "https://evil.test", exp: now() + 60 });
  assert.equal((await deleteAccount(req(other), env, { fetchFn: gwDown, origin: ORIGIN, jwks })).status, 401);
  assert.equal((await deleteAccount(new Request(`${ORIGIN}/api/account/delete`, { method: "POST" }), env, { fetchFn: gwDown, origin: ORIGIN, jwks })).status, 401);
  assert.equal((await deleteAccount(new Request(`${ORIGIN}/api/account/delete`), env, { fetchFn: gwDown, origin: ORIGIN, jwks })).status, 405);
  assert.deepEqual(calls, []);
});

test("team join: the pricing FAQ and the account page say how a teammate on another machine joins", () => {
  const pricing = readFileSync(join(PUB, "pricing", "index.html"), "utf8");
  const welcome = readFileSync(join(PUB, "account", "index.html"), "utf8");
  assert.doesNotMatch(pricing, /Not with a command yet|We're building a join command/);
  assert.match(pricing, /Can teammates on other machines join my space\?<\/h3>\s*<p>Yes\. Run <code>npx @celador\/weft invite<\/code>/);
  assert.match(pricing, /<li>Teammates on other machines join with their own key<\/li>/);
  for (const page of [pricing, welcome]) {
    assert.match(page, /npx @celador\/weft members/);
    assert.doesNotMatch(page, /--join sp/); // no code or space id in copy
  }
  assert.match(welcome, /run <code>npx @celador\/weft invite<\/code> in this repo/);
});
