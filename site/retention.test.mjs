// node --test site/retention.test.mjs   (retention lines of the funnel, the admin-key helper, the operator CLI; no network)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { detectAlerts, formatReport, hostedStats, parseRetention, RETAINED_MILESTONES } from "./funnel.mjs";
import { readHostedAdminToken } from "./admin-token.mjs";
import { run } from "./hosted-admin.mjs";

const KEY = "weft_SECRETSECRETSECRETSECRET";
const STATS = {
  type: "stats",
  days: [{ day: "2026-11-02", spaces: 1 }],
  spaces: { total: 2, active: 2 },
  retention: {
    active_7d: 2, active_30d: 3, retained: 1, internal_spaces: 27, spaces_total: 3,
    events_per_day: [{ day: "2026-11-01", events: 5 }, { day: "2026-11-02", events: 7 }],
    spaces: [
      { id: "spaaaaaaaaaa", label: "mine", status: "active", created: "2026-10-22T10:00:00.000Z", last_event_at: "2026-11-02T09:00:00.000Z", active_days_30: 9, internal: true },
      { id: "spbbbbbbbbbb", status: "active", created: "2026-10-30T10:00:00.000Z", last_event_at: "2026-11-01T08:00:00.000Z", active_days_30: 2 },
      { id: "spcccccccccc", label: "x", status: "active", created: "2026-10-29T10:00:00.000Z", last_event_at: null, active_days_30: 0 },
    ],
  },
};
const jsonFetch = (status, body, seen = []) => async (url, init) => { seen.push({ url, init }); return { ok: status < 300, status, json: async () => body }; };
const tok = (token = KEY) => () => ({ token, source: "test" });

const report = (retention, spaces = 2) => ({
  days: 2,
  daily: [{ day: "2026-11-01", visits: 0, copies: 0, downloads: 0, firstRuns: 0 }, { day: "2026-11-02", visits: 0, copies: 0, downloads: 0, firstRuns: 0 }],
  totals: { visits: 0, copies: 0, downloads: 0, firstRuns: 1, hostedSpacesAllTime: spaces },
  retention, copiesBy: {}, viewsBySource: {}, notes: [],
});

