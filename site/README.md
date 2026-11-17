# Weft marketing site

Static pages at https://weft.mx (Worker `weft-site`; weft-site.elier.ai 301s there): home, `/start/` (landing page for video traffic), `/pricing/`, `/sign-up/`, `/sign-in/`, `/account/`, `/cli/` (confirms a `weft login` code), terms, privacy, support. No build step. `worker.js` handles `POST /e` (funnel events into Analytics Engine), `GET /weft-config.js` (the public Clerk publishable key, Frontend API and gateway URL), `POST /api/account/delete` and the account pages' headers; everything else is static assets.

The start command, the gateway URL, every price and limit live in one object, `WEFT`, at the top of `public/assets/site.js`; the HTML holds no-JS fallbacks (`data-fill`), and `node --test site/*.test.mjs` fails if they disagree. Funnel and analytics: `docs/launch/README.md`.

Accounts (card t_4fe570cd, docs/hosted.md "Accounts"): the pages load Clerk's browser SDK from the Weft Clerk application's Frontend API (`CLERK_FRONTEND_API`). The signed-in pages send the Clerk session token to the gateway (`GET /v1/account`, `POST /v1/account/billing/checkout|portal`, `POST /v1/login/approve`); the gateway verifies it with the application's public keys and holds no Clerk secret. Get Pro links to `/account/?buy=month|year&seats=N`: signed in, that starts Stripe Checkout at once; signed out, it goes through `/sign-up/?redirect=…` and straight back into Checkout. There is no anonymous web purchase any more (no `/buy`, no `/welcome/` claim code).

Worker settings (set with `wrangler secret put`, so they stay out of this public repo): `CLERK_FRONTEND_API`, `CLERK_PUBLISHABLE_KEY` (both public by design), optional `WEFT_GATEWAY_URL` (default `https://weft-hosted.elier.ai`), and the one real secret `CLERK_SECRET_KEY`, used only by `POST /api/account/delete` to remove the caller's own Clerk user after the gateway erased the account's data. Set the secret by piping it from the keychain: `security find-generic-password -s weft-clerk-secret-key -a john -w | npx wrangler@latest secret put CLERK_SECRET_KEY`.

Preview: `npx --yes wrangler@latest deploy --env preview` deploys the same code as Worker `weft-site-preview` at https://weft-site-preview.elier.ai (banner, noindex, its own events dataset `weft_site_events_preview`, the Clerk development instance, Stripe test mode; it has no `CLERK_SECRET_KEY`, and the hosted gateway it points at has no account routes until go-live, so `/account/` there shows the network-error message). Never deploy the default env without the go-live OK.

Deploy: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH; unset CLOUDFLARE_API_TOKEN; npx --yes wrangler@latest deploy` from this folder.

Operator view: `node site/hosted-admin.mjs users` (Clerk users joined with gateway accounts; reads the Clerk secret locally from `$CLERK_SECRET_KEY` or the keychain item `weft-clerk-secret-key`) and `node site/funnel.mjs` (sign-ups and paid accounts per day and per utm_campaign).

Images: `public/assets/img` holds the real web-UI screenshots (`docs/web-screens`) and frames from `demo/video/weft-demo.mp4`, converted to WebP. The terminal block is the verbatim Codex tool result from the M1 demo run. Stats come from `demo/video/dogfood-stats.json`.

To move to another domain, change `routes` in `wrangler.toml` plus the canonical/OG URLs, robots.txt and sitemap.xml.
