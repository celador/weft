#!/usr/bin/env node
// Weft launch funnel, one report (docs/launch/README.md):
//   1. site visits      Cloudflare Web Analytics (RUM), site weft.mx
//   2. command copies   Workers Analytics Engine dataset weft_site_events (site/worker.js)
//   3. npm downloads    api.npmjs.org, @celador/weft, per day
//   4. first runs       new hosted spaces per day, GET weft-hosted.elier.ai/v1/admin/stats
//
// Usage: node site/funnel.mjs [days=7] [--json] [--alert [--seed]]
//   --json    machine-readable report on stdout
//   --alert   print nothing unless a launch-relevant change happened since the last --alert
//             run (state: ~/.config/weft/funnel-alert-state.json). For the daily cron.
//   --seed    with --alert: record the current state without printing (first install).
//
// Cloudflare auth, first that works: macOS keychain item `weft-funnel-cf-token` (Account
// Analytics: Read) -> CLOUDFLARE_API_TOKEN -> the local `wrangler login` OAuth token (refreshed
// with `wrangler whoami` when expired). Hosted admin key: ~/.config/weft/hosted-admin-token.
// Never prints a token.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
export const RUM_SITE_TAG = "78447487cc6640c8b09d69ae840f73eb"; // Web Analytics site for weft.mx (beacon in site/public/index.html)
// Before 2026-10-22 the site was weft-site.elier.ai and only the shared elier.ai Web Analytics site saw it.
export const RUM_OLD_SITE_TAG = "1252e968fb704c7380d01ee4c3cbb1a2";
export const SITE_HOSTS = ["weft.mx", "www.weft.mx", "weft-site.elier.ai"];
export const NPM_PACKAGE = "@celador/weft";
export const HOSTED = "https://weft-hosted.elier.ai";
const CF = "https://api.cloudflare.com/client/v4";
const HOME = homedir();
const WRANGLER_CONFIGS = [
  `${HOME}/Library/Preferences/.wrangler/config/default.toml`,
  `${HOME}/.wrangler/config/default.toml`,
  `${HOME}/.config/.wrangler/config/default.toml`,
];
export const STATE_FILE = process.env.WEFT_FUNNEL_STATE || `${HOME}/.config/weft/funnel-alert-state.json`;
export const METRICS = ["visits", "copies", "downloads", "firstRuns"];
const LABEL = { visits: "site visits", copies: "command copies", downloads: "npm downloads", firstRuns: "first runs" };
// A spike also needs at least this many on the day, so 1 -> 3 on a quiet week stays silent.
export const SPIKE_FLOOR = { visits: 50, copies: 10, downloads: 50, firstRuns: 5 };
export const FIRST_RUN_MILESTONES = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ---------- pure helpers (tested in site/funnel.test.mjs) ----------