test("hostedStats sends the admin key and parses the retention block (internal spaces left out of lastEventAt)", async () => {
  const seen = [], notes = [];
  const h = await hostedStats(notes, { readToken: tok(), fetchFn: jsonFetch(200, STATS, seen), base: "https://gw.test" });
  assert.equal(seen[0].url, "https://gw.test/v1/admin/stats");
  assert.equal(seen[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(h.by, { "2026-11-02": 1 });
  assert.equal(h.total, 2);
  assert.deepEqual({ ...h.retention, spaces: undefined }, { active7: 2, active30: 3, retained: 1, internalSpaces: 27, eventsByDay: { "2026-11-01": 5, "2026-11-02": 7 }, lastEventAt: "2026-11-01T08:00:00.000Z", spaces: undefined });
  assert.deepEqual(notes, []);
});

test("an older gateway without retention still gives first runs; no key or HTTP errors become notes", async () => {
  const { retention, ...old } = STATS;
  const h = await hostedStats([], { readToken: tok(), fetchFn: jsonFetch(200, old) });
  assert.equal(h.total, 2);
  assert.equal(h.retention, null);
  assert.equal(parseRetention(undefined), null);
  const n1 = [], n2 = [];
  assert.equal(await hostedStats(n1, { readToken: () => null, fetchFn: jsonFetch(200, STATS) }), null);
  assert.match(n1[0], /keychain|weft-hosted-admin/);
  assert.equal(await hostedStats(n2, { readToken: tok(), fetchFn: jsonFetch(401, {}) }), null);
  assert.match(n2[0], /HTTP 401/);
});

test("formatReport prints the retention lines after the hosted-spaces line, with counts only", () => {
  const r = report(parseRetention(STATS.retention));
  const out = formatReport(r);
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("hosted spaces all-time: 2"));
  assert.ok(at > 0);
  assert.equal(lines[at + 1], "hosted retention: 2 active in 7d, 3 in 30d, 1 retained (events on 2+ days, one in the last 7d); 27 internal spaces left out");
  assert.equal(lines[at + 2], "hosted last event (outside internal spaces): 2026-11-01T08:00:00.000Z");
  assert.equal(lines[at + 3], "hosted events/day: 11-01 5, 11-02 7");
  assert.ok(lines.findIndex((l) => l.startsWith("totals:")) < at);
  assert.doesNotMatch(out, /spbbbbbbbbbb|mine|SECRET/);
  assert.doesNotMatch(formatReport(report(null)), /retention/);
  assert.match(formatReport(report({ ...parseRetention(STATS.retention), lastEventAt: null })), /last event \(outside internal spaces\): none yet/);
});

test("--alert semantics: silent without retention or activity; first active space and each retained milestone fire once", () => {
  const none = parseRetention({ active_7d: 0, active_30d: 0, retained: 0, internal_spaces: 27, events_per_day: [], spaces: [] });
  const seeded = detectAlerts(report(none, 0));
  assert.deepEqual(seeded.alerts, []);
  assert.deepEqual(detectAlerts(report(null, 0), seeded.state).alerts, []); // gateway/key unavailable: never alerts

  const active = parseRetention({ ...STATS.retention, retained: 0 });
  const a = detectAlerts(report(active, 0), seeded.state);
  assert.equal(a.alerts.length, 1);
  assert.match(a.alerts[0], /^First active hosted space .*2 active in 7d, 3 in 30d/);
  assert.deepEqual(detectAlerts(report(active, 0), a.state).alerts, []); // same state: nothing

  const kept = parseRetention({ ...STATS.retention, retained: 3 });
  const b = detectAlerts(report(kept, 0), a.state);
  assert.deepEqual(b.alerts, ["Retained hosted spaces passed 1 (now 3: events on 2+ days, one in the last 7 days).", "Retained hosted spaces passed 3 (now 3: events on 2+ days, one in the last 7 days)."]);
  assert.deepEqual(detectAlerts(report(kept, 0), b.state).alerts, []);
  // falling back and recovering does not repeat an alert
  assert.deepEqual(detectAlerts(report(parseRetention({ ...STATS.retention, retained: 0, active_7d: 0 }), 0), b.state).alerts, []);
  assert.deepEqual(detectAlerts(report(kept, 0), b.state).alerts, []);
  assert.ok(RETAINED_MILESTONES.includes(1));
});

test("admin key: the keychain, else $WEFT_HOSTED_ADMIN_TOKEN, neither -> null; never a file; keychain is skipped off macOS", () => {
  const kc = () => "from-keychain", none = () => null;
  assert.deepEqual(readHostedAdminToken({ platform: "darwin", fromKeychain: kc, env: { WEFT_HOSTED_ADMIN_TOKEN: "from-env" } }), { token: "from-keychain", source: "keychain weft-hosted-admin" });
  assert.deepEqual(readHostedAdminToken({ platform: "darwin", fromKeychain: none, env: { WEFT_HOSTED_ADMIN_TOKEN: " from-env \n" } }), { token: "from-env", source: "$WEFT_HOSTED_ADMIN_TOKEN" });
  assert.equal(readHostedAdminToken({ platform: "darwin", fromKeychain: none, env: {} }), null);
  const seen = [];
  readHostedAdminToken({ platform: "linux", fromKeychain: (p) => { seen.push(p); return null; }, env: {} });
  assert.deepEqual(seen, ["linux"]); // the real keychain reader returns null for non-darwin
});

test("no operator script reads ~/.config/weft/hosted-admin-token any more (finding #8)", () => {
  for (const f of ["admin-token.mjs", "funnel.mjs", "hosted-admin.mjs"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.ok(!/readFileSync\([^)]*hosted-admin-token/.test(src), f);
    assert.ok(!src.includes("TOKEN_FILE"), f);
  }
});

test("hosted-admin: tag posts {internal:true} per space with the key; --off clears; bad ids and failures exit non-zero", async () => {
  const seen = [], out = [], err = [];
  const io = (status) => ({ fetchFn: async (url, init) => { seen.push({ url, init }); return { ok: status < 300, status, json: async () => STATS }; }, readToken: tok(), base: "https://gw.test", out: (m) => out.push(m), err: (m) => err.push(m) });
  assert.equal(await run(["tag", "spaaaaaaaaaa", "spbbbbbbbbbb"], io(200)), 0);
  assert.deepEqual(seen.map((s) => [s.init.method, s.url, s.init.body]), [
    ["POST", "https://gw.test/v1/admin/spaces/spaaaaaaaaaa/tag", '{"internal":true}'],
    ["POST", "https://gw.test/v1/admin/spaces/spbbbbbbbbbb/tag", '{"internal":true}'],
  ]);
  assert.equal(seen[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(out, ["spaaaaaaaaaa: tagged internal", "spbbbbbbbbbb: tagged internal"]);
  seen.length = 0;
  assert.equal(await run(["tag", "spaaaaaaaaaa", "--off"], io(200)), 0);
  assert.equal(seen[0].init.body, '{"internal":false}');
  assert.equal(await run(["tag", "../etc"], io(200)), 2);
  assert.equal(await run(["tag"], io(200)), 2);
  assert.equal(await run(["tag", "spaaaaaaaaaa"], io(404)), 1);
  assert.match(err.at(-1), /spaaaaaaaaaa: HTTP 404/);
  assert.equal(await run(["spaces"], { ...io(200), readToken: () => null }), 1);
  assert.doesNotMatch([...out, ...err].join("\n"), /SECRET/);
});

test("hosted-admin spaces lists every space with the internal flag", async () => {
  const out = [];
  assert.equal(await run(["spaces"], { fetchFn: jsonFetch(200, STATS), readToken: tok(), out: (m) => out.push(m), err: () => {} }), 0);
  assert.equal(out.length, 4);
  assert.match(out[1], /^spaaaaaaaaaa  2026-10-22  2026-11-02T09:00:00 +9  yes +mine$/);
  assert.match(out[3], /^spcccccccccc  2026-10-29  - +0 +x$/);
  assert.doesNotMatch(out.join("\n"), /SECRET/);
  const { retention, ...old } = STATS;
  assert.equal(await run(["spaces"], { fetchFn: jsonFetch(200, old), readToken: tok(), out: () => {}, err: () => {} }), 1);
});

test("hosted-admin: billing lists paid spaces with seats, interval, events and the fair-use flag", async () => {
  const lines = [];
  const body = { spaces: [
    { id: "spaaaaaaaaaa", status: "active", plan: "paid", seats: 2, interval: "year", events_this_month: 120001, fair_use_exceeded_at: "2026-11-17T10:00:00.000Z" },
    { id: "spbbbbbbbbbb", status: "active", plan: "free", events_this_month: 10 },
    { id: "spcccccccccc", status: "active", plan: "paid", seats: 5, interval: "month", events_this_month: 300 },
  ] };
  const code = await run(["billing"], { base: "https://gw.test", readToken: () => ({ token: "k" }), fetchFn: async (url) => { assert.equal(url, "https://gw.test/v1/admin/spaces"); return new Response(JSON.stringify(body)); }, out: (l) => lines.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^spaaaaaaaaaa\s+2\s+year\s+120001\s+2026-11-17T10:00:00.000Z$/);
  assert.match(lines[3], /2 paid space\(s\), 7 Pro seat\(s\), 1 past fair use this month/);
});

test("hosted-admin: users joins Clerk users (email, created, last sign-in) with gateway accounts; the Clerk key goes only to api.clerk.com", async () => {
  const lines = [];
  const seen = [];
  const users = [
    { id: "user_2aaaaaaaaaa", primary_email_address_id: "e1", email_addresses: [{ id: "e1", email_address: "ana@example.com" }], created_at: Date.parse("2026-11-17T10:00:00Z"), last_sign_in_at: Date.parse("2026-11-17T12:00:00Z") },
    { id: "user_2bbbbbbbbbb", primary_email_address_id: "e2", email_addresses: [{ id: "e2", email_address: "bo@example.com" }], created_at: Date.parse("2026-11-16T10:00:00Z"), last_sign_in_at: null },
  ];
  const accounts = { accounts: [
    { id: "user_2aaaaaaaaaa", created_at: "2026-11-17T10:00:01Z", plan: "paid", seats: 2, interval: "month", spaces: 1, events_7d: 40, utm_campaign: "vid1" },
    { id: "user_2ccccccccccc", created_at: "2026-11-15T10:00:01Z", plan: "free", spaces: 0, events_7d: 0 },
  ] };
  const fetchFn = async (url, init) => {
    seen.push(`${url} ${init.headers.authorization}`);
    if (url.startsWith("https://api.clerk.com/")) return new Response(JSON.stringify(users));
    return new Response(JSON.stringify(accounts));
  };
  const code = await run(["users"], { base: "https://gw.test", readToken: () => ({ token: "admin-k" }), readClerk: () => "sk_test_clerk", fetchFn, out: (l) => lines.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.match(lines[1], /^ana@example\.com\s+2026-11-17\s+2026-11-17\s+Pro x2\/mo\s+1\s+40\s+vid1$/);
  assert.match(lines[2], /^bo@example\.com\s+2026-11-16\s+-\s+-\s+0\s+0\s+$/);
  assert.match(lines[3], /^\(no Clerk user\)/);
  assert.match(lines.at(-1), /3 user\(s\), 1 on Pro/);
  assert.deepEqual(seen.sort(), ["https://api.clerk.com/v1/users?limit=100&offset=0&order_by=-created_at Bearer sk_test_clerk", "https://gw.test/v1/admin/accounts Bearer admin-k"]);
  assert.doesNotMatch(lines.join("\n"), /sk_test_clerk|admin-k/);
  const csv = [];
  await run(["users", "--csv"], { base: "https://gw.test", readToken: () => ({ token: "admin-k" }), readClerk: () => "sk_test_clerk", fetchFn, out: (l) => csv.push(l), err: () => {} });
  assert.equal(csv[0], "email,created,last_sign_in,plan,spaces,events_7d,utm_campaign,clerk_user_id");
  assert.match(csv[1], /^"ana@example\.com","2026-11-17T10:00:00\.000Z"/);
  assert.equal(await run(["users"], { base: "https://gw.test", readToken: () => ({ token: "admin-k" }), readClerk: () => null, fetchFn, out: () => {}, err: () => {} }), 1);
});
