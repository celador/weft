// weft.mx accounts: sign-up, sign-in, /account/ and /cli/ (the `weft login` confirmation). Clerk's browser SDK is
// loaded from the Weft Clerk application's own Frontend API (window.WEFT_CONFIG, served by worker.js). The session
// token goes to the gateway as a Bearer header (never a cookie of ours, never in a URL). No framework, no build.
(() => {
  const CFG = window.WEFT_CONFIG || {};
  const PAGE = document.body.dataset.page || "";
  const $ = (s, root = document) => root.querySelector(s);
  const show = (state) => { for (const el of document.querySelectorAll("[data-state]")) el.hidden = el.dataset.state !== state; };
  const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${(Math.floor(n * 100) / 100).toFixed(2)}`);
  const PRICES = { month: 12, year: 98 };
  const track = (e, w = "") => { try { navigator.sendBeacon?.("/e", JSON.stringify({ e, w, s: "", k: "", c: "acct" })); } catch {} };

  // Where to go after signing in/up: a path on this site only (never another origin).
  const safeNext = (v, fallback = "/account/") => (typeof v === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(v) ? v : fallback);
  const next = safeNext(new URLSearchParams(location.search).get("redirect"));

  // The site's look (site.css) for Clerk's components: dark, amber accent, Geist.
  const APPEARANCE = {
    options: { logoImageUrl: "/assets/img/weft-mark-512.png", logoLinkUrl: "/", socialButtonsVariant: "blockButton", unsafe_disableDevelopmentModeWarnings: true },
    // clerk-js 6 / @clerk/ui 1 variable names
    variables: {
      colorPrimary: "#f59e3d",
      colorPrimaryForeground: "#1a1206",
      colorBackground: "#10131a",
      colorInput: "#0b0d12",
      colorInputForeground: "#e8eaf0",
      colorForeground: "#e8eaf0",
      colorMutedForeground: "#9aa1b2",
      colorNeutral: "#e8eaf0",
      colorDanger: "#ff6b6b",
      colorSuccess: "#7ee2a8",
      fontFamily: '"Geist", ui-sans-serif, system-ui, -apple-system, sans-serif',
      borderRadius: "12px",
    },
    elements: { card: { border: "1px solid #1f2430", boxShadow: "none" }, footer: { background: "#10131a" } },
  };

  // Clerk's UI bundle and SDK (clerk-js 6), both from the Weft application's own Frontend API.
  const script = (src, attrs = {}) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.crossOrigin = "anonymous";
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = resolve;
    s.onerror = () => reject(new Error("could not load the sign-in service"));
    document.head.append(s);
  });
  let clerkReady;
  function loadClerk() {
    if (clerkReady) return clerkReady;
    clerkReady = (async () => {
      if (!CFG.clerkPublishableKey || !CFG.clerkFrontendApi) throw new Error("accounts are not configured on this site");
      const base = `https://${CFG.clerkFrontendApi}/npm`;
      await script(`${base}/@clerk/ui@1/dist/ui.browser.js`);
      await script(`${base}/@clerk/clerk-js@6/dist/clerk.browser.js`, { "data-clerk-publishable-key": CFG.clerkPublishableKey });
      await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, appearance: APPEARANCE, signInUrl: "/sign-in/", signUpUrl: "/sign-up/", afterSignOutUrl: "/" });
      return window.Clerk;
    })();
    return clerkReady;
  }

  async function gw(clerk, method, path, body) {
    const token = await clerk.session?.getToken();
    if (!token) throw Object.assign(new Error("signed out"), { status: 401 });
    let r;
    try {
      r = await fetch(`${CFG.gateway}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw Object.assign(new Error("could not reach Weft's server (a network problem, or it is being updated)"), { status: 0 });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${r.status}`), { status: r.status, code: j?.error?.code });
    return j;
  }

  // ---------- nav: "Sign in" / "Sign up" or "Account" ----------
  async function nav() {
    const slot = $("[data-nav-auth]");
    if (!slot) return;
    try {
      const clerk = await loadClerk();
      if (clerk.user) slot.innerHTML = '<a href="/account/">Account</a>';
    } catch { /* signed-out links stay */ }
  }

  // ---------- /sign-in/ and /sign-up/ ----------
  async function authPage(kind) {
    const el = $("[data-clerk-mount]");
    try {
      const clerk = await loadClerk();
      if (clerk.user) { location.replace(next); return; }
      const opts = { forceRedirectUrl: next, fallbackRedirectUrl: next, signInUrl: `/sign-in/?redirect=${encodeURIComponent(next)}`, signUpUrl: `/sign-up/?redirect=${encodeURIComponent(next)}` };
      if (kind === "sign-up") { clerk.mountSignUp(el, opts); track("signup_view", next.startsWith("/account/?buy") ? "buy" : next.startsWith("/cli/") ? "cli" : "direct"); }
      else clerk.mountSignIn(el, opts);
    } catch (e) {
      el.textContent = `Sign-in is unavailable right now (${e.message}). Try again in a minute.`;
    }
  }

  // ---------- /account/ ----------
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "");
  const ago = (iso) => {
    if (!iso) return "no events yet";
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 2 ? "just now" : m < 120 ? `${m} minutes ago` : m < 48 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
  };
  const attr = () => { try { return JSON.parse(sessionStorage.getItem("weft.attr") || "null") || {}; } catch { return {}; } };

  async function accountPage() {
    show("loading");
    let clerk;
    try { clerk = await loadClerk(); } catch (e) { $("[data-error]").textContent = e.message; show("error"); return; }
    const here = location.pathname + location.search;
    if (!clerk.user) { location.replace(`/sign-up/?redirect=${encodeURIComponent(here)}`); return; }
    const q = new URLSearchParams(location.search);
    $("[data-email]").textContent = clerk.user.primaryEmailAddress?.emailAddress || "";
    $("[data-sign-out]").addEventListener("click", () => clerk.signOut({ redirectUrl: "/" }));
    const a = attr();
    const utm = new URLSearchParams();
    if (a.utm_source) utm.set("utm_source", a.utm_source);
    if (a.utm_campaign) utm.set("utm_campaign", a.utm_campaign);

    // Pricing page "Get Pro" while signed out comes back here with ?buy=month|year&seats=N: straight into Checkout.
    const buy = q.get("buy");
    if ((buy === "month" || buy === "year") && !q.get("checkout")) {
      history.replaceState(null, "", "/account/");
      try {
        const seats = Math.min(999, Math.max(1, Number(q.get("seats")) || 1));
        const r = await gw(clerk, "POST", "/v1/account/billing/checkout", { interval: buy, seats, utm_source: a.utm_source, utm_campaign: a.utm_campaign });
        track("checkout_start", `${buy}-${seats}`);
        location.assign(r.url);
        return;
      } catch (e) {
        if (e.status !== 400) { $("[data-error]").textContent = e.message; show("error"); return; }
        // already on Pro: fall through to the page
      }
    }

    let info;
    const load = async () => (info = (await gw(clerk, "GET", `/v1/account${utm.toString() ? `?${utm}` : ""}`)).account);
    try { await load(); } catch (e) { $("[data-error]").textContent = e.message; show("error"); return; }
    // Back from Checkout: the webhook may take a few seconds to make the account Pro.
    if (q.get("checkout") === "done") {
      $("[data-notice]").textContent = "Payment received. Your plan updates in a few seconds.";
      $("[data-notice]").hidden = false;
      for (let i = 0; i < 10 && info.plan !== "paid"; i++) { await new Promise((r) => setTimeout(r, 1500)); await load().catch(() => {}); }
      if (info.plan === "paid") $("[data-notice]").textContent = "Payment received. Weft Pro is on for every hosted space of this account.";
      history.replaceState(null, "", "/account/");
    }
    render(clerk, info);
    track("account_view", info.plan === "paid" ? "pro" : "free");
    show("ok");
  }

  function render(clerk, info) {
    const pro = info.plan === "paid" && info.product === "pro";
    $("[data-plan]").textContent = pro ? `Weft Pro, ${info.seats} ${info.seats === 1 ? "user" : "users"}` : info.plan === "paid" ? "Paid" : "Free";
    $("[data-plan-detail]").textContent = pro
      ? `Billed ${info.interval === "year" ? "yearly" : "monthly"}${info.period_end ? `, renews ${fmtDate(info.period_end)}` : ""}. No monthly event limit.`
      : "Local Weft is free with no limits. A hosted space on Free has a monthly event allowance.";
    $("[data-get-pro]").hidden = pro;
    $("[data-manage]").hidden = !info.has_billing_account;
    const list = $("[data-spaces]");
    list.textContent = "";
    if (!info.spaces.length) list.innerHTML = '<li class="meta">No hosted space yet. Connect a machine (above), then run <code>npx @celador/weft --hosted</code> in a repo.</li>';
    for (const s of info.spaces) {
      const li = document.createElement("li");
      li.innerHTML = `<code></code> <span class="meta"></span>`;
      li.querySelector("code").textContent = s.id;
      li.querySelector(".meta").textContent = `${s.repos} ${s.repos === 1 ? "repo" : "repos"} · ${s.events_this_month.toLocaleString("en-US")} events this month · last activity ${ago(s.last_event_at)}`;
      list.append(li);
    }
  }

  function proPicker(clerk) {
    const root = $("[data-get-pro]");
    if (!root) return;
    const state = { interval: "year", seats: 1 };
    const input = $("[data-seats]", root);
    const draw = () => {
      for (const b of root.querySelectorAll("[data-interval]")) b.setAttribute("aria-pressed", String(b.dataset.interval === state.interval));
      const per = PRICES[state.interval];
      $("[data-pro-total]", root).textContent = `${state.seats} ${state.seats === 1 ? "user" : "users"} × ${money(per)} = ${money(per * state.seats)} ${state.interval === "year" ? "a year" : "a month"}`;
      if (document.activeElement !== input) input.value = String(state.seats);
    };
    const clamp = (n) => Math.min(999, Math.max(1, Math.floor(Number(n)) || 1));
    for (const b of root.querySelectorAll("[data-interval]")) b.addEventListener("click", () => { state.interval = b.dataset.interval; draw(); });
    $("[data-seat-minus]", root).addEventListener("click", () => { state.seats = clamp(state.seats - 1); draw(); });
    $("[data-seat-plus]", root).addEventListener("click", () => { state.seats = clamp(state.seats + 1); draw(); });
    input.addEventListener("input", () => { if (input.value !== "") { state.seats = clamp(input.value); draw(); } });
    $("[data-checkout]", root).addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        const a = attr();
        const r = await gw(clerk, "POST", "/v1/account/billing/checkout", { interval: state.interval, seats: state.seats, utm_source: a.utm_source, utm_campaign: a.utm_campaign });
        track("checkout_start", `${state.interval}-${state.seats}`);
        location.assign(r.url);
      } catch (e) { $("[data-pro-error]", root).textContent = e.message; ev.target.disabled = false; }
    });
    draw();
  }

  function manage(clerk) {
    $("[data-portal]")?.addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try { location.assign((await gw(clerk, "POST", "/v1/account/billing/portal", {})).url); }
      catch (e) { $("[data-manage-error]").textContent = e.message; ev.target.disabled = false; }
    });
  }

  function deletion(clerk) {
    const form = $("[data-delete]");
    if (!form) return;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const out = $("[data-delete-result]");
      if ($("[data-delete-confirm]").value.trim().toLowerCase() !== "delete") { out.textContent = 'Type "delete" to confirm.'; return; }
      form.querySelector("button").disabled = true;
      out.textContent = "Deleting…";
      try {
        const token = await clerk.session.getToken();
        const r = await fetch("/api/account/delete", { method: "POST", headers: { authorization: `Bearer ${token}` }, credentials: "omit" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        show("deleted");
        await clerk.signOut().catch(() => {});
      } catch (e) { out.textContent = e.message; form.querySelector("button").disabled = false; }
    });
  }

  // ---------- /cli/: confirm the code `weft login` printed ----------
  async function cliPage() {
    const q = new URLSearchParams(location.search);
    const raw = (q.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const code = /^[2-9A-HJKMNP-Z]{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : "";
    show("loading");
    let clerk;
    try { clerk = await loadClerk(); } catch (e) { $("[data-error]").textContent = e.message; show("error"); return; }
    if (!code) { show("nocode"); return; }
    if (!clerk.user) { location.replace(`/sign-up/?redirect=${encodeURIComponent(`/cli/?code=${code}`)}`); return; }
    $("[data-code]").textContent = code;
    $("[data-email]").textContent = clerk.user.primaryEmailAddress?.emailAddress || "your account";
    show("confirm");
    $("[data-approve]").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        await gw(clerk, "POST", "/v1/login/approve", { code });
        history.replaceState(null, "", "/cli/");
        show("done");
      } catch (e) { $("[data-approve-error]").textContent = e.message; ev.target.disabled = false; }
    });
  }

  // Copy buttons (the login command on /account/).
  for (const btn of document.querySelectorAll("[data-copy]")) {
    btn.addEventListener("click", async () => {
      const code = btn.closest(".cmd-block")?.querySelector("code")?.textContent || "";
      try { await navigator.clipboard.writeText(code); btn.textContent = "Copied"; } catch { btn.textContent = "Press ⌘C"; }
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });
  }

  nav();
  if (PAGE === "sign-in" || PAGE === "sign-up") authPage(PAGE);
  if (PAGE === "account") loadClerk().then((c) => { proPicker(c); manage(c); deletion(c); }).catch(() => {}), accountPage();
  if (PAGE === "cli") cliPage();
})();
