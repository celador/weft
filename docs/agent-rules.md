# Rules for every agent working on Weft

(Intended to become AGENTS.md at the repo root once John approves writing that file.)

Read `docs/design.md` first. It is the source of truth for architecture and terminology.
Plan and schedule: `docs/plan.md`. PM log: `docs/pm-log.md`.

1. Work only in your card's worktree/branch. Never edit `main` directly; the project
   manager lands branches.
2. COMMIT your work on your branch before completing the card
   (`git add -A && git commit -m "<scope>: <what> [<task_id>]"`). Uncommitted work is lost.
3. Run the gate before completing: `pnpm -r typecheck && pnpm -r test` (once the scaffold
   exists). Never complete a card with a red gate; block it with the failure instead.
4. TypeScript, strict. Workers runtime first. Tests with vitest
   (+ @cloudflare/vitest-pool-workers for Workers/DO code). pnpm workspaces.
5. Never print secrets. Cloudflare deploys use `wrangler` OAuth (already logged in, account
   2d659dee148763a8d64c80135da7165d). `unset CLOUDFLARE_API_TOKEN` before wrangler.
   Node >= 22: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
6. Spend: don't create paid resources beyond normal Workers Paid usage without stating it
   in the card result. Prefix every Cloudflare resource name with `weft-`.
7. If the design is wrong, say so in your result and propose the change to
   `docs/design.md` on your branch; don't silently diverge.
8. Complete with: what you built, how you verified it (real command output), branch name,
   and anything the next card must know.
9. Spikes/research: write findings to `docs/research/<topic>.md`, separate verified facts
   (with the command/doc URL that proved them) from assumptions.

License: AGPL-3.0-only for the product; MIT for docs/protocol, packages/protocol, packages/conformance,
plugins/weft and the Hermes catalog plugin (see LICENSE). Builds we distribute also carry the commercial
terms in docs/commercial-license.md. Outside contributions need the CLA (CLA.md).
