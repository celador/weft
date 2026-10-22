# Launch funnel

Weft has no signup. `npx weft` is the signup: its first run creates a free hosted space with no
login (card t_bd602434). The site (https://weft-site.elier.ai) has one job: get a visitor from
a social post to that first run in as few steps as possible.

## Funnel definition

| Step | What counts | Where it's measured |
| --- | --- | --- |
| 1. Views | Impressions of the launch post | The social platform's post analytics |
| 2. Site visits | Visits to weft-site.elier.ai | Cloudflare Web Analytics, site `weft-site.elier.ai` (dashboard: Analytics, Web analytics). Also `view` events in Analytics Engine, split by source |
| 3. Command copies | Clicks on a Copy button, or copying the command by hand | `copy` events in Workers Analytics Engine dataset `weft_site_events` |
| 4. First runs | New hosted spaces per day | The hosted gateway (card t_bd602434) |

Conversion is each step divided by the one before it.

```sh
node site/funnel.mjs 7      # views and copies per day and source, last 7 days
```

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
  `https://weft-site.elier.ai/?utm_source=x&utm_campaign=launch`.

## Switching the command to `npx weft`

The command lives in one constant at the top of `site/public/assets/site.js`. When the
package is published, set `NPX_READY = true` (and `NPX_COMMAND` if the published name is not
`npx weft`), then deploy the site (`site/README.md`). Every copy block and step 1 of "How it
works" follow it.

Old links `/start` and `/early-access` redirect to the hero (`site/public/_redirects`).
