// The live feed for a space: GET /feed (or /feed?space=<id>). There is no credential in the URL.
// The first visit asks for the one-time pairing code `npx @celador/weft pair` prints, trades it
// (POST /v1/pair) for a per-device session that lives in an HttpOnly cookie this script cannot
// read, and then polls /v1/repos and /v1/feed on the same origin. The old `/feed#t=<token>` links
// are retired: the page drops the fragment and says so. Plain HTML + inline JS, no deps.

export const FEED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Weft · live feed</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0d12'/%3E%3Cpath d='M5 20q2.75-5 5.5 0t5.5 0 5.5 0 5.5 0' stroke='%23ff6b6b' stroke-width='2.4' fill='none'/%3E%3C/svg%3E">
<style>
  :root { --bg:#0b0d12; --bg2:#10131a; --line:#1f2430; --text:#e8eaf0; --muted:#9aa1b2; --accent:#f59e3d; --err:#ff6b6b; --info:#7c9cff; --add:#7ee2a8;
          --mono: ui-monospace, "SF Mono", Menlo, monospace; --sans: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--sans); }
  header { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; padding: 14px 20px; background: rgba(11,13,18,.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
  header b { font-size: 17px; letter-spacing: -.01em; }
  header .sq { text-decoration: underline wavy var(--err); text-underline-offset: .22em; text-decoration-skip-ink: none; }
  #state { margin-left: auto; color: var(--muted); font-size: 13px; display: flex; gap: 8px; align-items: center; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  #dot.live { background: var(--add); box-shadow: 0 0 0 3px rgba(126,226,168,.15); }
  #dot.bad { background: var(--err); }
  main { max-width: 980px; margin: 0 auto; padding: 18px 20px 80px; }
  .repos { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 14px; }
  .chip { border: 1px solid var(--line); background: var(--bg2); color: var(--muted); padding: 3px 10px; border-radius: 999px; font: 12px var(--mono); cursor: pointer; }
  .chip.on { color: var(--text); border-color: var(--accent); }
  .empty { border: 1px dashed var(--line); border-radius: 12px; padding: 28px; color: var(--muted); text-align: center; }
  .empty code { color: var(--text); background: var(--bg2); padding: 2px 6px; border-radius: 6px; font-family: var(--mono); }
  ol { list-style: none; margin: 0; padding: 0; }
  li.ev { display: grid; grid-template-columns: 64px 1fr; gap: 4px 12px; padding: 10px 0; border-bottom: 1px solid var(--line); animation: in .35s ease-out; }
  @keyframes in { from { background: rgba(245,158,61,.10); } to { background: transparent; } }
  .seq { color: var(--muted); font: 12px var(--mono); padding-top: 2px; }
  .line { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
  .agent { font-weight: 600; }
  .kind { font: 12px var(--mono); color: var(--muted); }
  .badge { font: 11px var(--mono); padding: 1px 7px; border-radius: 6px; border: 1px solid var(--line); }
  .badge.accepted { color: var(--add); border-color: rgba(126,226,168,.35); }
  .badge.rejected, .badge.denied { color: var(--err); border-color: rgba(255,107,107,.4); }
  .badge.warned, .badge.pending { color: var(--accent); border-color: rgba(245,158,61,.4); }
  .repo { font: 12px var(--mono); color: var(--info); }
  .when { margin-left: auto; color: var(--muted); font-size: 12px; }
  .sum { grid-column: 2; color: var(--muted); font-size: 14px; word-break: break-word; }
  .files { grid-column: 2; font: 12px var(--mono); color: var(--muted); }
  .diag { grid-column: 2; margin-top: 4px; padding: 8px 10px; border-radius: 8px; background: rgba(255,107,107,.07); border: 1px solid rgba(255,107,107,.25); font: 13px/1.45 var(--mono); white-space: pre-wrap; word-break: break-word; }
  .diag .code { color: var(--err); text-decoration: underline wavy var(--err); text-underline-offset: .25em; text-decoration-skip-ink: none; }
  .diag.warning { background: rgba(245,158,61,.07); border-color: rgba(245,158,61,.3); }
  .diag.warning .code { color: var(--accent); text-decoration-color: var(--accent); }
  footer { color: var(--muted); font-size: 12px; text-align: center; padding: 20px; }
  footer a { color: var(--muted); }
  .notice { margin: 40px auto; max-width: 560px; color: var(--muted); }
  .retired { margin: 0 0 16px; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(245,158,61,.4); background: rgba(245,158,61,.07); color: var(--text); }
  .retired code, .notice code { background: var(--bg2); padding: 1px 6px; border-radius: 6px; font-family: var(--mono); }
  .pair { margin: 40px auto; max-width: 440px; display: grid; gap: 12px; }
  .pair h1 { font-size: 20px; margin: 0; letter-spacing: -.01em; }
  .pair p { margin: 0; color: var(--muted); }
  .pair code { background: var(--bg2); padding: 2px 6px; border-radius: 6px; font-family: var(--mono); color: var(--text); }
  .pair label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
  .pair input { background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 10px 12px; font: 16px var(--mono); }
  .pair input#code { font-size: 22px; letter-spacing: .12em; text-transform: uppercase; text-align: center; }
  .pair button { background: var(--accent); color: #1a1205; border: 0; border-radius: 8px; padding: 10px 14px; font: 600 15px var(--sans); cursor: pointer; }
  .pair button:disabled { opacity: .6; cursor: wait; }
  .pair .err { color: var(--err); min-height: 1.4em; }
  #leave { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 8px; padding: 3px 10px; font: 12px var(--sans); cursor: pointer; }
</style>
</head>
<body>
<header><b>Weft <span class="sq">live feed</span></b><span id="state"><span id="dot"></span><span id="status">connecting…</span><button id="leave" type="button" hidden>Unpair this browser</button></span></header>
<main>
  <div class="repos" id="repos"></div>
  <ol id="events"></ol>
  <div class="empty" id="empty" hidden>No events yet. Start a coding agent in a checkout where you ran <code>npx @celador/weft</code>; every edit it makes shows up here.</div>
</main>
<footer>This browser is paired to one space and can only read it. Pair other devices with <code>npx @celador/weft pair</code>; list or revoke them with <code>npx @celador/weft viewers</code>. <a href="https://github.com/celador/weft">Weft</a> · MIT</footer>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const main = document.querySelector("main");
  const SPACE = /^sp[a-z0-9]{10}$/;

  // Links of the old form (/feed#t=<token>) carried a bearer that never expired. They are retired:
  // forget the fragment at once (so it leaves the address bar and history), never send it anywhere, say why.
  let retired = false;
  if (/(^|[#&])t=/.test(location.hash.slice(1))) {
    retired = true;
    history.replaceState(null, "", location.pathname + location.search);
  }
  const banner = () => retired
    ? '<p class="retired" role="alert"><b>This link format was retired.</b> Feed links used to carry a key; they no longer work. Run <code>npx @celador/weft pair</code> in your repo for a one-time code, and enter it below.</p>'
    : "";

  const params = new URLSearchParams(location.search);
  const spaceParam = (params.get("space") || "").trim();
  const H = { "wcp-version": "0.1" };
  const get = (path) => fetch(path, { headers: H, credentials: "same-origin", cache: "no-store" });

  function deviceName() {
    const ua = navigator.userAgent || "";
    const has = (w) => ua.indexOf(w) >= 0;
    const browser = has("Edg") ? "Edge" : has("Firefox") ? "Firefox" : has("Chrome") ? "Chrome" : has("Safari") ? "Safari" : "Browser";
    const os = has("iPhone") || has("iPad") ? "iOS" : has("Android") ? "Android" : has("Mac OS X") ? "macOS" : has("Windows") ? "Windows" : has("Linux") ? "Linux" : "";
    return os ? browser + " on " + os : browser;
  }

  function showPair(message) {
    $("leave").hidden = true; $("dot").className = "bad"; $("status").textContent = "not paired";
    main.innerHTML = banner() + '<form class="pair" id="pair" autocomplete="off"><h1>Pair this browser</h1>' +
      '<p>Run <code>npx @celador/weft pair</code> in your repo. It prints a one-time code that works for 10 minutes. Enter it here once; this browser then stays paired for a week of use (until you unpair it).</p>' +
      '<label>Space<input id="space" name="space" required maxlength="12" spellcheck="false" autocapitalize="none" placeholder="spxxxxxxxxxx"></label>' +
      '<label>Pairing code<input id="code" name="code" required maxlength="16" spellcheck="false" autocapitalize="characters" autocomplete="one-time-code" placeholder="XXXXX-XXXXX"></label>' +
      '<label>Name for this device<input id="label" name="label" maxlength="60"></label>' +
      '<button type="submit" id="go">Pair</button><div class="err" id="err" role="alert"></div></form>';
    $("space").value = spaceParam; $("label").value = deviceName();
    if (message) $("err").textContent = message;
    ($("space").value ? $("code") : $("space")).focus();
    $("pair").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const space = $("space").value.trim().toLowerCase(), code = $("code").value.trim();
      if (!SPACE.test(space)) { $("err").textContent = "The space looks like sp followed by 10 letters or digits; the CLI prints it."; return; }
      $("go").disabled = true; $("err").textContent = "";
      try {
        const r = await fetch("/v1/pair", { method: "POST", headers: { ...H, "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ space, code, label: $("label").value }) });
        if (r.ok) { history.replaceState(null, "", location.pathname + "?space=" + space); start(); return; }
        const j = await r.json().catch(() => ({}));
        $("err").textContent = r.status === 401 ? "That code is not valid or has expired. Run npx @celador/weft pair for a new one."
          : r.status === 429 ? ((j.error && j.error.message) || "Too many attempts. Wait a minute and try again.") : ((j.error && j.error.message) || "Pairing failed (" + r.status + ").");
      } catch (e) { $("err").textContent = "Could not reach the gateway."; }
      $("go").disabled = false;
    });
  }

  async function start() {
    let me;
    try { me = await get("/v1/viewer"); } catch (e) { return showPair("Could not reach the gateway."); }
    if (me.status === 401 || me.status === 403) return showPair();
    if (!me.ok) return showPair("The gateway answered " + me.status + ".");
    const who = await me.json().catch(() => ({}));
    main.innerHTML = banner() + '<div class="repos" id="repos"></div><ol id="events"></ol>' +
      '<div class="empty" id="empty" hidden>No events yet. Start a coding agent in a checkout where you ran <code>npx @celador/weft</code>; every edit it makes shows up here.</div>';
    $("leave").hidden = false;
    retired = false;
    run(who.space || "");
    setInterval(() => get("/v1/viewer").catch(() => undefined), 3600000); // keeps the cookie as long as the session
  }

  $("leave").addEventListener("click", async () => {
    try { await fetch("/v1/viewer/logout", { method: "POST", headers: { ...H, "x-weft-feed": "1" }, credentials: "same-origin" }); } catch (e) {}
    location.reload();
  });

  let alive = true;
  function run(space) {
    let names = {}; let cursor = null; let filter = null; const shown = new Set();
    const short = (repo) => names[repo] ?? (space && repo.startsWith(space + "-") ? repo.slice(space.length + 1) : repo);
    const ago = (ts) => { const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000); return s < 60 ? Math.floor(s) + "s ago" : s < 3600 ? Math.floor(s / 60) + "m ago" : new Date(ts).toLocaleString(); };
    function render(e) {
      const li = document.createElement("li"); li.className = "ev"; li.dataset.repo = e.repo;
      const status = e.status || "";
      const who = e.agent || (e.actor && e.actor.id) || "system";
      const diags = (e.diagnostics || []).map((d) => {
        const at = d.range && d.range.start ? ":" + (d.range.start.line + 1) : "";
        const where = " " + esc(d.file || "") + at + (d.caused_by_agent ? " · caused by " + esc(d.caused_by_agent) + " (#" + esc(d.caused_by_seq) + ")" : "");
        return '<div class="diag ' + esc(d.severity === "warning" ? "warning" : "") + '"><span class="code">' + esc(d.code) + "</span>" + where + "\\n" + esc(d.message) + "</div>";
      }).join("");
      const files = (e.files || []).slice(0, 6).join("  ") + ((e.files || []).length > 6 ? "  …" : "");
      li.innerHTML = '<div class="seq">#' + esc(e.seq) + '</div><div class="line"><span class="agent">' + esc(who) + '</span><span class="kind">' + esc(e.kind) + "</span>" +
        (status ? '<span class="badge ' + esc(status) + '">' + esc(status) + "</span>" : "") + '<span class="repo">' + esc(short(e.repo)) + '</span><span class="when" data-ts="' + esc(e.ts) + '">' + esc(ago(e.ts)) + "</span></div>" +
        (e.summary ? '<div class="sum">' + esc(e.summary) + "</div>" : "") + (files ? '<div class="files">' + esc(files) + "</div>" : "") + diags;
      li.hidden = filter !== null && filter !== e.repo;
      return li;
    }
    function chips(repos) {
      const box = $("repos"); box.innerHTML = "";
      if (repos.length < 2) return;
      const mk = (label, val) => { const b = document.createElement("button"); b.className = "chip" + (filter === val ? " on" : ""); b.textContent = label;
        b.onclick = () => { filter = val; chips(repos); for (const li of $("events").children) li.hidden = filter !== null && filter !== li.dataset.repo; }; box.appendChild(b); };
      mk("all", null); for (const r of repos) mk(short(r.repo), r.repo);
    }
    const ended = () => Object.assign(new Error("pairing ended"), { ended: true });
    async function loadRepos() {
      const r = await get("/v1/repos");
      if (r.status === 401) throw ended();
      if (!r.ok) throw new Error("gateway " + r.status);
      const repos = (await r.json()).repos || [];
      chips(repos);
      return repos;
    }
    async function poll() {
      const q = cursor ? "?after=" + encodeURIComponent(cursor) + "&limit=200" : "?tail=1&limit=100";
      const r = await get("/v1/feed" + q);
      if (r.status === 401) throw ended();
      if (!r.ok) throw new Error("gateway " + r.status);
      const j = await r.json();
      const list = $("events");
      for (const e of j.events || []) { const k = e.repo + "#" + e.seq; if (shown.has(k)) continue; shown.add(k); list.insertBefore(render(e), list.firstChild); }
      if (j.cursor) cursor = j.cursor;
      $("empty").hidden = list.children.length > 0;
      return j.has_more;
    }
    async function tick() {
      if (!alive) return;
      try {
        const repos = await loadRepos();
        while (await poll()) {}
        $("dot").className = "live"; $("status").textContent = "live · " + repos.length + (repos.length === 1 ? " repo" : " repos");
        for (const w of document.querySelectorAll(".when")) w.textContent = ago(w.dataset.ts);
        setTimeout(tick, document.hidden ? 8000 : 2000);
      } catch (err) {
        if (err.ended) { alive = false; showPair("This browser's pairing ended (unpaired, expired, or the space was deleted). Pair it again to keep watching."); return; }
        $("dot").className = "bad"; $("status").textContent = err.message;
        setTimeout(tick, 5000);
      }
    }
    tick();
  }

  start();
})();
</script>
</body>
</html>
`;
