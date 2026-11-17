# Local mode, hosted spaces, and your own gateway

`npx @celador/weft` talks to one Weft gateway. **It runs locally by default: your code and diffs
stay on your machine.** Hosted team spaces are an option you choose; they are free up to 5,000 agent events a
month, and Weft Pro (per user, monthly or yearly; numbers in [pricing.md](pricing.md), a PROPOSAL until John
approves them) removes the cap. There are three kinds:

| | Where it runs | Who can create a space | Command |
|---|---|---|---|
| **Local** (default) | this machine (`wrangler dev`, port 7878) | you | `npx @celador/weft` |
| **Hosted** (opt-in) | Weft's Cloudflare account, `https://weft-hosted.elier.ai` | anyone, no login | `npx @celador/weft --hosted` or `npx @celador/weft use hosted` |
| **Your own** | your Cloudflare account | you (the admin key the CLI keeps) | `npx @celador/weft deploy` |

All three run the same gateway code (`apps/gateway`): a Worker, one `RepoCoordinator` Durable
Object per repo (the ordered log) and one `Registry` Durable Object (repos and keys).

## Hosted spaces

Hosted is opt-in: nothing is sent to it unless you pass `--hosted` or run `use hosted`. If you
already had a hosted space (in `~/.config/weft/cli.json` or a repo's `.weft/space-token`),
`npx @celador/weft` keeps using it and prints one line: "Using your hosted space. Local is now the
default for new projects: npx @celador/weft use local".

The hosted gateway is a separate Worker, `weft-hosted` (`[env.hosted]` in
`apps/gateway/wrangler.toml`), with its own Durable Objects. It shares no storage with any team
gateway. Each space gets 5,000 agent events a month free (UTC); a Weft Pro space has no event cap and pays per user
through Stripe (see [pricing.md](pricing.md)). Nothing is charged unless you subscribe, with `npx @celador/weft upgrade`
or on weft.mx.

**No account.** `POST /v1/spaces` (no auth) creates a space and returns its *owner key*. That key
is the only credential: there is no login and no third-party identity. The CLI keeps it in
`~/.config/weft/cli.json` (mode 600) and in each checkout's `.weft/space-token` (git-ignored), so
running the CLI again in the same repo, even on a machine that lost `~/.config/weft`, finds the
same space.

**The space API** (owner key as `Authorization: Bearer`):

| Route | |
|---|---|
| `GET /v1/space` | the space, its repos, its key count, its limits |
| `POST /v1/space/repos {"name"}` | repo `<space>-<name>`; idempotent |
| `POST /v1/space/tokens {"kind": "agent", "repo", "agent"}` | an agent key (scopes agent + observe) bound to one repo and one agent id |
| `POST /v1/space/tokens {"kind": "system", "repo"}` | a lander key (system + observe) for one repo |
| `POST /v1/space/pairings` | a one-time pairing code for the feed page (single use, 10 minutes); at most 3 are open at a time |
| `GET /v1/space/viewers` | the paired devices: id, label, created, last seen, expiry |
| `POST /v1/space/viewers {"label"}` | a device session for the owner's own CLI (the token is returned once) |
| `DELETE /v1/space/viewers/{id}` · `DELETE /v1/space/viewers` | unpair one device, or all of them; immediate on the gateway instance that handles it, within 5 s on others |
| `DELETE /v1/space/tokens/{id}` | revoke one of the space's keys |
| `DELETE /v1/space` | **erase** the space (see "Deleting your data"): every repo's stored log is deleted for good, every key, the owner key included, stops working; answers `200` with what was erased |

**The feed.** `GET /feed?space=<id>` is a static page. **There is no credential in its address**,
so a forwarded link, a screenshot or a screen-share of it gives nobody access. A browser gets in by
*pairing*:

1. the owner runs `npx @celador/weft pair` (also printed by `npx @celador/weft` and `status`): a
   one-time code like `K7M2P-9XQ4T`, valid for 10 minutes, single use;
2. the page asks for it once and trades it (`POST /v1/pair {space, code, label}`) for a *device
   session*: a random token that exists only in an `HttpOnly`, `SameSite=Strict` cookie
   (`__Host-weft_session`, also `Secure`, on https). Page scripts cannot read it, it is never in a URL
   or a response body, and the browser sends it only to this gateway, for the feed's own reads
   (`GET /v1/repos`, `/v1/feed`, a repo's `/events`, `/v1/viewer`), never on a cross-site request;
3. the session reads one space, read-only. It expires after 7 days without use (the expiry slides with
   use) and in any case 30 days after pairing, then the device pairs again. The owner lists devices with
   `npx @celador/weft viewers` and unpairs one (`viewers revoke <id>`) or all (`viewers revoke --all`);
   a browser can also leave itself ("Unpair this browser"). Deleting or suspending the space ends them all.

Guessing a code: it is 10 symbols from a 31-symbol alphabet (about 2^49), single use, expires in 10
minutes, is stored only as a salted hash, and is compared in constant time against the space's open
codes. `POST /v1/pair` is rate limited per network and per space (10 a minute each, `WEFT_PAIR_RATE`),
and every failure answers the same `401`, so it does not reveal whether a space exists. A space holds
at most 20 paired devices (`WEFT_SPACE_MAX_DEVICES`).

`/feed` is sent with `Content-Security-Policy: … frame-ancestors 'none'`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so it cannot be embedded in another page.

**Retired: `/feed#t=…` links.** Earlier versions put a read-only key in the link, and anyone who got the
link read the space for as long as the space lived. The gateway revokes every such key (a one-time
migration in the Registry, run the first time it handles a space request after the update),
`POST /v1/space/tokens {"kind": "viewer"}` now answers `400` and says so, and a page opened with an old
`#t=…` link drops the fragment and shows "This link format was retired", with the command to run.

The CLI itself reads the feed (`weft status`, `weft feed`, the VS Code panel's fallback) with its own
device session, kept in `~/.config/weft/cli.json`; it appears in `weft viewers` as `weft CLI on <host>`
and is replaced by the next command if it expires or is revoked. Otto and the VS Code panel read your own
Hermes-adapter gateway with the shared human token, not this page, and are unaffected.

### Tenant isolation

The space key is the boundary. Enforced in `apps/gateway/src/registry.ts` and tested in
`apps/gateway/test/spaces.test.ts`:

- an owner key has no WCP scopes; it can only manage its own space;
- every key a space mints is bound to that space's repos: agent and lander keys to exactly one
  repo, paired devices to the space's repo list as it is when the session is checked (so they never see
  another space's repo, or an operator repo);
- a repo outside a key's list answers `404 repo_not_found` (its existence is not leaked);
- a space cannot mint keys for, revoke keys of, or name a repo in another space;
- a pairing code only opens the space it was minted for, and a device session reads only that space;
- erasing or suspending a space revokes all its keys and device sessions and drops its open pairing codes;
  cached grants for space keys expire within 5 seconds (and a cached grant reaches an emptied repo,
  which answers `404 repo_not_found`).

The public read-only demo at `demo.weft.mx` is unchanged: it is a different Worker
(`weft-web-public`) in front of a different gateway, with its own repo allow-list, and fails closed.

### Deleting your data (erasure)

`npx @celador/weft uninstall --space` (asks first; `--yes` skips the question) or
`DELETE /v1/space` with the owner key **erases the space for good**. It is irreversible: there is
no undo, no grace period and no backup on our side.

What happens, in this order (`Registry.eraseSpace`, `RepoCoordinator.erase`):

1. The space is marked `erasing` and every key it has is revoked: from this moment nothing can
   read or write it.
2. Every repo Durable Object of the space is erased: its sockets are closed, its alarm is cleared
   and `ctx.storage.deleteAll()` removes its whole SQLite database. That is every event, diff,
   intent, transcript pointer, claim, session and the input journal. The object is empty
   afterwards and a later read does not recreate a schema.
3. Only when all repos are gone are the space's rows deleted from the Registry (repos and keys)
   and the space row is cut down to a tombstone.

If step 2 fails for a repo, the space stays `erasing` (unreachable) and the Registry retries every
minute until it succeeds, so an erase request is never dropped halfway. The command answers
`503` in that case and can be run again by the operator (`DELETE /v1/admin/spaces/{id}`).

**What remains after an erase** (the tombstone, in the Registry): the space id, its status
`erased`, the time it was erased, and the day it was created (the time of day is dropped). No
label, no repo names, no keys, no key hashes, no events. The tombstone makes a repeated erase
answer the same way (`already_erased`) and keeps the "new spaces per day" count honest. Aggregate
numbers (signup counts per day) and Cloudflare's own operational request logs (a few days, no
bodies) are not part of the space and are not touched.

**Cloudflare's side.** Cloudflare documents point-in-time recovery for SQLite Durable Objects
over the last 30 days. That API can only be called by code running inside the object, and Weft's
code never calls it. We have not verified whether Cloudflare keeps recoverable history after
`deleteAll()`, so treat up to 30 days as the outer bound for remnants inside Cloudflare's systems.

**Who can erase what.** The owner key erases its own space and nothing else (the route has no
space id; it takes the space from the key). The operator can erase any space, a suspended one
included (suspending keeps the data so the operator can look at abuse; erasing then removes it).
Spaces an older gateway only soft-deleted (`status = deleted`, data still stored) are erased by the
Registry's alarm shortly after this version is deployed.

**Local and self-hosted gateways** run the same code, so `uninstall --space` erases there too.
A gateway older than this version answers `204` and only switches the space off; the CLI says
so and tells you to update it.

On the machine, the command also deletes `.weft/space-token` and removes the space (owner and
viewer keys) from `~/.config/weft/cli.json`, and prints what the gateway reported erased. If the
gateway cannot be reached or fails, nothing local is removed and the command can be run again.

### Limits

Set as vars in `[env.hosted.vars]`; the per-minute ones also use Workers Rate Limiting bindings.

| Limit | Default |
|---|---|
| new spaces per network per day (counted under a daily-rotating HMAC of the IP, deleted after 48 h; nothing IP-derived is stored on the space) | 20 |
| new spaces per minute per network | 5 (`WEFT_SIGNUP_RATE`) |
| pairing attempts per minute, per network and per space | 10 each (`WEFT_PAIR_RATE`) |
| paired devices per space | 20 |
| new spaces per day, whole gateway | 2,000 |
| active spaces, whole gateway | 20,000 |
| repos per space | 20 |
| active keys per space | 200 |
| requests per minute per space | 600 (`WEFT_RATE`) |
| request body | 2 MB |

Over a limit, the gateway answers `429 rate_limited` with a message; the adapters fail open, so
an agent keeps working (uncoordinated) and is told so.

### Billing: Free and Weft Pro

Hosted plans are Free (5,000 agent events per space per month) and Weft Pro (per user, monthly or yearly, no event
cut-off, a fair-use flag at 50,000 events per seat per month). The numbers and how billing works are in
[pricing.md](pricing.md). (From 2026-11-03 until the Pro go-live the live gateway charged $1.00 per 1,000 events above
the allowance; that model is kept there as history.) Billing is on only where the Stripe secrets are set. A gateway
without them (local, your own) never limits or charges, its billing routes answer `503`, and usage is only counted.

| | |
|---|---|
| `GET /v1/space` | adds `usage` (this month's events, the allowance, `plan` = `free` or `paid`, and for Pro `seats`, `interval`, `fair_use_events`, `over_fair_use`) and `billing.enabled`; `npx @celador/weft usage` prints it |
| over the allowance (free plan, billing enabled) | submits answer `429 over_allowance` with a one-line upgrade message; the adapters fail open and tell the agent its edit was not coordinated. Hello, heartbeat, inbox, gate and every read keep working. Pro is never cut off |
| `POST /v1/space/billing/checkout {"interval": "month"\|"year", "seats": N}` | owner key: a Stripe Checkout Session for Weft Pro, `seats` (1-500, default 1) of the monthly or yearly per-seat price, adjustable on the page, `client_reference_id` = the space id; `npx @celador/weft upgrade [--seats N] [--year]` prints the URL |
| `POST /v1/space/billing/portal` | owner key: a Stripe Customer Portal session (seats, monthly/yearly, card, invoices, cancel); `npx @celador/weft billing` |
| `POST /v1/space/billing/claim {"code"}` | owner key: bind a web purchase to this space (below); `npx @celador/weft --hosted --claim <code>` |
| `GET /buy`, `POST /v1/billing/claim` | the web-first purchase (below) |
| `POST /v1/billing/stripe/webhook` | Stripe only: signature verified (constant-time, 5-minute tolerance), idempotent on event id, ignores events about other products |

The Registry stores per space the plan, Pro's seats and interval, an optional allowance override, the Stripe customer id
and a monthly event count; Stripe Checkout collects and keeps the email and card. Erasing a space cancels its
subscription first. While billing is enabled, agents on a hosted space submit over HTTP (the adapters do); the agent
WebSocket is not offered, because its submits would not be counted. An allowance is enforced from a cache that lasts up
to 10 seconds per Worker isolate, so a free space can overshoot it by the few events sent in that window.

### Weft Pro on the web: the contract the site uses

A stranger who has never run Weft can buy Pro on weft.mx and attach it to a space later. There is no account: the
purchase is bound to a space by a one-time claim code. All URLs below are on the hosted gateway,
`https://weft-hosted.elier.ai` (call it `$GW`).

**1. Buy button** (pricing page): a plain link, no JavaScript needed.

```
$GW/buy?interval=month&seats=1
$GW/buy?interval=year&seats=2&utm_source=youtube&utm_campaign=launch
```

| parameter | values | default |
|---|---|---|
| `interval` | `month` or `year` | `month` |
| `seats` | 1 to 500 | `1` (the buyer can change it on the Checkout page) |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `ref` | optional; letters, digits, `. _ ~ -` and spaces, up to 100 characters (anything else is dropped) | none |

The gateway answers `303` to a Stripe Checkout page for Weft Pro (promotion codes allowed). The `utm_*` / `ref`
values go into the Checkout Session's metadata in Stripe; the gateway does not keep them. A bad `interval` or `seats`
gets a `400` HTML page, more than 10 checkouts a minute from one network a `429` page, and a gateway without billing a
`503` page. Back-out goes to `https://weft.mx/pricing/` (`WEFT_PRICING_URL`).

**2. Welcome page**: after paying, Stripe sends the buyer to

```
https://weft.mx/welcome/?session_id=cs_live_...        (WEFT_WELCOME_URL)
```

The page reads `session_id` from its own address and calls, from the browser:

```
POST $GW/v1/billing/claim
content-type: application/json

{"session_id": "cs_live_..."}
```

CORS allows the origins in `WEFT_SITE_ORIGINS` (`https://weft.mx`, `https://www.weft.mx`), no credentials. Answers:

| status | body | what the page shows |
|---|---|---|
| `201` | `{"type": "billing.claim", "code": "K7M2-9XQ4-TPRA", "expires_at": "...", "seats": 2, "interval": "year", "command": "npx @celador/weft --hosted --claim K7M2-9XQ4-TPRA"}` | the command, with a copy button; "run it in your repo; the code works once, for an hour" |
| `404`, `error.details.status = "unknown"` | Stripe has not confirmed the payment yet | "Finishing your payment..." and retry every 2-3 seconds for about a minute |
| `400`, `error.details.status = "claimed"` | the purchase is already bound to a space | "Already set up. Manage it with `npx @celador/weft billing` in that repo" |
| `400`, `error.details.status = "inactive"` | the subscription was cancelled or is unpaid | "This subscription is not active" |
| `429` | more than 10 requests a minute from this network | retry after a minute |

Every reload of the welcome page gives a fresh code (at most 3 are open at a time; older ones stop working) until
the purchase is claimed. The page must send `Referrer-Policy: no-referrer` (the `session_id` is in its address)
and must not put the code in any URL, analytics event or log.

**3. Claim**: in a git repo, `npx @celador/weft --hosted --claim K7M2-9XQ4-TPRA` creates the hosted space (or reuses
the one this repo or machine already has), then calls `POST /v1/space/billing/claim {"code"}` with the space's owner
key. The space becomes Pro with the purchase's seats and interval; Stripe's subscription is labelled with the space id.
A space that already pays refuses a claim (the code stays good for another space). Codes are case-insensitive and
ignore separators.

**Security of the flow.** The Checkout Session id in the welcome address is the only thing that turns into a code,
and only while the purchase is unclaimed; it is a long random id chosen by Stripe. A claim code is 12 symbols from
a 31-symbol alphabet (~2^59), single use, valid for an hour, stored only as SHA-256 of a per-Registry random salt plus
the code, and compared in constant time against every open code. Both `POST /v1/billing/claim` and
`POST /v1/space/billing/claim` are rate limited (10 a minute per network, and per space for redeeming), and every bad
code gets the same `401`. Neither the owner key nor a claim code is ever put in a URL.

### Operator controls (kill switch)

With the hosted admin key (`wrangler secret put WEFT_ADMIN_TOKEN --env hosted` on the gateway; on the
operator's Mac it lives in the login keychain as service `weft-hosted-admin`, account `john`, never
in a file; store it with `security add-generic-password -U -a john -s weft-hosted-admin -w`, which
prompts for the value; `site/admin-token.mjs` is the one reader the operator scripts share). The CLI
never writes this key anywhere on a user's machine:

```sh
U=https://weft-hosted.elier.ai; AD="authorization: Bearer $(security find-generic-password -s weft-hosted-admin -a john -w)"
curl -s -H "$AD" $U/v1/admin/stats                       # first runs per day, totals, retention (below)
curl -s -H "$AD" $U/v1/admin/spaces                      # every space: status, repos, keys
curl -sX POST -H "$AD" $U/v1/admin/spaces/<id>/suspend   # ban one space (all its keys revoked, data kept)
curl -sX DELETE -H "$AD" $U/v1/admin/spaces/<id>         # erase one space for good (any status); idempotent
curl -sX POST -H "$AD" $U/v1/admin/spaces/<id>/tag -d '{"internal":true}'   # our own test/demo space: out of the headline numbers
curl -sX POST -H "$AD" $U/v1/admin/hosted -d '{"mode":"no-signups"}'  # stop new spaces; existing ones keep working
curl -sX POST -H "$AD" $U/v1/admin/hosted -d '{"mode":"off"}'         # refuse every space key, at once
curl -sX POST -H "$AD" $U/v1/admin/hosted -d '{"mode":"open"}'        # back to normal
```

`node site/hosted-admin.mjs spaces` and `node site/hosted-admin.mjs tag <id>... [--off]` do the
per-space listing and tagging without the key touching a shell history.

### Retention metrics (counts only)

Whether anyone keeps using Weft, without storing anything about the user. For each space the
Registry keeps `last_event_at` and a count of events per UTC day (an event = one accepted
`POST .../sessions/<id>/events` from one of the space's agent tokens); day rows older than 90 days
are deleted, and a deleted space's rows go with it. No IP, no repo names, no paths, no content.

`GET /v1/admin/stats` adds `retention`:

| field | meaning |
|---|---|
| `active_7d`, `active_30d` | spaces with at least one event in the last 7 / 30 UTC days (today included) |
| `retained` | spaces with events on 2 or more distinct days (within the 90 kept), at least one in the last 7 days |
| `events_per_day` | all events per UTC day, last 30 days |
| `internal_spaces` | spaces tagged internal |
| `spaces` | per space: `id`, `label`, `status`, `created`, `last_event_at`, `active_days_30`, `internal` (500 at most, most recently active first; `spaces_total` is the full count) |

Spaces tagged `internal` (`POST /v1/admin/spaces/<id>/tag {"internal": true}`) are left out of every
headline number, including `spaces.total` and the first-runs `days`, and stay in the per-space list
with `internal: true`. `node site/funnel.mjs` prints the same retention lines after "first runs".

The hard stop, without the Registry: set `WEFT_HOSTED_OFF = "1"` in `[env.hosted.vars]` and run
`pnpm --filter @weft/gateway deploy:hosted`. Every space request then gets `503 unavailable`.

`GET /v1/admin/stats` is the last step of the launch funnel (views → site visits → command
copies → first runs): one new space = one first run of `npx @celador/weft`.

Billing (with the admin key): `GET /v1/admin/billing` (enabled, plan counts, Pro spaces and seats, Pro spaces past fair
use, unclaimed web purchases, events this month, free spaces over their allowance), `GET /v1/admin/spaces` (per space:
`plan`, `events_this_month`, and for Pro `seats`, `interval`, `fair_use_exceeded_at`; `node site/hosted-admin.mjs billing`
prints the paid ones), `POST /v1/admin/billing/report` (send legacy usage-plan overage to Stripe now; `{"space": "<id>"}` for one space),
`POST /v1/admin/billing/reset-usage {"month": "YYYY-MM"}` (zero a month's counters, for go-live) and
`POST /v1/admin/spaces/<id>/allowance {"events": 20000}` (a different allowance for one space; `null` restores the default).

### Deploying the hosted gateway

```sh
unset CLOUDFLARE_API_TOKEN
cd apps/gateway && pnpm deploy:hosted        # wrangler deploy --env hosted
```

## Local mode (the default)

`npx @celador/weft` installs wrangler once into `~/.config/weft/tools`, writes the bundled
gateway Worker to `~/.config/weft/local/worker/` and starts `wrangler dev` there in the background
(`127.0.0.1:7878`, or the next free port). Its state is in `~/.config/weft/local/state`; nothing
leaves the machine. Stop it with `npx @celador/weft local stop`; the next run starts it
again with the same state. `--local` is still accepted and means the same as no flag.
`npx @celador/weft use local` switches a machine that used hosted back.

## Your own Cloudflare account

```sh
npx @celador/weft deploy                               # Worker weft-gateway on <account>.workers.dev
npx @celador/weft deploy --name weft --domain weft.example.com   # on a hostname in one of your zones
```

It logs in with `wrangler login` (browser OAuth) unless wrangler is already logged in or
`CLOUDFLARE_API_TOKEN` is set, deploys the gateway Worker with its two Durable Objects (SQLite
storage, which the Workers Free plan includes), sets a random `WEFT_ADMIN_TOKEN` secret (kept in
`~/.config/weft/cli.json`), waits until it answers, and makes it your default gateway. Signups are
closed on it (`WEFT_SIGNUPS = "admin"`): only the CLI holding the admin key creates spaces.
`npx @celador/weft use local` switches back to this machine.

This is the coordinator and registry only. Weft's full hosted stack (Artifacts forks, merge queue,
evidence, workflows) needs more resources; see [runbook.md](runbook.md).
