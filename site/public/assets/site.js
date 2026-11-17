// weft.mx: one config object, then the page behaviour. No build step, no dependencies.
//
// EVERY price, limit and gateway URL a visitor sees comes from WEFT below; the HTML only holds
// fallbacks for readers without JavaScript (site/site.test.mjs checks the two agree). Prices are a
// PROPOSAL until John approves them (go-live card t_5408b767); a price change is a one-line edit here
// plus the HTML fallbacks the test points at.
const WEFT = {
  command: "npx @celador/weft",                 // the start command (Free, runs locally)
  claimCommand: "npx @celador/weft --hosted --claim",
  hosted: "https://weft-hosted.elier.ai",       // gateway: GET /buy, POST /v1/billing/claim
  prices: { month: 12, year: 98, pilot: 500 },  // USD. Pro is per user: `month` a month, `year` a year
  freeHostedEvents: 5000,                       // agent events per hosted space per month on Free
  fairUsePerSeat: 50000,                        // Pro fair use: agent events per seat per month (never a cut-off)
  maxSeats: 999,
  support: "john@elier.ai",
  pilotCall: "https://calendly.com/john-johnaaronnelson/chat",
};

const PAGE = document.body.dataset.page || "doc";
const fmtInt = (n) => n.toLocaleString("en-US");
// $98 a year shows as $8.16 a month: cents are cut, never rounded up.
const money = (n) => (Number.isInteger(n) ? `$${fmtInt(n)}` : `$${(Math.floor(n * 100) / 100).toFixed(2)}`);
const yearMonthly = WEFT.prices.year / 12;
const savePct = Math.round(100 * (1 - WEFT.prices.year / (12 * WEFT.prices.month)));
const FILL = {
  month: money(WEFT.prices.month),
  year: money(WEFT.prices.year),
  "year-monthly": money(yearMonthly),
  save: `${savePct}%`,
  pilot: money(WEFT.prices.pilot),
  "free-events": fmtInt(WEFT.freeHostedEvents),
  "fair-use": fmtInt(WEFT.fairUsePerSeat),
};
for (const el of document.querySelectorAll("[data-fill]")) if (FILL[el.dataset.fill]) el.textContent = FILL[el.dataset.fill];
for (const el of document.querySelectorAll("[data-weft-cmd]")) el.textContent = WEFT.command;
for (const el of document.querySelectorAll("a[data-support]")) { el.href = `mailto:${WEFT.support}`; el.textContent = WEFT.support; }
for (const el of document.querySelectorAll("a[data-pilot-call]")) el.href = WEFT.pilotCall;

// ---------- attribution (no cookies) ----------
// The first page a tab opens remembers where the visit came from (utm_* tags, else the referring
// site) in that tab's sessionStorage, so a buy click two pages later still counts for the campaign.
// It leaves the browser only inside the anonymous events below and the buy link.
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content"];
const clean = (v, n) => String(v ?? "").replace(/[^\w.\-]/g, "").slice(0, n);
const ATTR = (() => {
  const q = new URLSearchParams(location.search);
  const fromUrl = {};
  for (const k of UTM_KEYS) if (q.get(k)) fromUrl[k] = clean(q.get(k), 64);
  let attr = Object.keys(fromUrl).length ? fromUrl : null;
  if (!attr) { try { attr = JSON.parse(sessionStorage.getItem("weft.attr") || "null"); } catch {} }
  if (!attr) attr = { utm_source: clean(document.referrer.replace(/^https?:\/\/([^/]+).*$/, "$1"), 64) || "direct" };
  if (!attr.utm_source) attr.utm_source = "direct";
  try { sessionStorage.setItem("weft.attr", JSON.stringify(attr)); } catch {}
  return attr;
})();

