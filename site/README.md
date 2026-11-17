# Weft marketing site

Static pages at https://weft.mx (Worker `weft-site`; weft-site.elier.ai 301s there): home, `/start/` (landing page for video traffic), `/pricing/`, `/welcome/` (after Stripe Checkout), terms, privacy, support. No build step. `worker.js` handles `POST /e` (funnel events into Analytics Engine) and the welcome page's headers; everything else is static assets.

The start command, the gateway URL, every price and limit live in one object, `WEFT`, at the top of `public/assets/site.js`; the HTML holds no-JS fallbacks (`data-fill`), and `node --test site/*.test.mjs` fails if they disagree. Prices are a proposal until the go-live card (t_5408b767); the terms and privacy pages carry a `[go-live date]` placeholder for the effective date. Funnel and analytics: `docs/launch/README.md`.

Gateway contract (card t_6ee961cf): Get Pro links to `https://weft-hosted.elier.ai/buy?interval=month|year&seats=N&utm_*`; Stripe returns to `/welcome/?session_id=…`; the page strips the id from the address, POSTs `{session_id}` to `/v1/billing/claim` (CORS from weft.mx and the preview origin) and shows `npx @celador/weft --hosted --claim <code>`.

Preview: `npx --yes wrangler@latest deploy --env preview` deploys the same code as Worker `weft-site-preview` at https://weft-site-preview.elier.ai (banner, noindex, its own events dataset `weft_site_events_preview`). Never deploy the default env without the go-live OK.

Deploy: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH; unset CLOUDFLARE_API_TOKEN; npx --yes wrangler@latest deploy` from this folder.

Images: `public/assets/img` holds the real web-UI screenshots (`docs/web-screens`) and frames from `demo/video/weft-demo.mp4`, converted to WebP. The terminal block is the verbatim Codex tool result from the M1 demo run. Stats come from `demo/video/dogfood-stats.json`.

To move to another domain, change `routes` in `wrangler.toml` plus the canonical/OG URLs, robots.txt and sitemap.xml.
