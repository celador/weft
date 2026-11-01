# Hosted Weft: cost model and usage-based pricing

**Status: PROPOSAL.** Nothing here is live. Every price and allowance below is a proposal for John to
approve; the code reads them from configuration and stays inert until Stripe secrets are set on the
hosted gateway (see [Go-live checklist](#go-live-checklist-for-john)). Local and self-hosted Weft stay
free and open source. Pricing is **usage-based only: there is no per-developer, per-seat or
per-agent fee**, and nothing here depends on how many people or agents a team has.

Reproduce every number: `node scripts/pricing-model.mjs` (constants and sources are at the top of the file).

## 1. What a hosted space consumes

A hosted space (`npx @celador/weft` against `weft-hosted.elier.ai`) is a tenant on one Worker, `weft-hosted`
(`[env.hosted]` in `apps/gateway/wrangler.toml`): the gateway Worker, one `RepoCoordinator` Durable Object per
repo (the ordered log, SQLite storage) and one `Registry` Durable Object (spaces, keys). It has no D1, Artifacts,
Queues, Workflows, sandbox or containers, so none of those are consumed.

| Resource | Where it comes from | Billed by Cloudflare as |
|---|---|---|
| Worker requests | every WCP call: hello, submit, inbox drain, heartbeat, gate, feed reads | requests + CPU ms |
| Durable Object requests | one repo-DO call per WCP call; a Registry call to check the key (cached 5 s per key and isolate); one coalesced Registry write for usage metering | DO requests |
| DO duration | wall-clock time a DO is awake while handling those calls | GB-s (128 MB) |
| DO SQLite rows written | each submit appends to the log, the write index, the idempotency table, the input journal and their indexes; a heartbeat updates the session and the journal | rows written |
| DO SQLite rows read | conflict checks read the write index; observers read the log | rows read |
| DO SQLite storage | the event log, kept for the life of the space | GB-month |
| Rate Limiting binding | `WEFT_RATE` (600/min per space), `WEFT_SIGNUP_RATE` | no line item on the Workers pricing page |
| Analytics Engine | not used by the hosted gateway | n/a |

Cloudflare list prices (Workers Paid, retrieved 2026-11-01), the inputs of the model:

| | Price | Source |
|---|---|---|
| Worker requests | $0.30 / million (10 M/month included) | <https://developers.cloudflare.com/workers/platform/pricing/> |
| Worker CPU | $0.02 / million ms (30 M included) | same |
| DO requests | $0.15 / million (1 M included) | <https://developers.cloudflare.com/durable-objects/platform/pricing/> |
| DO duration | $12.50 / million GB-s (400 k included) | same |
| SQLite rows written | $1.00 / million (50 M included) | same |
| SQLite rows read | $0.001 / million (25 B included) | same |
| SQLite storage | $0.20 / GB-month (5 GB included) | same |
| Rate Limiting binding | no separate charge listed | <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/> |

The model uses the marginal price and ignores the included allotments, so it is what the 1,000,000th event costs,
not what today's traffic costs.

### How the numbers were measured

- **Rows per operation**: `SqlStorage` `rowsRead` / `rowsWritten` summed around `RepoCoordinator` calls in the
  gateway's Workers test runtime, 20 edits through the real gateway routes. One edit (a `check` submit then a `commit`
  submit) = 93.1 rows read, 28.6 rows written; an inbox drain = 39 / 3; a heartbeat = 56 / 22; hello = 28 / 14.
- **Duration and CPU per request**: Cloudflare GraphQL Analytics for `weft-hosted`, last 30 days (2026-11-01):
  10,468 Worker requests, CPU p50 1.1 ms (p99 5.7 ms); repo DO 160 GB-s over 7,532 requests (0.021 GB-s each);
  Registry DO 69 GB-s over 7,547 requests (0.009 GB-s each).
- **Today's hosted fleet** (`GET /v1/admin/stats`, `/v1/admin/spaces`): 29 spaces ever, 22 active, 51 repos, 132
  keys. At 10,468 requests a month it sits inside the Workers Paid inclusions, so the marginal spend today is $0
  beyond the $5 plan. There is no usage worth extrapolating from; the model is built from per-operation costs.
- **Assumed, not measured** (labelled in the script): 3 gateway requests per billable event (check, commit, one
  drain); 3 KB stored per event, kept 12 months; one heartbeat every 30 s while a session is live (the coordinator's
  default `heartbeat_interval_ms`).

### Cost per unit of work

| | Cost |
|---|---|
| one billable event (rows written $0.0000316, storage $0.0000072, requests, CPU, DO calls and duration the rest) | **$0.000042** |
| one live agent-hour of heartbeats (120 beats x 22 rows written dominate) | **$0.0028** |

Heartbeats cost as much as events for an agent that mostly waits, so the all-in cost per 1,000 events depends on how
busy an agent is:

| events per live agent-hour | all-in cost per 1,000 events | gross margin at $1.00 / 1,000 |
|---|---|---|
| 5 | $0.595 | 41% |
| 10 | $0.319 | 68% |
| **25 (reference workload)** | **$0.153** | **85%** |
| 60 | $0.088 | 91% |
| 120 | $0.065 | 93% |

The 70% target holds from about 11 events per agent-hour up. Below that the heartbeat is the cost. The lever is the
heartbeat, not the price: it writes 22 rows (session row, input journal, tick) for a 30-second liveness ping. Cutting it
to 5 rows lifts the 10-events/hour margin to about 90%. That is a coordinator change, not part of this card.

## 2. The billable meter

**Candidates**

| | Agent events | Landed changes |
|---|---|---|
| Unit | an event an agent appended to the log: an edit, claim, release or checkpoint; rejected ones count (they are in the log), accepting `check`s do not | a change landed on trunk |
| Customer understands it | yes: it is one line in the live feed | yes: it is a merged change |
| Tracks our cost | directly: cost is rows written per appended event | loosely: cost depends on events per change |
| Counted where | the gateway, on the submit verdict (`seq` assigned) | the lander's `land` event |
| Cost of one unit | $0.000042 + heartbeat share, about $0.00015 at the reference workload | 20 events per change (assumed) = $0.0031 |
| Price that holds 70% | $0.50 per 1,000 at the reference workload; $1.00 covers 11 events/agent-hour | $0.0102 per change at 20 events/change |
| If a change is 2x bigger than assumed (40 events) | unchanged | the same price drops to 40% margin |
| Abandoned and best-of-N attempts that never land | billed, they cost the same | free, but they cost |

Cost spread: the cost of a landed change swings 4x with its size (10 to 40 events: $0.0015 to $0.0061), so a flat
price per change cannot hold a margin. The cost of an event swings with agent activity only through the heartbeat, a
smaller effect. **Chosen meter: agent events.** Landed changes stay visible in the feed but are not billed.

Counting rules (implemented in `apps/gateway/src/billing.ts` and the gateway's submit route):

- one unit per agent submit whose verdict carries a `seq`, i.e. an event that entered the log;
- hello, heartbeat, inbox drain, gate, accepting `check`s, human actions, lander (system) writes and feed reads are
  free;
- the calendar month is UTC; the counter is per space; nothing in it identifies a person or a repo.

## 3. PROPOSAL: allowance, price, example bills

| | Proposal |
|---|---|
| Free monthly allowance on hosted | **5,000 events per space** (resets 1st of each month, UTC) |
| Price above the allowance | **$1.00 per 1,000 events** ($0.001 each, billed monthly in arrears, per-event precision) |
| Free plan over the allowance | writes get `429 over_allowance`; agents keep working uncoordinated and are told so |
| Paid plan | never cut off by the allowance; the abuse rate limits stay |
| Seats, agents, repos, people | not priced |
| Local / self-hosted | free, open source, no limits from us |

Why 5,000: at the reference workload one agent would need about 200 live hours in a month to hit it, so a solo dev
or a team trying Weft for a week never pays and never sees a limit. Worst case for us if a space burns the whole
allowance: $0.76 of infrastructure.

Example bills (agents x live hours per month x 25 events per hour; every figure is a PROPOSAL):

| | events / month | billed events | **monthly bill** | infra cost | gross margin (after Stripe's 2.9% + 30c) |
|---|---|---|---|---|---|
| Solo dev, 1 agent, 100 h | 2,500 | 0 | **$0.00** | $0.38 | free tier |
| 5-agent team, 100 h each | 12,500 | 7,500 | **$7.50** | $1.91 | 75% (68%) |
| 50-agent team, 100 h each | 125,000 | 120,000 | **$120.00** | $19.08 | 84% (81%) |

Open points for John, not decided here:

1. **Small invoices.** Stripe's 30c fixed fee takes about 40% of a $0.75 bill. A monthly minimum would fix it but is a
   fee by another name; the proposal has none.
2. **$1.00 vs $1.50 per 1,000.** $1.50 holds 70% down to 7 events per agent-hour without touching the heartbeat.
3. **Allowance size.** Doubling it to 10,000 costs us at most $1.50 per free space per month.

The machine-readable copy below is what `scripts/stripe-setup.mjs` creates in Stripe and what the gateway's
`WEFT_FREE_EVENTS` default must equal (a unit test checks both).

```json pricing-config
{
  "product_name": "Weft hosted",
  "meter_display_name": "Weft agent events",
  "meter_event_name": "weft_agent_events",
  "free_events_per_month": 5000,
  "usd_per_1000_events": 1.0,
  "currency": "usd"
}
```

## 4. How billing works (implementation)

All of it lives in the hosted gateway (`apps/gateway/src/billing.ts`, Registry tables in `registry.ts`) and is **off
until three secrets are set**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` (plus the optional
var `STRIPE_METER_EVENT_NAME`). With any of them missing: the billing routes answer `503 unavailable`, no allowance
is enforced, no Stripe call is made. Usage is still counted so `GET /v1/space` and `weft usage` have real numbers.

- **Registry** keeps, per space: `plan` (`free` | `paid`), `allowance` (nullable override of the default),
  `stripe_customer_id` (nothing else about the customer: Stripe Checkout collects email and card and keeps them),
  and a per-month usage row (`events`, `reported`, a pending report window). A `stripe_events` table holds event ids
  for idempotency, nothing else from the event.
- **Metering**: after a submit that entered the log the gateway adds one unit through a coalescing background
  write (`ctx.waitUntil`), so the hot path never waits on the Registry. The write returns the space's plan and
  remaining allowance, which the gateway caches for the isolate.
- **Allowance**: a `free` space whose month count has reached its allowance gets
  `429 {"error":{"code":"over_allowance","message":"Free allowance of 5,000 events used this month. Run `npx @celador/weft upgrade` ..."}}` on submit.
  It is checked from the cached state, so it costs no extra Durable Object call.
- **Upgrade**: `weft upgrade` -> `POST /v1/space/billing/checkout` -> Stripe Checkout Session in `subscription`
  mode with the metered price, `client_reference_id` = space id. `weft billing` -> Stripe Customer Portal session.
- **Webhook** `POST /v1/billing/stripe/webhook`: HMAC-SHA-256 over `t.payload`, constant-time compare, 5-minute
  timestamp tolerance, idempotent on event id, events older than the last applied one ignored. Other products on
  the same Stripe account send their events here too; only events for a space we created (marked in metadata) or a
  customer we know are acted on.
- **Reporting**: the Registry alarm runs hourly while a paid space has unreported usage. For each space it sends one
  Stripe meter event for the overage since the last report (`events - allowance`, never negative) with the identifier
  `weft:<space>:<month>:<from>-<to>`; the window is stored before the call and reused on retry, so a retry cannot be
  counted twice (Stripe deduplicates the identifier for 24 hours). `POST /v1/admin/billing/report` runs it on
  demand.
- **Erasing a space** cancels the subscription first (`DELETE /v1/space` and the operator suspend/erase paths call
  `cancelSubscriptions`); if Stripe cannot be reached the delete is refused with `503` rather than leaving a live
  subscription for a deleted space.

A usage retry with the same `Idempotency-Key` can count one event twice (the coordinator replays the old verdict, the
gateway cannot tell). At $0.001 an event this is noise and is not engineered away.

## Go-live checklist for John

Nothing below has been done. The hosted gateway deployed by `wt/sec-release` carries the code but no secrets, so it
is inert.

1. **Approve the numbers** in section 3 (allowance, price, whether to keep $1.00). To change them edit the
   `pricing-config` block above, `WEFT_FREE_EVENTS` in `[env.hosted.vars]`, and rerun step 3.
2. **Give me a live key** (restricted key, not the secret key, is enough): Products, Prices, Meters and Meter Events
   write; Checkout Sessions, Customers and Subscriptions write; Customer Portal Sessions write; Webhook Endpoints
   write. Store it in the macOS keychain: `security add-generic-password -U -a weft -s weft-stripe-live-key -w`.
3. **Create the live objects** (once, idempotent): `STRIPE_KEY=$(security find-generic-password -s weft-stripe-live-key -w) node scripts/stripe-setup.mjs --live`
   prints the price id. The script refuses a live key unless `--live` is passed.
4. **Register the webhook** in the Stripe dashboard (or `node scripts/stripe-setup.mjs --live --webhook https://weft-hosted.elier.ai/v1/billing/stripe/webhook`):
   events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`, `invoice.paid`.
5. **Set the secrets on the hosted Worker**, then deploy: `cd apps/gateway && for s in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID; do npx wrangler secret put $s --env hosted; done && pnpm deploy:hosted`.
6. **Configure the Customer Portal** once in Stripe (cancel subscription, update payment method): Settings,
   Billing, Customer portal. (Or `node scripts/stripe-setup.mjs --live` sets a default configuration.)
7. **Before the first month**: counters already hold this month's usage from before go-live, so a space that used
   more than 5,000 events will hit the allowance on day one. Reset with `POST /v1/admin/billing/reset-usage {"month":"YYYY-MM"}`
   if that is not wanted.
8. **Site and docs**: add the real prices to the site only after step 5; `docs/hosted.md` says "Hosting is free" until
   then.
9. **Test with a real card once** on a throwaway space and refund it.