// Funnel events -> POST /e (Workers Analytics Engine, see site/worker.js). Stored: the event name,
// where it happened, the traffic source and campaign. No IP, no user agent, no identifiers.
function track(e, w = "", extra = {}) {
  const body = JSON.stringify({ e, w, s: extra.s || ATTR.utm_source, k: extra.k || ATTR.utm_campaign || "", c: "npx" });
  try { if (navigator.sendBeacon && navigator.sendBeacon("/e", body)) return; } catch {}
  fetch("/e", { method: "POST", body, keepalive: true }).catch(() => {});
}
if (PAGE === "pricing") track("pricing_view", "pricing");
else if (PAGE !== "welcome") track("view", PAGE); // the welcome page tracks once it knows the outcome

// ---------- copy buttons ----------
let copying = false;
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.append(ta); ta.select();
  let ok = false; copying = true;
  try { ok = document.execCommand("copy"); } catch {}
  copying = false; ta.remove(); return ok;
}
for (const btn of document.querySelectorAll("[data-copy]")) {
  btn.addEventListener("click", async () => {
    const block = btn.closest(".cmd-block");
    const code = block.querySelector("code");
    const ok = await copyText(code.textContent);
    btn.textContent = ok ? "Copied" : "Press ⌘C";
    btn.classList.toggle("done", ok);
    if (!ok) {
      const r = document.createRange(); r.selectNodeContents(code);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    }
    // The claim command holds a one-time code; copying it is not a start-command copy.
    if (!block.hasAttribute("data-no-track")) track("copy", block.dataset.placement || "");
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 2000);
  });
}
// Selecting the start command by hand and copying it counts as a copy too.
document.addEventListener("copy", () => {
  if (copying) return;
  const sel = getSelection();
  const block = sel?.anchorNode?.parentElement?.closest(".cmd-block");
  if (block && !block.hasAttribute("data-no-track") && String(sel).trim()) track("copy", `${block.dataset.placement || ""}-manual`);
});

// ---------- buy link ----------
function buyUrl(interval, seats) {
  const u = new URL("/buy", WEFT.hosted);
  u.searchParams.set("interval", interval);
  u.searchParams.set("seats", String(seats));
  for (const k of UTM_KEYS) if (ATTR[k]) u.searchParams.set(k, ATTR[k]);
  return u.toString();
}
// Every "Get Pro" outside the pricing page goes to /pricing/ (seats are picked there); clicks on it
// are not buy clicks. On the pricing page the Pro button is the buy link.
(() => {
  const root = document.querySelector("[data-pro]");
  if (!root) return;
  const input = root.querySelector("[data-seats]");
  const buy = root.querySelector("[data-buy-pro]");
  const state = { interval: "year", seats: 1 };
  const clamp = (n) => Math.min(WEFT.maxSeats, Math.max(1, Math.floor(Number(n)) || 1));
  function render() {
    const { interval, seats } = state;
    const perUser = interval === "year" ? WEFT.prices.year : WEFT.prices.month;
    for (const b of document.querySelectorAll("[data-interval]")) b.setAttribute("aria-pressed", String(b.dataset.interval === interval));
    root.querySelector("[data-pro-price]").textContent = money(interval === "year" ? yearMonthly : WEFT.prices.month);
    root.querySelector("[data-pro-unit]").textContent = interval === "year" ? `per user a month, billed ${money(WEFT.prices.year)} a year` : "per user a month, billed monthly";
    root.querySelector("[data-pro-total]").textContent =
      `${seats} ${seats === 1 ? "user" : "users"} × ${money(perUser)} = ${money(seats * perUser)} ${interval === "year" ? "a year" : "a month"}`;
    if (document.activeElement !== input || input.value !== "") input.value = String(seats);
    root.querySelector("[data-seat-minus]").disabled = seats <= 1;
    buy.href = buyUrl(interval, seats);
  }
  for (const b of document.querySelectorAll("[data-interval]")) b.addEventListener("click", () => { state.interval = b.dataset.interval; render(); });
  root.querySelector("[data-seat-minus]").addEventListener("click", () => { state.seats = clamp(state.seats - 1); render(); });
  root.querySelector("[data-seat-plus]").addEventListener("click", () => { state.seats = clamp(state.seats + 1); render(); });
  input.addEventListener("input", () => { if (input.value !== "") { state.seats = clamp(input.value); render(); } });
  input.addEventListener("blur", () => { state.seats = clamp(input.value); render(); });
  buy.addEventListener("click", () => track("buy_click", `${state.interval}-${state.seats}`));
  render();
})();

