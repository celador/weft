#!/usr/bin/env node
// Site funnel counts from Workers Analytics Engine (dataset weft_site_events, written by
// site/worker.js). Usage: node site/funnel.mjs [days=7]
// Auth: CLOUDFLARE_API_TOKEN (Account Analytics: Read), else the local `wrangler login` token.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
const days = Math.max(1, Math.min(90, Number(process.argv[2] ?? 7) || 7));
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  for (const p of [`${homedir()}/Library/Preferences/.wrangler/config/default.toml`, `${homedir()}/.wrangler/config/default.toml`, `${homedir()}/.config/.wrangler/config/default.toml`]) {
    try { token = readFileSync(p, "utf8").match(/^oauth_token = "(.+)"/m)?.[1]; if (token) break; } catch {}
  }
}
if (!token) { console.error("No token: set CLOUDFLARE_API_TOKEN or run `npx wrangler login`."); process.exit(1); }

const sql = `SELECT toDate(timestamp) AS day, blob1 AS event, blob3 AS source, SUM(_sample_interval) AS n
FROM weft_site_events WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob3 != 'playwright'
GROUP BY day, event, source ORDER BY day, event, n DESC`;
const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: sql,
});
const text = await r.text();
if (!r.ok) { console.error(`HTTP ${r.status}: ${text.slice(0, 300)}`); process.exit(1); }
const rows = JSON.parse(text).data;
console.log("day         event  n      source");
for (const x of rows) console.log(`${x.day}  ${x.event.padEnd(5)}  ${String(x.n).padEnd(5)}  ${x.source}`);
const sum = (e) => rows.filter((x) => x.event === e).reduce((a, x) => a + Number(x.n), 0);
const v = sum("view"), c = sum("copy");
console.log(`\nlast ${days}d: ${v} page views, ${c} command copies (${v ? ((100 * c) / v).toFixed(1) : 0}% of views)`);
