// The private live feed for a hosted space: GET /feed#t=<viewer token>. The token stays in
// the URL fragment (never sent to the server, never in a Referer) and is used from this page
// as a bearer token against /v1/feed on the same origin. Plain HTML + inline JS, no deps.

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
</style>
</head>
<body>
<header><b>Weft <span class="sq">live feed</span></b><span id="state"><span id="dot"></span><span id="status">connecting…</span></span></header>
<main>
  <div class="repos" id="repos"></div>
  <ol id="events"></ol>
  <div class="empty" id="empty" hidden>No events yet. Start a coding agent in a checkout where you ran <code>npx @celador/weft</code>; every edit it makes shows up here.</div>
</main>
<footer>Private to you: this link carries your space's read-only key after the <code>#</code>, which never leaves your browser except to this gateway. <a href="https://github.com/celador/weft">Weft</a> · MIT</footer>
<script>
(() => {
  const key = new URLSearchParams(location.hash.slice(1)).get("t");
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  if (!key) {
    document.querySelector("main").innerHTML = '<p class="notice">This page needs the feed link that <code>npx @celador/weft</code> printed (it ends in <code>#t=…</code>). Run <code>npx @celador/weft status</code> in your repo to see it again.</p>';
    $("status").textContent = "no key"; $("dot").className = "bad"; return;
  }
  history.replaceState(null, "", location.pathname + location.search + "#t=" + encodeURIComponent(key));
  const H = { authorization: "Bearer " + key, "wcp-version": "0.1" };
  let names = {}; let space = ""; let cursor = null; let filter = null; const shown = [];
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
  async function loadRepos() {
    const r = await fetch("/v1/repos", { headers: H });
    if (r.status === 401) throw Object.assign(new Error("key not valid (space deleted, or link mistyped)"), { fatal: true });
    if (!r.ok) throw new Error("gateway " + r.status);
    const j = await r.json();
    const repos = j.repos || [];
    const first = repos[0] && repos[0].repo; const m = first && /^(sp[a-z0-9]{10})-/.exec(first); if (m) space = m[1];
    chips(repos);
    return repos;
  }
  async function poll() {
    const q = cursor ? "?after=" + encodeURIComponent(cursor) + "&limit=200" : "?tail=1&limit=100";
    const r = await fetch("/v1/feed" + q, { headers: H });
    if (r.status === 401) throw Object.assign(new Error("key not valid (space deleted, or link mistyped)"), { fatal: true });
    if (!r.ok) throw new Error("gateway " + r.status);
    const j = await r.json();
    const list = $("events");
    for (const e of j.events || []) { if (shown.includes(e.repo + "#" + e.seq)) continue; shown.push(e.repo + "#" + e.seq); list.insertBefore(render(e), list.firstChild); }
    if (j.cursor) cursor = j.cursor;
    $("empty").hidden = list.children.length > 0;
    return j.has_more;
  }
  let repoCount = -1;
  async function tick() {
    try {
      const repos = await loadRepos();
      if (repos.length !== repoCount) { repoCount = repos.length; }
      while (await poll()) {}
      $("dot").className = "live"; $("status").textContent = "live · " + repos.length + (repos.length === 1 ? " repo" : " repos");
      for (const w of document.querySelectorAll(".when")) w.textContent = ago(w.dataset.ts);
      setTimeout(tick, document.hidden ? 8000 : 2000);
    } catch (err) {
      $("dot").className = "bad"; $("status").textContent = err.message;
      if (!err.fatal) setTimeout(tick, 5000);
    }
  }
  tick();
})();
</script>
</body>
</html>
`;
