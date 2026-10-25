// node --test site/funnel.test.mjs   (pure parts of site/funnel.mjs; no network)
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAlerts, dayList, formatReport, rumByDay, RUM_OLD_SITE_TAG, RUM_SITE_TAG } from "./funnel.mjs";

const report = (rows, spaces = null) => ({
  days: rows.length,
  daily: rows.map((r, i) => ({ day: `2026-11-${String(i + 1).padStart(2, "0")}`, visits: 0, copies: 0, downloads: 0, firstRuns: 0, ...r })),
  totals: { hostedSpacesAllTime: spaces },
  copiesBy: {}, viewsBySource: {}, notes: [],
});

test("dayList returns N UTC days ending today", () => {
  assert.deepEqual(dayList(3, new Date("2026-10-25T01:00:00Z")), ["2026-10-23", "2026-10-24", "2026-10-25"]);
});

test("all-zero report is silent", () => {
  assert.deepEqual(detectAlerts(report([{}, {}, {}])).alerts, []);
});

test("first nonzero first runs alerts once, then stays silent", () => {
  const r = report([{}, {}, { firstRuns: 1 }]);
  const a = detectAlerts(r);
  assert.equal(a.alerts.length, 1);
  assert.match(a.alerts[0], /First first runs: 1 on 2026-11-03/);
  assert.deepEqual(detectAlerts(r, a.state).alerts, []);
  // more first runs later are not "first" again
  assert.deepEqual(detectAlerts(report([{ firstRuns: 1 }, { firstRuns: 2 }]), a.state).alerts, []);
});

test("10x spike over the 7-day average alerts, only above the floor, once per day", () => {
  const quiet = Array.from({ length: 7 }, () => ({ visits: 10 }));
  const seeded = detectAlerts(report(quiet)).state;
  assert.deepEqual(detectAlerts(report([...quiet, { visits: 99 }]), seeded).alerts, []); // < 10x
  const a = detectAlerts(report([...quiet, { visits: 100 }]), seeded);
  assert.equal(a.alerts.length, 1);
  assert.match(a.alerts[0], /site visits spike: 100 on 2026-11-08 \(7-day average before it: 10.0\)/);
  assert.deepEqual(detectAlerts(report([...quiet, { visits: 100 }]), a.state).alerts, []);
  // tiny numbers stay silent: 0 -> 4 first runs is below the floor of 5
  const s2 = detectAlerts(report([{ firstRuns: 1 }])).state;
  assert.deepEqual(detectAlerts(report([{}, {}, {}, {}, {}, {}, {}, { firstRuns: 4 }]), s2).alerts, []);
});

test("missing data (null) never alerts", () => {
  assert.deepEqual(detectAlerts(report([{ downloads: null }, { downloads: null }])).alerts, []);
});

test("hosted-space milestones alert once each", () => {
  const seeded = detectAlerts(report([{ firstRuns: 17 }], 17)).state;
  const a = detectAlerts(report([{ firstRuns: 17 }, { firstRuns: 40 }], 57), seeded);
  assert.deepEqual(a.alerts.filter((x) => x.startsWith("Hosted")), ["Hosted spaces passed 25 (now 57 all-time).", "Hosted spaces passed 50 (now 57 all-time)."]);
  assert.deepEqual(detectAlerts(report([{ firstRuns: 1 }], 60), a.state).alerts, []);
});

test("rumByDay prefers the weft.mx site and never adds both beacons", () => {
  const g = (date, siteTag, visits) => ({ dimensions: { date, siteTag }, sum: { visits } });
  assert.deepEqual(rumByDay([g("2026-10-21", RUM_OLD_SITE_TAG, 22), g("2026-10-22", RUM_OLD_SITE_TAG, 41), g("2026-10-22", RUM_SITE_TAG, 40), g("2026-10-22", RUM_SITE_TAG, 15)]), { "2026-10-21": 22, "2026-10-22": 55 });
});

test("formatReport shows '-' for days npm hasn't published", () => {
  const out = formatReport({ ...report([{ visits: 3, downloads: null }]), totals: { visits: 3, copies: 0, downloads: null, firstRuns: 0, hostedSpacesAllTime: 0 } });
  assert.match(out, /2026-11-01 +3 +0 +- +0$/m);
  assert.match(out, /3 visits -> 0 copies -> - npm downloads -> 0 first runs/);
});
