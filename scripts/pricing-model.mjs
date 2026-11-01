#!/usr/bin/env node
// The hosted cost model behind docs/pricing.md. Prints the per-event cost, the margin at list
// price for a few workloads, and the example bills. Every input is a constant below with its
// source; change one and rerun. Node 22+, no dependencies.
//
//   node scripts/pricing-model.mjs            # tables
//   node scripts/pricing-model.mjs --json     # the same numbers as JSON

// ---- Cloudflare list prices (Workers Paid), retrieved 2026-11-01
//   https://developers.cloudflare.com/workers/platform/pricing/            (Workers, CPU)
//   https://developers.cloudflare.com/durable-objects/platform/pricing/    (DO requests, duration, SQLite)
// Included monthly allotments are ignored on purpose: this is the marginal cost at scale.
export const CF = {
  worker_request: 0.3 / 1e6, // $ per request
  worker_cpu_ms: 0.02 / 1e6, // $ per CPU ms
  do_request: 0.15 / 1e6, // $ per DO request (HTTP / RPC session / alarm)
  do_gb_s: 12.5 / 1e6, // $ per GB-s of wall-clock duration (128 MB billed)
  rows_read: 0.001 / 1e6, // $ per row read
  rows_written: 1.0 / 1e6, // $ per row written (index and delete rows included)
  stored_gb_month: 0.2, // $ per GB-month of SQLite storage
};

// ---- Measured per unit of work (see "How the numbers were measured" in docs/pricing.md)
export const MEASURED = {
  // One edit = one `check` submit + one `commit` submit = ONE billable event. Counted with
  // SqlStorage rowsRead / rowsWritten around RepoCoordinator.submit in the gateway test runtime.
  edit_rows_read: 93.1,
  edit_rows_written: 28.55,
  drain_rows_read: 39,
  drain_rows_written: 3,
  heartbeat_rows_read: 56,
  heartbeat_rows_written: 22,
  // weft-hosted, last 30 days (Cloudflare GraphQL Analytics, 2026-11-01): DO duration per request.
  repo_do_gb_s_per_request: 160.1 / 7532,
  registry_do_gb_s_per_request: 69.4 / 7547,
  worker_cpu_ms_per_request: 1.1, // p50
};

// ---- Assumptions (labelled; not measured)
export const ASSUME = {
  requests_per_event: 3, // check + commit + one inbox drain
  do_requests_per_request: 2, // the repo DO, plus a Registry call (grant cache is 5 s, so this is pessimistic)
  meter_flush_do_requests_per_event: 1, // one coalesced Registry write per event at worst
  stored_kb_per_event: 3, // events row + event_writes + idempotency row + indexes
  retention_months: 12, // how long an event is kept in the hosted log (upper bound)
  heartbeat_seconds: 30, // coordinator default heartbeat_interval_ms
  stripe_percent: 0.029, // Stripe card fee, US cards
  stripe_fixed: 0.3, // per charge
};

const usd = (n, d = 6) => `$${n.toFixed(d)}`;

