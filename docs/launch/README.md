# Launch funnel

Weft has no signup. `npx weft` is the signup: its first run creates a free hosted space with no
login (card t_bd602434). The site (https://weft.mx) has one job: get a visitor from
a social post to that first run in as few steps as possible.

## Funnel definition

| Step | What counts | Where it's measured |
| --- | --- | --- |
| 1. Views | Impressions of the launch post | The social platform's post analytics (not in the report) |
| 2. Site visits | Visits to weft.mx | Cloudflare Web Analytics site `weft.mx` (siteTag `78447487…`; before 2026-10-22 the shared elier.ai site, host `weft-site.elier.ai`). Also `view` events in Analytics Engine, split by source |
| 3. Command copies | Clicks on a Copy button, or copying the command by hand | `copy` events in Workers Analytics Engine dataset `weft_site_events`, by source/placement |
| 4. npm downloads | Downloads of `@celador/weft` per day | `api.npmjs.org/downloads/range/<from>:<to>/@celador/weft` |
| 5. First runs | New hosted spaces per day | `GET https://weft-hosted.elier.ai/v1/admin/stats` (Registry `signupStats`, `docs/hosted.md`) |

Conversion is each step divided by the one before it. Steps 3 and 4 are leaky: people type the
command without copying it, and `npx` caches the package, so first runs can exceed copies.

## The report

```sh
node site/funnel.mjs 7          # all steps per UTC day, last 7 days, plus copies by source/placement
node site/funnel.mjs 7 --json   # same, machine-readable
node site/funnel.mjs --alert    # silent unless something launch-relevant changed (the cron uses this)
```

It needs no login from a fresh shell:

- **Cloudflare** (visits, copies), first credential that works: the macOS keychain item
  `weft-funnel-cf-token` (an API token with Account Analytics: Read on account `2d659dee…`), then
  `CLOUDFLARE_API_TOKEN`, then the local `wrangler login` OAuth token. An expired OAuth token
  is refreshed with `wrangler whoami` (its refresh token), which is what makes the cron
  survive without a keychain token. To add the scoped token (optional, removes the wrangler
  dependency): create it in the dashboard (My Profile, API Tokens, Create, Custom: Account,
  Account Analytics, Read) and run `security add-generic-password -U -a weft -s weft-funnel-cf-token -w`
  (prompts for the value). The wrangler OAuth token can't create API tokens, so an agent can't
  mint this one.
- **First runs**: the hosted admin key in `~/.config/weft/hosted-admin-token`.
- **npm**: public. npm publishes download counts with a 1-3 day lag; until a package's first
  day is indexed the API answers `package ... not found` (scoped names work unencoded,
  `@celador/weft`). Days npm hasn't published yet show `-`.

Caveats: first runs count every new hosted space, including the Weft team's own test runs
(2026-10-22's 14 were the publish and demo tests; `GET /v1/admin/spaces` shows each space's repo
label). Web Analytics samples any query spanning more than 7 days, so the script asks in
7-day windows; days older than about a week may still come back sampled (multiples of 10).

## Alerts

A daily Hermes cron (no agent, `~/.hermes/scripts/weft_funnel_alert.sh`, 09:00 local, delivered
to Telegram) runs `node site/funnel.mjs --alert` over the last 14 days. It prints, and so
messages John, only when one of these happens for the first time:

- a step goes above zero for the first time (`First first runs: …`);
- a day has at least 10x the average of the 7 days before it, and at least 50 visits, 10
  copies, 50 downloads or 5 first runs;
- all-time hosted spaces pass 25, 50, 100, 250, 500, 1000, 2500, 5000 or 10000.

Each alert fires once; state lives in `~/.config/weft/funnel-alert-state.json` (delete it and
run `node site/funnel.mjs --alert --seed` to reset without a message). A script error (no
working credential) is delivered as the cron's failure notice. Tests: `node --test site/funnel.test.mjs`.

## How the site measures

- **Cloudflare Web Analytics**: the cookieless beacon in `site/public/index.html` (token is
  public by design). No cookie banner needed.
- **Copy events**: `site/public/assets/site.js` posts `{event, placement, source, variant}` to
  `POST /e`; `site/worker.js` writes it to Analytics Engine. It stores no IP, user agent,
  cookie or identifier. `placement` is `hero` or `closing` (with `-manual` when the command was
  selected and copied by hand). `source` is the landing URL's `utm_source`, else the referrer
  host, else `direct`. `variant` is `quickstart` until `npx weft` ships, then `npx`.
- **Outbound links**: every GitHub and docs link carries
  `utm_source=weft-site&utm_medium=web&utm_campaign=launch&utm_content=<placement>`.
- **Links in posts**: tag them so step 2 can be split by post, for example
  `https://weft.mx/?utm_source=x&utm_campaign=launch`.

## Switching the command to `npx weft`

The command lives in one constant at the top of `site/public/assets/site.js`. When the
package is published, set `NPX_READY = true` (and `NPX_COMMAND` if the published name is not
`npx weft`), then deploy the site (`site/README.md`). Every copy block and step 1 of "How it
works" follow it.

Old links `/start` and `/early-access` redirect to the hero (`site/public/_redirects`).
