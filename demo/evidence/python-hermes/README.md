# Python through the Hermes adapter: real Hermes session (2026-10-22)

Card t_8ac721b0. Hermes Agent v0.22.2, default profile, `hermes -z` one-shot runs in a throwaway
Python repo (`shop/pricing.py`, `shop/cart.py`), against a local gateway (`pnpm dev:local --port
8823`, repo `pyshop-t8ac`, mode `enforce`). The plugin under test is this branch's
`packages/adapters/hermes/plugin/weft` + `dist/analyze.mjs` + `dist/grammars/`, loaded as a
project plugin (`<repo>/.hermes/plugins/weft`, `HERMES_ENABLE_PROJECT_PLUGINS=1`) so the
installed user plugin was not touched; `WEFT_HERMES_CONFIG` pointed it at the local gateway.

- Run 1, prompt: in `shop/pricing.py` give `calc_total` a `discount=0` parameter and add
  `apply_coupon(amount, code)`. Event seq 2:
  `writes: shop/pricing.py#apply_coupon (new), shop/pricing.py#calc_total (signature)`.
- Run 2, prompt: `Cart.total` takes `discount=0` and passes it to `calc_total`. Event seq 4:
  `writes: shop/cart.py#Cart (body), shop/cart.py#Cart.total (signature)`,
  `reads: shop/pricing.py#calc_total, shop/pricing.py#tax` (resolved through
  `from shop.pricing import calc_total, tax`).

Before this card both edits produced one whole-file key each (`shop/pricing.py#*`,
`shop/cart.py#*`) and no reads.

Files: `events.json` (the gateway's event log, observer API), `adapter.log` (the plugin's log;
the first line, `analyzer languages: typescript, python`, is printed only by the new plugin),
`diff.patch` (the two edits).
