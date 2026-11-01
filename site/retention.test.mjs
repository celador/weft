// node --test site/retention.test.mjs   (retention lines of the funnel, the admin-key helper, the operator CLI; no network)
import assert from "node:assert/strict";
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

test("admin key: keychain first, then the old file, neither -> null; keychain is skipped off macOS", () => {
  const kc = () => "from-keychain", file = () => "from-file", none = () => null;
  assert.deepEqual(readHostedAdminToken({ platform: "darwin", fromKeychain: kc, fromFile: file }), { token: "from-keychain", source: "keychain weft-hosted-admin" });
  assert.deepEqual(readHostedAdminToken({ platform: "darwin", fromKeychain: none, fromFile: file }), { token: "from-file", source: "~/.config/weft/hosted-admin-token" });
  assert.equal(readHostedAdminToken({ platform: "darwin", fromKeychain: none, fromFile: none }), null);
  const seen = [];
  readHostedAdminToken({ platform: "linux", fromKeychain: (p) => { seen.push(p); return null; }, fromFile: file });
  assert.deepEqual(seen, ["linux"]); // the real keychain reader returns null for non-darwin
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
