# Local mode, hosted spaces, and your own gateway

`npx @celador/weft` talks to one Weft gateway. **It runs locally by default: your code and diffs
stay on your machine.** Hosted team spaces are an option you choose; they are free up to 5,000 agent events a
month, and Weft Pro (per user, monthly or yearly; prices in [pricing.md](pricing.md)) removes the cap. There are three kinds:

| | Where it runs | Who can create a space | Command |
|---|---|---|---|
| **Local** (default) | this machine (`wrangler dev`, port 7878) | you | `npx @celador/weft` |
| **Hosted** (opt-in) | Weft's Cloudflare account, `https://weft-hosted.elier.ai` | anyone with a free Weft account (weft.mx); older spaces made without one keep working | `npx @celador/weft login`, then `npx @celador/weft --hosted` |
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

**Accounts.** A hosted space belongs to a **Weft account**: a user of the Weft Clerk application, signed up free on
weft.mx (email with a code, or email and password). `npx @celador/weft login` connects a machine (see "Accounts" below).
The machine's credential is still the space's *owner key*, and it is still the only thing the CLI keeps: in
`~/.config/weft/cli.json` (mode 600) and in each checkout's `.weft/space-token` (git-ignored), so running the CLI
again in the same repo, even on a machine that lost `~/.config/weft`, finds the same space. On the hosted gateway
`POST /v1/spaces` without the admin key answers `403 login_required`: new hosted spaces come from `weft login`.
Spaces created before accounts keep working unchanged with their owner key; `weft login` on that machine attaches
them to the account. Local and self-hosted gateways have no accounts (no Clerk issuer set): there `POST /v1/spaces`
works as before, with no login. A teammate on another machine never gets the owner key: they join with an invite
code and get their own *member key* (see "Teammates on other machines" below).

**The space API** (owner key as `Authorization: Bearer`):

