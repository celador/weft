#!/usr/bin/env node
// Operator tool for the hosted gateway's retention metrics (counts only). The admin key comes from
// the macOS keychain (`weft-hosted-admin`, never a file) and is never printed.
//
//   node site/hosted-admin.mjs spaces                  every space: created, last event, active days (30d), internal flag
//   node site/hosted-admin.mjs tag <space-id>... [--off]   mark spaces internal (our own tests/demos); --off clears the tag
//   node site/hosted-admin.mjs billing                 paid spaces: seats, interval, events this month, fair use (Weft Pro)
//   node site/hosted-admin.mjs users [--csv]           Weft accounts: email, created, last sign-in (from Clerk, read here
//                                                      with the Clerk secret key) joined with plan, seats, spaces and
//                                                      events in 7 days (from the gateway). For seeing and emailing sign-ups.
//
// The Clerk secret key is read on this machine only: $CLERK_SECRET_KEY, else the macOS keychain item
// `weft-clerk-secret-key` (account john). It is never printed and never sent anywhere but api.clerk.com.
// Tagged spaces are left out of GET /v1/admin/stats headline numbers and out of site/funnel.mjs.
import { fileURLToPath } from "node:url";
import { HOSTED } from "./funnel.mjs";
import { readHostedAdminToken, TOKEN_HELP } from "./admin-token.mjs";
import { execFileSync } from "node:child_process";

/** The Weft Clerk application's secret key: env, else the macOS keychain. Never printed. */
export function readClerkSecret(env = process.env) {
  if (env.CLERK_SECRET_KEY) return env.CLERK_SECRET_KEY.trim();
  if (process.platform !== "darwin") return null;
  try { return execFileSync("security", ["find-generic-password", "-s", "weft-clerk-secret-key", "-a", "john", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { return null; }
}

/** Every user of the Weft Clerk application (Backend API, paged): id, email, created, last sign-in. */
export async function clerkUsers(secret, fetchFn = fetch) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const r = await fetchFn(`https://api.clerk.com/v1/users?limit=100&offset=${offset}&order_by=-created_at`, { headers: { authorization: `Bearer ${secret}` } });
    if (!r.ok) throw new Error(`Clerk users: HTTP ${r.status}`);
    const page = await r.json();
    for (const u of page) {
      const email = (u.email_addresses ?? []).find((e) => e.id === u.primary_email_address_id)?.email_address ?? u.email_addresses?.[0]?.email_address ?? "";
      out.push({ id: u.id, email, created: u.created_at ? new Date(u.created_at).toISOString() : "", lastSignIn: u.last_sign_in_at ? new Date(u.last_sign_in_at).toISOString() : "" });
    }
    if (page.length < 100) return out;
  }
}

/** Clerk users joined with the gateway's accounts (by Clerk user id). Pure. */
export function joinUsers(users, accounts) {
  const byId = new Map((accounts ?? []).map((a) => [a.id, a]));
  const rows = users.map((u) => {
    const a = byId.get(u.id);
    byId.delete(u.id);
    return { ...u, plan: a ? (a.plan === "paid" ? `Pro x${a.seats ?? "?"}${a.interval === "year" ? "/yr" : "/mo"}` : "Free") : "-", spaces: a?.spaces ?? 0, events7d: a?.events_7d ?? 0, campaign: a?.utm_campaign ?? "" };
  });
  // Accounts whose Clerk user is gone (deleted in Clerk, not on weft.mx/account/): the operator should look at them.
  for (const a of byId.values()) rows.push({ id: a.id, email: "(no Clerk user)", created: a.created_at, lastSignIn: "", plan: a.plan === "paid" ? `Pro x${a.seats ?? "?"}` : "Free", spaces: a.spaces, events7d: a.events_7d, campaign: a.utm_campaign ?? "" });
  return rows;
}

const SPACE_ID = /^sp[a-z0-9]{10}$/;

/** Runs one command; returns the process exit code. Everything is injectable for tests. */
export async function run(argv, { fetchFn = fetch, readToken = readHostedAdminToken, readClerk = readClerkSecret, base = HOSTED, out = (m) => console.log(m), err = (m) => console.error(m) } = {}) {
  const [cmd, ...rest] = argv;
  const off = rest.includes("--off");
  const ids = rest.filter((a) => !a.startsWith("--"));
  if (cmd !== "spaces" && cmd !== "tag" && cmd !== "billing" && cmd !== "users") { err("usage: hosted-admin.mjs spaces | billing | users [--csv] | tag <space-id>... [--off]"); return 2; }
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
  if (cmd === "users") {
    const secret = readClerk();
    if (!secret) { err("users: no Clerk secret key. Set CLERK_SECRET_KEY, or store it: printf 'add-generic-password -U -a john -s weft-clerk-secret-key -w %s\\n' \"$KEY\" | security -i"); return 1; }
    const r = await call("GET", "/v1/admin/accounts");
    if (!r.ok && r.status !== 404) { err(`accounts: HTTP ${r.status}`); return 1; }
    const accounts = r.ok ? (await r.json()).accounts ?? [] : [];
    const rows = joinUsers(await clerkUsers(secret, fetchFn), accounts);
    if (rest.includes("--csv")) {
      out("email,created,last_sign_in,plan,spaces,events_7d,utm_campaign,clerk_user_id");
      for (const x of rows) out([x.email, x.created, x.lastSignIn, x.plan, x.spaces, x.events7d, x.campaign, x.id].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
      return 0;
    }
    out("email                               created     last sign-in  plan        spaces  events 7d  campaign");
    for (const x of rows) out(`${x.email.slice(0, 34).padEnd(34)}  ${x.created.slice(0, 10).padEnd(10)}  ${(x.lastSignIn.slice(0, 10) || "-").padEnd(12)}  ${x.plan.padEnd(10)}  ${String(x.spaces).padStart(6)}  ${String(x.events7d).padStart(9)}  ${x.campaign}`);
    out(`${rows.length} user(s), ${rows.filter((x) => x.plan.startsWith("Pro")).length} on Pro`);
    return 0;
  }
  if (cmd === "billing") {
    // Weft Pro: seats are an honor system and fair use (seats x 50,000 events a month) is a flag, never a cut-off.
    const r = await call("GET", "/v1/admin/spaces");
    if (!r.ok) { err(`spaces: HTTP ${r.status}`); return 1; }
    const paid = ((await r.json()).spaces ?? []).filter((s) => s.plan === "paid" && s.status === "active");
    out("id            seats  interval  events this month  fair use exceeded");
    for (const s of paid) out(`${s.id}  ${String(s.seats ?? "-").padStart(5)}  ${(s.interval ?? "legacy").padEnd(8)}  ${String(s.events_this_month ?? 0).padStart(17)}  ${s.fair_use_exceeded_at ?? ""}`);
    out(`${paid.length} paid space(s), ${paid.reduce((n, s) => n + (s.seats ?? 0), 0)} Pro seat(s), ${paid.filter((s) => s.fair_use_exceeded_at).length} past fair use this month`);
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
