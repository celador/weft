# AGENTS.md — Weft

Read `docs/design.md` first (source of truth). Full agent rules: `docs/agent-rules.md`.
Plan: `docs/plan.md`. PM log: `docs/pm-log.md`.

Short version:
1. Work only on your card's branch/worktree; the PM lands to main.
2. Commit your work before completing the card.
3. Gate: `pnpm -r typecheck && pnpm -r test` must be green.
4. TypeScript strict, Workers runtime, vitest. Prefix Cloudflare resources `weft-`.
5. Never print secrets. wrangler uses OAuth; `unset CLOUDFLARE_API_TOKEN`; Node >= 22.
6. Complete with real verification output and notes for downstream cards.
7. Public hostnames are `<worker>.elier.ai` (Workers custom domains, `workers_dev = false`). Never use or
   publish `*.workers.dev` URLs: this account's workers.dev subdomain is a customer's company name.

License: AGPL-3.0-only for the product; MIT for docs/protocol, packages/protocol, packages/conformance,
plugins/weft and the Hermes catalog plugin (see LICENSE). Builds we distribute also carry the commercial
terms in docs/commercial-license.md. Outside contributions need the CLA (CLA.md).
