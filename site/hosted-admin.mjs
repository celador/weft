#!/usr/bin/env node
// Operator tool for the hosted gateway's retention metrics (counts only). The admin key comes from
// the macOS keychain (`weft-hosted-admin`, never a file) and is never printed.
//
//   node site/hosted-admin.mjs spaces                  every space: created, last event, active days (30d), internal flag
//   node site/hosted-admin.mjs tag <space-id>... [--off]   mark spaces internal (our own tests/demos); --off clears the tag
//
// Tagged spaces are left out of GET /v1/admin/stats headline numbers and out of site/funnel.mjs.
import { fileURLToPath } from "node:url";
import { HOSTED } from "./funnel.mjs";
import { readHostedAdminToken, TOKEN_HELP } from "./admin-token.mjs";

const SPACE_ID = /^sp[a-z0-9]{10}$/;

/** Runs one command; returns the process exit code. Everything is injectable for tests. */
export async function run(argv, { fetchFn = fetch, readToken = readHostedAdminToken, base = HOSTED, out = (m) => console.log(m), err = (m) => console.error(m) } = {}) {
  const [cmd, ...rest] = argv;
  const off = rest.includes("--off");
  const ids = rest.filter((a) => !a.startsWith("--"));
  if (cmd !== "spaces" && cmd !== "tag") { err("usage: hosted-admin.mjs spaces | tag <space-id>... [--off]"); return 2; }
  if (cmd === "tag" && (!ids.length || ids.some((i) => !SPACE_ID.test(i)))) { err("tag: give one or more space ids (sp + 10 lowercase letters/digits)"); return 2; }
  const key = readToken()?.token;
  if (!key) { err(TOKEN_HELP); return 1; }
  const call = (method, path, body) => fetchFn(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

  if (cmd === "spaces") {
    const r = await call("GET", "/v1/admin/stats");
    if (!r.ok) { err(`stats: HTTP ${r.status}`); return 1; }
    const j = await r.json();
    if (!j.retention) { err("this gateway has no retention stats yet (deploy the gateway first)"); return 1; }
    out("id            created     last event            days30  internal  label");
    for (const s of j.retention.spaces) out(`${s.id}  ${s.created.slice(0, 10)}  ${(s.last_event_at ?? "-").slice(0, 19).padEnd(19)}  ${String(s.active_days_30).padStart(6)}  ${(s.internal ? "yes" : "").padEnd(8)}  ${s.label ?? ""}`);
    return 0;
  }
  let failed = 0;
  for (const id of ids) {
    const r = await call("POST", `/v1/admin/spaces/${id}/tag`, { internal: !off });
    if (r.ok) out(`${id}: ${off ? "internal tag cleared" : "tagged internal"}`);
    else { failed++; err(`${id}: HTTP ${r.status}`); }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`hosted-admin: ${e.message}`); process.exit(1); });
}
