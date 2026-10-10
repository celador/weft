# Weft marketing site

Static page at https://weft-site.elier.ai (Worker `weft-site`, assets only). Edit `public/index.html` and `public/assets/site.css`; no build step.

Deploy: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH; unset CLOUDFLARE_API_TOKEN; npx --yes wrangler@latest deploy` from this folder.

Images: `public/assets/img` holds the real web-UI screenshots (`docs/web-screens`) and frames from `demo/video/weft-demo.mp4`, converted to WebP. The terminal block is the verbatim Codex tool result from the M1 demo run. Stats come from `demo/video/dogfood-stats.json`.

To move to another domain, change `routes` in `wrangler.toml` plus the canonical/OG URLs, robots.txt and sitemap.xml.