// ---------- welcome: trade the Checkout session for a one-time claim code ----------
(() => {
  if (PAGE !== "welcome") return;
  // Until it is claimed, the session id is enough to get the code: take it out of the address bar
  // at once (so it isn't in history, bookmarks or screenshots); a reload in this tab still finds it.
  const q = new URLSearchParams(location.search);
  let sid = q.get("session_id");
  if (sid) {
    try { sessionStorage.setItem("weft.checkout", sid); } catch {}
    history.replaceState(null, "", location.pathname);
  } else {
    try { sid = sessionStorage.getItem("weft.checkout"); } catch {}
  }
  const show = (state) => { for (const el of document.querySelectorAll("[data-state]")) el.hidden = el.dataset.state !== state; };
  // One welcome_view per checkout session (a reload doesn't count twice).
  const once = (w, then) => {
    let seen = null; try { seen = sessionStorage.getItem("weft.welcomed"); } catch {}
    if (seen === `${sid}:${w}`) return;
    try { sessionStorage.setItem("weft.welcomed", `${sid}:${w}`); } catch {}
    track("welcome_view", w); then?.();
  };
  if (!sid || !/^cs_[A-Za-z0-9_]{8,200}$/.test(sid)) { show("none"); track("welcome_view", "no-session"); return; }
  show("loading");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    // Stripe can send the buyer back before its webhook reaches the gateway, so "not found" and
    // "not paid yet" are retried for about 9 seconds before the page says so.
    for (let attempt = 0; attempt < 4; attempt++) {
      let r, j = {};
      try {
        r = await fetch(new URL("/v1/billing/claim", WEFT.hosted), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: sid }), credentials: "omit", referrerPolicy: "no-referrer",
        });
        j = await r.json().catch(() => ({}));
      } catch { once("network"); show("network"); return; }
      const code = typeof (j.code ?? j.claim_code) === "string" ? (j.code ?? j.claim_code) : "";
      if (r.ok && /^[A-Za-z0-9-]{4,64}$/.test(code)) {
        document.querySelector("[data-claim-cmd]").textContent = `${WEFT.claimCommand} ${code}`;
        const seats = Number(j.seats);
        const billed = j.interval === "year" ? ", billed yearly" : j.interval === "month" ? ", billed monthly" : "";
        if (seats > 0) document.querySelector("[data-claim-seats]").textContent = `Weft Pro for ${seats} ${seats === 1 ? "user" : "users"}${billed}.`;
        show("ok");
        const s = clean(j.utm_source, 64), k = clean(j.utm_campaign, 64);
        once("paid", () => track("claim_ok", j.interval === "year" ? "year" : j.interval === "month" ? "month" : "", { s, k }));
        return;
      }
      // The gateway's errors are {type: "error", error: {code, message, details}} (docs/hosted.md).
      const err = String(j.error?.code ?? j.error ?? "");
      if (r.status === 409 && err === "already_claimed") { once("claimed"); show("claimed"); return; }
      const pending = r.status === 404 || r.status === 402 || (r.status === 409 && /pending|not_paid/.test(err));
      if (pending && attempt < 3) { await wait(2000 + attempt * 1000); continue; }
      once(pending ? "not-found" : r.status === 429 ? "rate-limited" : `http-${r.status}`);
      show(pending ? "notfound" : "network");
      return;
    }
  })();
})();

// Fade sections in as they enter the viewport (CSS skips this under prefers-reduced-motion).
(() => {
  const els = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("js");
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.08 });
  els.forEach((el) => io.observe(el));
})();
