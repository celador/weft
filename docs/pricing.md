# Hosted Weft: pricing

**Status: the per-user Weft Pro prices below were APPROVED by John on 2026-11-17 ($12 per user per month, $98 per
user per year).** They replace the usage-based price (approved 2026-11-01, live since 2026-11-03), which is kept
further down as [history](#history-the-usage-based-model-2026-11-01). Until the go-live card deploys this code with
the live Pro prices, the live hosted gateway still runs the usage model; the code in this repo sells Pro and is
proven in Stripe TEST mode.
Local and self-hosted Weft stay free and open source (MIT), with no limits from us.

Every number lives in the `pricing-config` block at the end of the Pro section: a price change is a one-line
edit there, then `node scripts/stripe-setup.mjs` (new Stripe prices take over the lookup keys) and the two
`STRIPE_PRICE_PRO_*` secrets.

## Weft Pro: per user, monthly or yearly (approved 2026-11-17)

Modelled on cap.so: a free tier, and one paid tier priced per user.

| | Free | **Pro, monthly** | **Pro, yearly** |
|---|---|---|---|
| Local and self-hosted (`npx @celador/weft`, `weft deploy`) | unlimited, open source | same | same |
| Hosted space (`--hosted`) | 5,000 agent events per space per month; over it, agents keep working uncoordinated and are told so | no event cut-off | no event cut-off |
| Price | $0 | **$12 per user per month** | **$98 per user per year** (= $8.17 a month, save 32%) |
| Seats | | a quantity the buyer picks in Stripe Checkout and can change in the Customer Portal | same |
| Fair use | | 50,000 agent events per seat per month: passing it cuts nothing off; the month is flagged for the operator | same |

- **Seats are an honor system**, like Cap's license counter. Weft has no accounts, so nothing checks who the users
  are; the buyer says how many people use the space. Teammates on other machines join with `npx @celador/weft invite`
  and get their own member key ([hosted.md](hosted.md#teammates-on-other-machines-team-join)); `invite` and `members`
  say when the owner plus members outnumber the seats, and nothing is refused.
- **Fair use** is a flag, not a limit: when a Pro space's events this month pass `seats x 50,000`, the Registry records
  the time (`fair_use_exceeded_at` in `GET /v1/admin/spaces`, `node site/hosted-admin.mjs spaces`) and
  `GET /v1/admin/billing` counts it. We reach out; we do not cut off.
- **Changing seats** (Customer Portal): prorated. **Cancelling**: at the end of the paid period; the space then goes
  back to the free plan. **Erasing a Pro space** (`weft uninstall --space`) cancels the subscription at once, with no
  refund for the rest of the period.
- **The $500 pilot** (`weft deploy` on the customer's own Cloudflare account, fixed fee) is unchanged.
- **Pro includes the Commercial License** (below) for every Pro user.

### Two ways to buy

Pro belongs to a **Weft account** (free sign-up on weft.mx; [hosted.md](hosted.md#accounts-weftmx-clerk)), and every
hosted space of the account is Pro.

1. **Web first** (a stranger on weft.mx): pricing page "Get Pro" -> sign up (or sign in) -> straight into Stripe
   Checkout -> back on weft.mx/account/, which shows the plan and the one command to connect a machine:
   `npx @celador/weft login`.
2. **CLI first** (someone already using a hosted space): `npx @celador/weft upgrade [--seats N] [--year]`. If the space
   has no account yet, the CLI runs `weft login` first (the space joins the account), then opens Checkout.

### Commercial License: per user, yearly or once (approved 2026-11-17)

For people who run Weft locally or on their own Cloudflare account at work. The source is AGPL-3.0-only; the builds
we distribute are free for personal use and need a license (or Pro) for commercial use
([commercial-license.md](commercial-license.md), published at weft.mx/license/).

| | Yearly | Lifetime |
|---|---|---|
| Price | **$29 per user per year** | **$58 per user, once** (never renews) |
| Seats | the quantity the buyer picks in Checkout | same |
| Ends | cancelled: at the end of the paid year; a failed renewal: at the end of the last paid year | never |

- **Bought signed in**, like Pro: pricing page "Buy a license" -> `/account/?buy=license-year|license-lifetime&seats=N`
  -> sign up if needed -> Stripe Checkout (`POST /v1/account/billing/checkout {product: "license", term, seats}`).
  A Pro account is refused (Pro already includes it). Seats add up across purchases.
- **Nothing is enforced.** Weft never blocks, nags or phones home about a license. Setup prints one line when the
  machine has no license and no Pro ("Free for personal use. Using Weft at work? weft.mx/pricing"), from local state
  only; local mode sends nothing for it.
- **`weft license`** shows the signed-in account's license (it rides on the owner's `GET /v1/space`). **`weft license
  <key>`** records a license key from weft.mx/account/ on a machine that never signs in and checks it once with
  `POST /v1/license/verify` (no auth; answers what the key covers, never who owns it). The key is stored in the
  Registry only as a salted SHA-256 plus its last 4 characters; making a new key stops the old one.
- **Stripe**: product `weft_license` ("Weft Commercial License"), prices by lookup key `weft_license_user_year`
  (licensed, yearly) and `weft_license_user_lifetime` (one-time), both made by `scripts/stripe-setup.mjs`. The gateway
  sells the license only when `STRIPE_PRICE_LICENSE_YEAR` and `STRIPE_PRICE_LICENSE_LIFETIME` are set (on top of the
  four Pro secrets). Checkout carries `weft_product=license` metadata; the webhook records each purchase in the
  Registry's `licenses` table (a lifetime purchase by its Checkout Session, a yearly one by its subscription) and never
  touches the account's Pro plan. Deleting the account cancels the yearly subscription and deletes the licenses and
  the key.

### Margin check (from the cost model in section H1)

At the reference workload (25 events per live agent-hour) an agent event costs us about $0.153 per 1,000 all-in.
Stripe takes 2.9% + $0.30 per charge.

| per seat, per month | revenue after Stripe | infra at a typical 2,500 events | margin | infra at fair use (50,000 events) | margin |
|---|---|---|---|---|---|
| monthly ($12) | $11.35 | $0.38 | 91% | $7.65 | 31% |
| yearly ($98 / 12 = $8.17) | $7.90 | $0.38 | 92% | $7.65 | 3% |

A typical seat is very profitable; a yearly seat that sits at fair use every month is close to break-even. Open
points for John: (1) whether fair use should be lower for yearly seats (25,000 keeps the yearly margin at 50%),
(2) whether to offer a free trial (Checkout supports `trial_period_days`; none is set).

### How billing works (implementation)

All of it lives in the hosted gateway (`apps/gateway/src/billing.ts`, Registry tables in `registry.ts`) and is **off
until four secrets are set**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTH`,
`STRIPE_PRICE_PRO_YEAR` (plus `STRIPE_PORTAL_CONFIG_ID` for the Pro portal configuration). With any of them missing,
the billing routes answer `503`, `/buy` shows a "not on sale here" page, no allowance is enforced and no Stripe call is
made. Usage is still counted so `GET /v1/space` and `weft usage` have real numbers.

- **Registry, per space**: `plan` (`free` | `paid`), `product` (`pro`, or empty for a legacy usage subscription),
  `seats`, `interval`, `allowance` (nullable override), `stripe_customer_id`, and a per-month usage row (`events`,
  `fair_use_at`, and the legacy report window). Stripe Checkout collects the email and card and keeps them.
- **Registry, per web purchase** (`entitlements`): the Checkout Session id, the Stripe customer and subscription ids,
  seats, interval, plan, the buy link's `utm_source` / `utm_campaign`, and when and to which space it was claimed. Claim codes (`claim_codes`) are stored only as
  SHA-256 of a per-Registry random salt plus the code, expire after an hour, and are deleted on use. A claimed purchase
  is deleted with its space; an unclaimed purchase whose subscription ended is deleted after 30 days.
- **Metering**: after a submit that entered the log the gateway adds one unit through a coalescing background write
  (`ctx.waitUntil`). The count feeds the free allowance, `weft usage`, and the Pro fair-use flag. **Pro sends no meter
  events**: the hourly report runs only for legacy usage subscriptions.
- **Allowance**: a `free` space whose month count has reached its allowance gets `429 over_allowance` ("Run
  `npx @celador/weft upgrade` for Weft Pro ...") on submit, from cached state, with no extra Durable Object call.
- **Webhook** `POST /v1/billing/stripe/webhook`: HMAC-SHA-256 over `t.payload`, constant-time compare, 5-minute
  timestamp tolerance, idempotent on event id (a replay is answered without a Stripe call), events older than the last
  applied one ignored. A checkout's seats, interval and status are read from its subscription
  (`GET /v1/subscriptions/{id}`); if Stripe cannot be read the webhook answers `503` and Stripe retries. Other
  products on the same Stripe account send their events here too; only checkouts we created (a space id in
  `client_reference_id` and metadata, or `weft_purchase=web` metadata) and customers we know are acted on.
- **Erasing a space** cancels its subscription first (`DELETE /v1/space` and the operator erase); if Stripe cannot be
  reached the erase answers `503`, the space is already unreachable, and the Registry retries every minute.

The machine-readable copy below is what `scripts/stripe-setup.mjs` creates in Stripe and what the gateway's defaults
(`WEFT_FREE_EVENTS`, `WEFT_PRO_FAIR_USE_EVENTS`, `MAX_SEATS`) must equal; `apps/gateway/test/billing-inert.test.ts`
checks them. `legacy_usage` describes the superseded usage price, kept so existing Stripe objects can be found.

```json pricing-config
{
  "currency": "usd",
  "free_events_per_month": 5000,
  "pro": {
    "product_id": "weft_pro",
    "product_name": "Weft Pro",
    "usd_per_user_month": 12,
    "usd_per_user_year": 98,
    "fair_use_events_per_seat_month": 50000,
    "max_seats": 999
  },
  "commercial_license": {
    "product_id": "weft_license",
    "product_name": "Weft Commercial License",
    "usd_per_user_year": 29,
    "usd_per_user_once": 58,
    "max_seats": 999
  },
  "legacy_usage": {
    "product_name": "Weft hosted",
    "meter_display_name": "Weft agent events",
    "meter_event_name": "weft_agent_events",
    "usd_per_1000_events": 1.0
  }
}
```

### Go-live checklist (the go-live card)

1. The numbers above are the approved ones (2026-11-17); edit them only if John changes them.
2. `node scripts/stripe-setup.mjs --live` (restricted key from keychain `weft-stripe-live-key`; the key also needs
   write access to Prices and Customer Portal, which it has): product `weft_pro`, prices `weft_pro_user_month` and
   `weft_pro_user_year`, Pro portal configuration (metadata `weft=pro`).
3. `wrangler secret put --env hosted` for `STRIPE_PRICE_PRO_MONTH`, `STRIPE_PRICE_PRO_YEAR` and
   `STRIPE_PORTAL_CONFIG_ID` (the existing key and webhook secret stay; the webhook endpoint already sends the four
   events). Until these are set, a deploy of this code turns hosted billing OFF (no allowance enforced).
4. Deploy `weft-hosted`, publish the CLI (0.4.0), ship the site's pricing and welcome pages.
5. Verify: `/buy` answers 303 to a live Checkout page; `GET /v1/admin/billing` shows `enabled: true`.

## History: the usage-based model (2026-11-01)

Approved by John 2026-11-01 and live from 2026-11-03 to the Pro go-live: 5,000 agent events free per space per month,
then $1.00 per 1,000 events, never per seat. On 2026-11-17 the live Stripe account had **0 subscriptions** on it (any
status), so nobody needs to be moved. The cost model below is still the basis of the margin check above.

### H1. What a hosted space consumes

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

#### How the numbers were measured

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

#### Cost per unit of work

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

### H2. The billable meter

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

### H3. Allowance, price, example bills (approved 2026-11-01, superseded)

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

### H4. Go-live record of the usage model (2026-11-03)

Billing is on for the production hosted gateway (`weft-hosted.elier.ai`), in Stripe account elier.ai (customers see
"Atelier" on Checkout and statements).

1. Numbers approved by John, 2026-11-01 (section H3).
2. A restricted live key `weft-hosted` (write on Products, Prices, Billing Meters, Meter Events, Checkout Sessions,
   Customers, Subscriptions, Customer Portal, Webhook Endpoints; no balance, charges or payouts) is in the operator's
   keychain (`weft-stripe-live-key`) and is the Worker's `STRIPE_SECRET_KEY`. The account's full secret key is not on the Worker.
3. Live objects (`node scripts/stripe-setup.mjs --live`, idempotent): meter `weft_agent_events`, product `weft_hosted`,
   price with lookup key `weft_hosted_agent_events` (0.1 cent per event), Customer Portal configuration (metadata
   `weft=hosted`). The account already has a default portal configuration that belongs to another product, so the
   Worker pins ours with the `STRIPE_PORTAL_CONFIG_ID` secret.
4. Webhook: `node scripts/stripe-setup.mjs --live --webhook https://weft-hosted.elier.ai/v1/billing/stripe/webhook`
   (the four events). Secrets on the Worker: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`,
   `STRIPE_PORTAL_CONFIG_ID`.
5. This month's counters were reset (`POST /v1/admin/billing/reset-usage`) so no existing space hit the allowance on day one.
6. (Usage model) a number change meant editing `pricing-config`, `WEFT_FREE_EVENTS`, rerunning step 3 and setting
   `STRIPE_PRICE_ID`. The legacy objects are now made only with `node scripts/stripe-setup.mjs --legacy-usage`.
