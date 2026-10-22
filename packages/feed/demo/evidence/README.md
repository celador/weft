# Live run, 2026-10-22 (local gateway, two Claude Code agents)

`pnpm dev:local --port 8817`; `demo/live-run.mjs setup` (repo `shop-feed-162959`, agents claude-a
T-1 "Prices include tax" and claude-b T-2 "Show the cart total", Claude Code adapter in each
worktree); `demo/server.mjs` on :8818; `demo/e2e.mjs` (Playwright) had the page open before the
agents started; then `demo/live-run.mjs agents` ran real `claude -p` sessions (prompts here).

What happened (log: `../../test/fixtures/live-run.json`):

- #1–2 claude-b plans `cartTotal` with `calcTotal(items)` (read-only session).
- #4 claude-a changes `calcTotal(items, opts: PriceOptions)`.
- #6 claude-b's edit of src/cart.ts is denied: `stale_assumption`, caused by claude-a · event #4.
- #9 claude-b adapts: `calcTotal(items, { taxRate: 0 })` (agents.log).
- #12 Message to claude-a, #13 Pause claude-b, #14 Resume claude-b, all sent from the demo page.

Screenshots:

1. `1-conflict-live.png`: taken by the first e2e pass the moment the blocked row arrived over the
   socket (both tasks in Editing now with 1 edit each, the squiggle with its cause link, the diff).
2. `2-cause-diff.png`: after clicking "caused by claude-a · event #4": claude-a's diff.
3. `3-paused.png`: after Message and Pause from the page: PAUSED, "Pause sent · logged as #13",
   the human rows in the feed.
4. `4-feed-after-actions.png`: after Resume.

`e2e-live-pass.log` is the live pass (it stopped at the Message step on a view bug, since fixed:
the composer did not open while the Message button kept focus). `e2e.json` is the full second
pass on the same run: every check ok, no console errors or CSP violations.
