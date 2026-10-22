# Recording: `npx @celador/weft` on a clean machine

Video: https://weft-media.elier.ai/weft-npx-first-run.mp4 (R2 bucket `weft-media`).

The rig behind it (vhs + tmux). Paths point at the recorder's scratch dir; adjust them.

- `clean-env.sh`: an empty HOME and a PATH with only node/npm/npx, claude and /usr/bin:/bin.
- `mkrepo.sh`: the two-file TypeScript scratch repo (`src/pricing.ts`, `src/cart.ts`).
- `two-agents.sh`: two Claude Code sessions in tmux plus `weft feed`. Both join Weft first;
  `shop` changes `calcTotal`'s signature; once Weft accepts that, `shop-2` gets a task that
  calls `calcTotal(items)` from its own worktree and Weft rejects that edit (`stale_assumption`).
- `weft-npx-first-run.tape`: `vhs weft-npx-first-run.tape` (runs `npx` against a packed tarball;
  after the package is published, use `npx @celador/weft`).

Kill leftovers before re-recording (`tmux -L weftrec kill-server`), or a stale `../shop-2`
makes the CLI pick `../shop-3`.