/** Marginal cost of one billable event (an edit/claim/land appended to the log), excluding heartbeats. */
export function eventCost() {
  const reqs = ASSUME.requests_per_event;
  const rowsW = MEASURED.edit_rows_written + MEASURED.drain_rows_written;
  const rowsR = MEASURED.edit_rows_read + MEASURED.drain_rows_read;
  const parts = {
    sqlite_rows_written: rowsW * CF.rows_written,
    sqlite_rows_read: rowsR * CF.rows_read,
    worker_requests: reqs * CF.worker_request,
    worker_cpu: reqs * MEASURED.worker_cpu_ms_per_request * CF.worker_cpu_ms,
    do_requests: (reqs * ASSUME.do_requests_per_request + ASSUME.meter_flush_do_requests_per_event) * CF.do_request,
    do_duration: reqs * (MEASURED.repo_do_gb_s_per_request + MEASURED.registry_do_gb_s_per_request) * CF.do_gb_s,
    storage: ((ASSUME.stored_kb_per_event * 1000) / 1e9) * ASSUME.retention_months * CF.stored_gb_month,
  };
  return { parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

/** Cost of keeping one agent session alive for an hour (heartbeats), whatever it does. */
export function agentHourCost() {
  const beats = 3600 / ASSUME.heartbeat_seconds;
  return (
    beats *
    (MEASURED.heartbeat_rows_written * CF.rows_written +
      MEASURED.heartbeat_rows_read * CF.rows_read +
      CF.worker_request +
      ASSUME.do_requests_per_request * CF.do_request +
      (MEASURED.repo_do_gb_s_per_request + MEASURED.registry_do_gb_s_per_request) * CF.do_gb_s)
  );
}

/** All-in cost per 1,000 events when an agent produces `perHour` events per live hour. */
export function costPer1000(perHour) {
  return 1000 * (eventCost().total + agentHourCost() / perHour);
}

// ---- The PROPOSAL (docs/pricing.md "pricing-config"; scripts/stripe-setup.mjs reads that block)
export const PROPOSAL = { free_events_per_month: 5000, usd_per_1000_events: 1.0 };

export function bill(events) {
  const over = Math.max(0, events - PROPOSAL.free_events_per_month);
  return { over, amount: (over / 1000) * PROPOSAL.usd_per_1000_events };
}

/** Margin on one monthly bill, before and after Stripe's card fee. Infra cost covers every event, free ones too. */
export function margin(events, perHour) {
  const { amount } = bill(events);
  const cost = (events / 1000) * costPer1000(perHour);
  const fee = amount > 0 ? amount * ASSUME.stripe_percent + ASSUME.stripe_fixed : 0;
  return { amount, cost, gross: amount > 0 ? (amount - cost) / amount : null, afterStripe: amount > 0 ? (amount - cost - fee) / amount : null };
}

export const SCENARIOS = [
  // agents x live hours per month x events per live hour
  { name: "solo dev", agents: 1, hours: 100, perHour: 25 },
  { name: "5-agent team", agents: 5, hours: 100, perHour: 25 },
  { name: "50-agent team", agents: 50, hours: 100, perHour: 25 },
];

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const ev = eventCost();
  const out = {
    per_event: Object.fromEntries(Object.entries(ev.parts).map(([k, v]) => [k, v])),
    per_event_total: ev.total,
    per_agent_hour_heartbeats: agentHourCost(),
    cost_per_1000: Object.fromEntries([5, 10, 25, 60, 120].map((h) => [`${h}/h`, costPer1000(h)])),
    proposal: PROPOSAL,
    scenarios: SCENARIOS.map((s) => {
      const events = s.agents * s.hours * s.perHour;
      return { ...s, events, ...bill(events), ...margin(events, s.perHour) };
    }),
    margin_at_list_price: Object.fromEntries([5, 10, 25, 60, 120].map((h) => [`${h}/h`, 1 - costPer1000(h) / PROPOSAL.usd_per_1000_events])),
  };
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log("marginal cost of one billable event (an edit, claim or land appended to the log)");
    for (const [k, v] of Object.entries(ev.parts)) console.log(`  ${k.padEnd(20)} ${usd(v, 8)}`);
    console.log(`  ${"TOTAL".padEnd(20)} ${usd(ev.total, 8)}  = ${usd(ev.total * 1000, 4)} per 1,000 events`);
    console.log(`\nheartbeats: ${usd(agentHourCost(), 5)} per live agent-hour (one beat every ${ASSUME.heartbeat_seconds} s)`);
    console.log("\nall-in cost per 1,000 events, by how busy an agent is, and gross margin at the proposed list price");
    for (const h of [5, 10, 25, 60, 120]) console.log(`  ${String(h).padStart(4)} events/agent-hour  cost ${usd(costPer1000(h), 4)}  margin ${(100 * (1 - costPer1000(h) / PROPOSAL.usd_per_1000_events)).toFixed(0)}%`);
    console.log(`\nPROPOSAL: ${PROPOSAL.free_events_per_month} free events/month, then ${usd(PROPOSAL.usd_per_1000_events, 2)} per 1,000`);
    for (const s of out.scenarios)
      console.log(
        `  ${s.name.padEnd(14)} ${String(s.events).padStart(7)} events  billed ${String(s.over).padStart(7)}  bill $${s.amount.toFixed(2).padStart(7)}  infra cost $${s.cost.toFixed(2)}  margin ${s.gross === null ? "n/a (free)" : `${(100 * s.gross).toFixed(0)}% (${(100 * s.afterStripe).toFixed(0)}% after Stripe fee)`}`,
      );
  }
}
