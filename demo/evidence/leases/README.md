# Evidence: claim leases, hard firm limit, release on exit, #17 audit (L1)

All runs use the SqlCoordinator that the gateway's Durable Object runs (journaled), driven
with a fake clock. Only the clock is simulated; every verdict, release record and gate result
comes from the coordinator code of the named commit.

| file | what it shows |
|---|---|
| `soft.gif` / `soft.mp4` / `soft.txt` | (i) a dead agent's soft claim: blocks others for **30 min** on `main`, **2 min** now |
| `firm.gif` / `firm.mp4` / `firm.txt` | (ii) a firm claim asked for 1 h, holder heartbeating and editing: **never released** within 40 min on `main` (heartbeats renew it); released at the **10-min hard limit** now |
| `audit.gif` / `audit.mp4` / `audit.txt` | (iii) #17 audit: on `main` six ways clear a commit-mode open error and open the stop gate (release all, release the key, an intent or a claim naming the key, bye + hello, session expiry + hello); now all six keep it. Redoing the edit still resolves it; releasing after a check-mode denial (edit never applied) is still a valid retreat |
| `failing-on-main-reference.txt` | the five new conformance scenarios failing against main's reference coordinator |
| `failing-on-main-open-errors.txt` | `packages/sequencer/src/open-errors.test.ts` (each bypass vector, both coordinators) on main: 16 failed |
| `failing-on-main-claude-adapter.txt` | `packages/adapters/claude-code/test/hardening.test.ts` on main: symlink leaks and unreconciled Bash edits |

## Reproduce

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
S=$HOME/.hermes/cache/scratch                     # any scratch dir
git -C <weft> worktree add $S/weft-main 5d8da26   # the "before" tree
(cd $S/weft-main && pnpm install --frozen-lockfile)
node demo/evidence/leases/build.mjs $S/weft-main $S/lease-before.mjs
node demo/evidence/leases/build.mjs .            $S/lease-after.mjs
node $S/lease-before.mjs soft|firm|audit
node $S/lease-after.mjs  soft|firm|audit
vhs demo/evidence/leases/soft.tape                # recordings (tapes expect the bundles in $S)
```

`lease-clock.ts` is the whole scenario; `build.mjs` bundles it with esbuild against the given
tree's own `@weft/sequencer` and `@weft/protocol`.
