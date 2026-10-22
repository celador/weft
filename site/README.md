# Weft marketing site

Static page at https://weft.mx (Worker `weft-site`; weft-site.elier.ai 301s there). Edit `public/index.html` and `public/assets/site.css`; no build step. `worker.js` only handles `POST /e` (copy-button and view events into Analytics Engine); everything else is static assets. The start command lives in one constant at the top of `public/assets/site.js`. Funnel and analytics: `docs/launch/README.md`.

Deploy: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH; unset CLOUDFLARE_API_TOKEN; npx --yes wrangler@latest deploy` from this folder.

Images: `public/assets/img` holds the real web-UI screenshots (`docs/web-screens`) and frames from `demo/video/weft-demo.mp4`, converted to WebP. The terminal block is the verbatim Codex tool result from the M1 demo run. Stats come from `demo/video/dogfood-stats.json`.

To move to another domain, change `routes` in `wrangler.toml` plus the canonical/OG URLs, robots.txt and sitemap.xml.