| Route | | Member key |
|---|---|---|
| `GET /v1/space` | the space, its repos, its key and member counts, its limits; `role` (`owner` or `member`) and, for a member, `member` (id, handle, label) | yes |
| `POST /v1/space/repos {"name"}` | repo `<space>-<name>`; idempotent | an existing repo only (`403` for a new name) |
| `POST /v1/space/tokens {"kind": "agent", "repo", "agent"}` | an agent key (scopes agent + observe) bound to one repo and one agent id | only for an agent id ending in `.<handle>` |
| `POST /v1/space/tokens {"kind": "system", "repo"}` | a lander key (system + observe) for one repo | no |
| `POST /v1/space/pairings` | a one-time pairing code for the feed page (single use, 10 minutes); at most 3 are open at a time | yes (the browser it pairs is the member's) |
| `GET /v1/space/viewers` | the paired devices: id, label, created, last seen, expiry, and `by` (the member who paired it) | no |
| `POST /v1/space/viewers {"label"}` | a device session for the caller's own CLI (the token is returned once) | yes |
| `DELETE /v1/space/viewers/{id}` · `DELETE /v1/space/viewers` | unpair one device, or all of them; immediate on the gateway instance that handles it, within 5 s on others | no |
| `DELETE /v1/space/tokens/{id}` | revoke one of the space's keys (a member key: with everything it minted) | only keys it minted |
| `POST /v1/space/invites` | a one-time invite code for a teammate (single use, 30 minutes); at most 5 are open at a time | no |
| `DELETE /v1/space/invites` | drop every open invite code | no |
| `GET /v1/space/members` | the members: id, handle, label, joined, last used | no |
| `DELETE /v1/space/members/{id}` · `DELETE /v1/space/members` | remove one member, or all: the member key and every agent key, CLI session and paired browser it minted are revoked in one step, and its open pairing codes dropped | no |
| `DELETE /v1/space/members/me` | leave the space (the same revocation, for the caller) | yes (only this) |
| `DELETE /v1/space` | **erase** the space (see "Deleting your data"): every repo's stored log is deleted for good, every key, the owner key and member keys included, stops working; answers `200` with what was erased | no |
| `POST /v1/space/billing/*` | Weft Pro (below) | no |

Everything a member key may call is in an allow-list (`memberRoute` in `apps/gateway/src/spaces.ts`); any other
route answers `403`.

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

### Teammates on other machines (team join)

Every checkout and worktree on one machine shares the machine's space. A person on another machine joins with their
own key:

1. the owner runs `npx @celador/weft invite` (`POST /v1/space/invites`): a one-time code like `K7M2P-9XQ4T`, valid for
   30 minutes, single use, and the command to send, e.g.
   `npx @celador/weft --hosted --join sp0abc1def2g:K7M2P-9XQ4T --repo shop`;
2. the teammate runs it in their clone. The CLI trades the code (`POST /v1/join {space, code, label, handle}`, no other
   credential) for a **member key**, keeps it in that clone's `.weft/space-token` and in `~/.config/weft/cli.json`
   under `spaces` (never in place of their own space), and installs the hooks;
3. the gateway gives the member a **handle** that is unique in the space (from `handle`, else the label; `alice`,
   then `alice-2`, ...; a removed member's handle is never handed out again). The member's agent ids must end in
   `.<handle>` (`shop.alice`), and the CLI also puts it in the task id (`T-main.alice`). Two people's agents therefore
   never share an agent id (an agent is never checked against itself) or a task id (changes of one task are
   alternatives, spec §7.7, never checked against each other): their edits to the same symbol produce diagnostics;
4. the owner sees members with `npx @celador/weft members` and removes one with `members revoke <id|handle>`
   (`--all` for everyone). A member leaves with `npx @celador/weft uninstall --space`.

The `label` (default: git's `user.name` and the short host name, or `--as NAME`) is shown only to the owner. Guessing
an invite code is as hard as guessing a pairing code (below): 10 symbols from a 31-symbol alphabet, single use, stored
only as SHA-256 of a per-Registry random salt, the space and the code, compared in constant time against the space's
open codes, `POST /v1/join` rate limited per network and per space (10 a minute each, the `WEFT_PAIR_RATE` budget),
and every failure answers the same `401`. A space holds at most 50 members (`WEFT_SPACE_MAX_MEMBERS`), and member keys
count as active keys. A full space answers `429` without using up the code.

**What a member key can do:** read the space (`GET /v1/space`, its usage included), use the space's existing repos,
mint agent keys for its own agent ids, a read session for its own CLI and pairing codes for its own browsers, revoke
keys it minted, and leave. **What it cannot:** add repos, mint landing (system) keys, invite, list or remove members,
list or unpair devices, attach, start or manage billing, or erase the space. A member key has no WCP scopes itself, so
it cannot read events directly either. Weft Pro is per user and stays an honor system: `invite` and `members` say when
the space has more people than seats, nothing is refused.

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
- an invite code only opens the space it was minted for; a member key manages nothing outside its space and, inside
  it, only the allow-listed routes, each scoped to what that member minted. Removing a member (or a member leaving)
  revokes its key and everything it minted in one Registry step, and a removed member's in-flight request mints
  nothing (the Registry checks the member in the same step that writes the key). Tested in
  `apps/gateway/test/members.test.ts`;
- erasing or suspending a space revokes all its keys (member keys included) and device sessions and drops its open
  pairing and invite codes;
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
| join attempts per minute, per network and per space | 10 each (`WEFT_PAIR_RATE`) |
| members per space | 50 (`WEFT_SPACE_MAX_MEMBERS`) |
| open invite codes per space | 5 (minting a 6th retires the oldest) |
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
| `POST /v1/space/billing/checkout {"interval": "month"\|"year", "seats": N}` | owner key: Stripe Checkout for Weft Pro for the space's **account**, `seats` (1-999, default 1), `client_reference_id` = the account id; `npx @celador/weft upgrade [--seats N] [--year]` prints the URL. A space with no account gets `403 login_required` on a gateway with accounts, and the CLI runs `weft login` first (keeping the space). A gateway without accounts sells per space, as before |
| `POST /v1/space/billing/portal` | owner key: a Stripe Customer Portal session (seats, monthly/yearly, card, invoices, cancel); `npx @celador/weft billing` |
| `POST /v1/account/billing/checkout`, `POST /v1/account/billing/portal` | the same, from weft.mx/account/ with the Clerk session (below) |
| `POST /v1/billing/stripe/webhook` | Stripe only: signature verified (constant-time, 5-minute tolerance), idempotent on event id, ignores events about other products |

The Registry stores per space the plan, Pro's seats and interval, an optional allowance override, the Stripe customer id
and a monthly event count; Stripe Checkout collects and keeps the email and card. Erasing a space cancels its
subscription first. While billing is enabled, agents on a hosted space submit over HTTP (the adapters do); the agent
WebSocket is not offered, because its submits would not be counted. An allowance is enforced from a cache that lasts up
to 10 seconds per Worker isolate, so a free space can overshoot it by the few events sent in that window.

### Accounts (weft.mx, Clerk)

A Weft account is a user of the **Weft** Clerk application (its own application, users and keys; nothing else trusts
its users). Sign-up, sign-in and the account page are on weft.mx (`/sign-up/`, `/sign-in/`, `/account/`, `/cli/`),
which load Clerk's browser SDK from the application's Frontend API (`clerk.weft.mx`).

**What is stored where.**

| | holds |
|---|---|
| Clerk (the Weft application) | email, password hash or sign-in codes, sign-in times, sessions |
| Stripe | billing email, card, invoices; the subscription's metadata carries the account id |
| Weft's gateway (`accounts` table) | the Clerk user id, plan, product, seats, interval, renewal time, Stripe customer id, created and paid times, and `utm_source`/`utm_campaign` of the first visit that sent the person; spaces carry a nullable `account_id`. No email, no name |
| the site Worker (`weft-site`) | nothing about users; it holds the Clerk **secret** key only to delete the caller's own Clerk user |

**Session tokens.** The page sends Clerk's short-lived session token as `Authorization: Bearer` (never a cookie, so a
form on another site cannot use it). The gateway has **no Clerk secret**: it verifies the token with the application's
public keys (`CLERK_ISSUER/.well-known/jwks.json`, cached), RS256 only, and checks `exp`, `nbf`, `iss` (exactly
`CLERK_ISSUER`: a token from any other Clerk application, e.g. elier.ai's, is refused) and `azp` against
`CLERK_AUTHORIZED_PARTIES` (`https://weft.mx` in production). Tests: `apps/gateway/test/accounts/`. CORS allows the
origins in `WEFT_SITE_ORIGINS`, no credentials.

| Route | Auth | |
|---|---|---|
| `GET /v1/account` | Clerk session | plan, seats, interval, renewal, `has_billing_account`, and the account's spaces (repos, events this month, last activity). The account row is created on first call |
| `POST /v1/account/billing/checkout {"interval", "seats", "utm_source"?, "utm_campaign"?}` | Clerk session | Stripe Checkout for Pro, `client_reference_id` = the account id; returns to `WEFT_ACCOUNT_URL?checkout=done`. The webhook makes the **account** Pro, and every space of the account is Pro |
| `POST /v1/account/billing/portal` | Clerk session | Stripe Customer Portal |
| `DELETE /v1/account` | Clerk session | cancels the subscription at once, erases every space of the account (the erase path below), deletes the account row; answers what was erased |
| `POST /v1/login` | none | `weft login` starts: a polling secret (`device_code`) and an 8-symbol code to confirm (`ABCD-EFGH`, ~2^39.6, 10 minutes, single use) and `https://weft.mx/cli/?code=...` |
| `POST /v1/login/approve {"code"}` | Clerk session | the signed-in person confirms the code on `/cli/` |
| `POST /v1/login/poll {"device_code", "label"}` | none, or the machine's current owner key | pending until approved; then a new owner key for the account's space (created on first login), or, with an owner key of a space that has no account, that space is attached to the account and keeps its key |
| `POST /v1/space/logout` | owner key | revokes this machine's owner key (spaces on an account only; logging in again gets a new one) |
| `GET /v1/admin/accounts` | admin key | accounts with plan, seats, spaces and events in 7 days (`node site/hosted-admin.mjs users` joins them with Clerk's emails locally) |

Login codes and polling secrets are stored only as salted SHA-256 (`settings.login_salt`), compared in constant time,
deleted when used or expired, and `/v1/login` and `/v1/login/approve` are rate limited like `POST /v1/pair` (10 a
minute per network; approve also per account). Every bad code answers the same `401`. The `/cli/` page is sent with
`no-store`, `Referrer-Policy: no-referrer` and `noindex`, and carries no analytics beacon.

**Deleting an account** (weft.mx/account/ -> Delete account): the page calls the site Worker's
`POST /api/account/delete` with the session token. The Worker verifies the token the same way, has the gateway delete
the account's data first (`DELETE /v1/account`: subscription cancelled, every space erased, account row deleted), and
only then deletes **that same** Clerk user with the secret key. If the gateway step fails nothing is deleted at Clerk.
Stripe keeps invoices, as the law requires.

**The anonymous web purchase is gone.** Earlier builds (never deployed) sold Pro on the web without an account
(`GET /buy` and a claim code on `/welcome/`). Paying on the web now always happens signed in, and `/welcome/` redirects
to `/account/`.

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