export function dayList(days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Launch-relevant changes between the previous alert state and this report. Pure. */
export function detectAlerts(report, state = {}) {
  const alerted = new Set(state.alerted ?? []);
  const seen = { ...(state.seenNonzero ?? {}) };
  const out = [];
  const add = (key, msg) => { if (!alerted.has(key)) { alerted.add(key); out.push(msg); } };
  for (const m of METRICS) {
    const series = report.daily.map((d) => ({ day: d.day, n: d[m] })).filter((x) => typeof x.n === "number");
    const total = series.reduce((a, x) => a + x.n, 0);
    if (total > 0 && !seen[m]) {
      seen[m] = true;
      const first = series.find((x) => x.n > 0);
      add(`first:${m}`, `First ${LABEL[m]}: ${first.n} on ${first.day} (${total} in the last ${report.days}d).`);
    }
    // Spike: a day with >= 10x the average of the 7 days before it (and at or above the floor).
    for (let i = 1; i < series.length; i++) {
      const prev = series.slice(Math.max(0, i - 7), i);
      const avg = prev.reduce((a, x) => a + x.n, 0) / 7;
      const { day, n } = series[i];
      if (n >= SPIKE_FLOOR[m] && n >= 10 * avg) add(`spike:${m}:${day}`, `${LABEL[m]} spike: ${n} on ${day} (7-day average before it: ${avg.toFixed(1)}).`);
    }
  }
  const spaces = report.totals.hostedSpacesAllTime;
  if (typeof spaces === "number") for (const t of FIRST_RUN_MILESTONES) if (spaces >= t) add(`milestone:firstRuns:${t}`, `Hosted spaces passed ${t} (now ${spaces} all-time).`);
  return { alerts: out, state: { alerted: [...alerted].sort(), seenNonzero: seen } };
}

export function formatReport(r) {
  const n = (x) => (x === null || x === undefined ? "-" : String(x));
  const lines = [`Weft launch funnel, last ${r.days}d (UTC days)`, "", "day         visits  copies  npm  first-runs"];
  for (const d of r.daily) lines.push(`${d.day}  ${n(d.visits).padStart(6)}  ${n(d.copies).padStart(6)}  ${n(d.downloads).padStart(3)}  ${n(d.firstRuns).padStart(10)}`);
  const t = r.totals;
  const pct = (a, b, of) => (a && b ? ` (${((100 * a) / b).toFixed(1)}% of ${of})` : "");
  lines.push("", `totals: ${n(t.visits)} visits -> ${n(t.copies)} copies${pct(t.copies, t.visits, "visits")} -> ${n(t.downloads)} npm downloads -> ${n(t.firstRuns)} first runs${pct(t.firstRuns, t.visits, "visits")}`);
  if (Object.keys(r.copiesBy).length) lines.push(`copies by source/placement: ${Object.entries(r.copiesBy).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (Object.keys(r.viewsBySource).length) lines.push(`page views (AE) by source: ${Object.entries(r.viewsBySource).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (typeof t.hostedSpacesAllTime === "number") lines.push(`hosted spaces all-time: ${t.hostedSpacesAllTime}`);
  for (const w of r.notes) lines.push(`note: ${w}`);
  return lines.join("\n");
}

// ---------- sources ----------

function keychainToken() {
  if (process.platform !== "darwin") return null;
  try { return execFileSync("security", ["find-generic-password", "-s", "weft-funnel-cf-token", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { return null; }
}

function wranglerToken() {
  const read = () => {
    for (const p of WRANGLER_CONFIGS) {
      try {
        const t = readFileSync(p, "utf8");
        const tok = t.match(/^oauth_token = "(.+)"/m)?.[1];
        if (tok) return { tok, exp: Date.parse(t.match(/^expiration_time = "(.+)"/m)?.[1] ?? "") || 0 };
      } catch {}
    }
    return null;
  };
  let w = read();
  if (!w || w.exp < Date.now() + 60_000) {
    // `wrangler whoami` refreshes an expired OAuth token with the stored refresh token.
    const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
    try { execFileSync("npx", ["--yes", "wrangler@latest", "whoami"], { env, stdio: "ignore", timeout: 120_000 }); } catch {}
    w = read();
  }
  return w?.tok ?? null;
}

/** Tries each credential in order; returns the first one that works on Analytics Engine. */
async function cloudflare(notes) {
  const candidates = [
    ["keychain weft-funnel-cf-token", keychainToken],
    ["CLOUDFLARE_API_TOKEN", () => process.env.CLOUDFLARE_API_TOKEN || null],
    ["wrangler OAuth", wranglerToken],
  ];
  const failures = [];
  for (const [source, get] of candidates) {
    const token = get();
    if (!token) continue;
    const r = await fetch(`${CF}/accounts/${ACCOUNT}/analytics_engine/sql`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "SELECT 1 AS ok" });
    if (r.ok) {
      if (failures.length) notes.push(`Cloudflare auth: ${failures.join("; ")}; used ${source}`);
      return { source, token };
    }
    failures.push(`${source} HTTP ${r.status}`);
  }
  throw new Error(`no working Cloudflare credential (${failures.join("; ") || "none found"}). Fix: create an Account Analytics: Read token and run: security add-generic-password -U -a weft -s weft-funnel-cf-token -w`);
}

async function aeRows(cf, days) {
  const sql = `SELECT toDate(timestamp) AS day, blob1 AS event, blob2 AS placement, blob3 AS source, SUM(_sample_interval) AS n
FROM weft_site_events WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob3 != 'playwright'
GROUP BY day, event, placement, source ORDER BY day`;
  const r = await fetch(`${CF}/accounts/${ACCOUNT}/analytics_engine/sql`, { method: "POST", headers: { authorization: `Bearer ${cf.token}` }, body: sql });
  const text = await r.text();
  if (!r.ok) throw new Error(`Analytics Engine HTTP ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).data.map((x) => ({ ...x, n: Number(x.n) }));
}

async function rumVisits(cf, days) {
  // Web Analytics samples (10x) any query spanning more than 7 days, so ask in 7-day windows.
  const query = `query($a:String!,$t:[String!],$h:[String!],$d:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){rumPageloadEventsAdaptiveGroups(limit:5000,filter:{date_geq:$d,date_leq:$e,siteTag_in:$t,requestHost_in:$h}){sum{visits} dimensions{date siteTag}}}}}`;
  const groups = [];
  for (let i = 0; i < days.length; i += 7) {
    const w = days.slice(i, i + 7);
    const variables = { a: ACCOUNT, t: [RUM_SITE_TAG, RUM_OLD_SITE_TAG], h: SITE_HOSTS, d: w[0], e: w[w.length - 1] };
    const r = await fetch(`${CF}/graphql`, { method: "POST", headers: { authorization: `Bearer ${cf.token}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (!r.ok || j.errors?.length) throw new Error(`Web Analytics: ${JSON.stringify(j.errors ?? r.status).slice(0, 200)}`);
    groups.push(...(j.data.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups ?? []));
  }
  return rumByDay(groups);
}

/** Visits per day: the weft.mx site when it has data that day, else the old shared site (never both: on 2026-10-22 both beacons fired). */
export function rumByDay(groups) {
  const cur = {}, old = {};
  for (const g of groups) {
    const into = g.dimensions.siteTag === RUM_SITE_TAG ? cur : old;
    into[g.dimensions.date] = (into[g.dimensions.date] ?? 0) + g.sum.visits;
  }
  const by = {};
  for (const day of new Set([...Object.keys(cur), ...Object.keys(old)])) by[day] = cur[day] ?? old[day];
  return by;
}

async function npmDaily(since, until, notes) {
  const r = await fetch(`https://api.npmjs.org/downloads/range/${since}:${until}/${NPM_PACKAGE}`);
  const j = await r.json().catch(() => ({}));
  if (j.downloads) {
    if (j.end < until) notes.push(`npm stats end ${j.end} (npm publishes download counts with a 1-3 day lag)`);
    return { by: Object.fromEntries(j.downloads.map((d) => [d.day, d.downloads])), end: j.end };
  }
  // A package newer than npm's stats window is "not found" until its first day is indexed.
  const ref = await fetch("https://api.npmjs.org/downloads/point/last-day/npm").then((x) => x.json()).catch(() => ({}));
  notes.push(`npm has no download stats for ${NPM_PACKAGE} yet (${j.error ?? r.status}); npm's stats currently end ${ref.end ?? "?"} and the package was first published 2026-10-23`);
  return { by: {}, end: ref.end ?? null };
}

async function hostedStats(notes) {
  let key;
  try { key = readFileSync(`${HOME}/.config/weft/hosted-admin-token`, "utf8").trim(); } catch {}
  if (!key) { notes.push("first runs: no hosted admin key at ~/.config/weft/hosted-admin-token"); return null; }
  const r = await fetch(`${HOSTED}/v1/admin/stats`, { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) { notes.push(`first runs: ${HOSTED}/v1/admin/stats HTTP ${r.status}`); return null; }
  const j = await r.json();
  return { by: Object.fromEntries(j.days.map((d) => [d.day, d.spaces])), total: j.spaces.total };
}

export async function buildReport(days) {
  const notes = [];
  const list = dayList(days);
  const since = list[0], until = list[list.length - 1];
  const cf = await cloudflare(notes);
  const [ae, rum, npm, hosted] = await Promise.all([aeRows(cf, days), rumVisits(cf, list), npmDaily(since, until, notes), hostedStats(notes)]);
  const copiesBy = {}, viewsBySource = {}, copiesDay = {};
  for (const x of ae) {
    const day = String(x.day).slice(0, 10);
    if (x.event === "copy") {
      copiesDay[day] = (copiesDay[day] ?? 0) + x.n;
      const k = `${x.source || "direct"}/${x.placement || "?"}`;
      copiesBy[k] = (copiesBy[k] ?? 0) + x.n;
    } else if (x.event === "view") {
      const k = x.source || "unknown";
      viewsBySource[k] = (viewsBySource[k] ?? 0) + x.n;
    }
  }
  const daily = list.map((day) => ({
    day,
    visits: rum[day] ?? 0,
    copies: copiesDay[day] ?? 0,
    downloads: npm.end && day > npm.end ? null : (npm.by[day] ?? 0), // null = npm hasn't published that day yet
    firstRuns: hosted ? (hosted.by[day] ?? 0) : null,
  }));
  const sum = (m) => (daily.some((d) => typeof d[m] === "number") ? daily.reduce((a, d) => a + (d[m] ?? 0), 0) : null);
  return {
    days, generatedAt: new Date().toISOString(), cloudflareAuth: cf.source,
    daily,
    totals: { visits: sum("visits"), copies: sum("copies"), downloads: sum("downloads"), firstRuns: sum("firstRuns"), hostedSpacesAllTime: hosted?.total ?? null },
    copiesBy: Object.fromEntries(Object.entries(copiesBy).sort((a, b) => b[1] - a[1])),
    viewsBySource: Object.fromEntries(Object.entries(viewsBySource).sort((a, b) => b[1] - a[1])),
    notes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const num = args.find((a) => /^\d+$/.test(a));
  const days = Math.max(2, Math.min(90, Number(num ?? (flag("--alert") ? 14 : 7))));
  const report = await buildReport(days);
  if (flag("--alert")) {
    let state = {};
    try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch {}
    const { alerts, state: next } = detectAlerts(report, state);
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...next, updatedAt: report.generatedAt }, null, 2));
    if (alerts.length && !flag("--seed")) console.log(`Weft launch funnel:\n- ${alerts.join("\n- ")}\n\n${formatReport(report)}`);
    return;
  }
  console.log(flag("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`funnel: ${e.message}`); process.exit(1); });
}
