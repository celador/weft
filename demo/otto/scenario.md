# Otto demo: Northbound Coffee — many cards, many harnesses, one repo, through Weft

Pitch line it has to prove: **"Coordinates, doesn't orchestrate."** No agent on top splits the
work. A human writes independent cards on a Hermes kanban board; each card's worker starts its own
candidates on different harnesses; they meet only in the shared Weft log, where conflicts show up
mid-edit as squiggles.

## Pieces

| piece | where |
|---|---|
| demo site (TypeScript Worker + static pages) | `~/github/weft-demo-site` (own git repo), live at https://weft-demo-site.elier.ai |
| Weft repo | `weft-demo-site` on the preview gateway (https://weft-gateway-preview.elier.ai), enforce mode |
| trunk | Artifacts `weft-preview/weft-demo-site`; `node demo/otto/trunk.mjs seed --run N` resets it to the site repo's HEAD |
| production deploys | `node demo/otto/trunk.mjs follow --deploy` (wrangler deploy of each new trunk head; Workers Builds is not connected to this Artifacts repo) |
| production signal | `weft-production-signal-preview` tail consumer, `WEFT_REPOS` maps script `weft-demo-site` → repo `weft-demo-site` |
| kanban board | Hermes board `weft-demo-site`, Otto workspace "Northbound Coffee" (project `p_012609f7`) |
| cards | `demo/otto/scenario.mjs` (`TASKS` t1..t7 + `PLANTED` t8) |
| one card's lane | `demo/otto/lane.mjs start|wait --run N --task tK --card <card id>` |
| report | `node demo/otto/report.mjs --run N --runs 1,2,3` → `run-N/run.json` + `demo/evidence/otto-report.md` |

## Cards and the collisions they are written to produce

| card | harnesses | what Weft shows |
|---|---|---|
| t1 Member sessions expire after an hour | Claude Code, Codex | the signature change (`createSession(userId, opts)`) other cards trip over; answers negotiation |
| t2 Gift signup | Claude Code, OpenCode, Gemini CLI | plans against the old `createSession`, implements after t1's signature edit is in the log → `stale_assumption` squiggle mid-edit → reroute |
| t3 Remember me | Claude Code, Codex | must keep calling `createSession(userId)`; on the squiggle it negotiates (`weft negotiate propose overload`) instead of adapting; t1's agent accepts; both land |
| t4 Bulk discount | Codex, Hermes | one-line edit in `calcTotal` (src/pricing.ts) |
| t5 Free shipping | Claude Code, Gemini CLI | one-line edit in `shippingFee`, adjacent to t4's: git conflicts, Weft lands it with a Mergiraf structural merge when the other landed first |
| t6 Add Ethiopia Guji to the menu | Claude Code, Codex, Hermes | visual change: per-candidate preview, screenshots of / and /menu.html, pixel diff, risk, review agent; a human approves one in Otto |
| t7 Roast-date freshness helper | Gemini CLI, OpenCode | independent: lands on its own |
| t8 Quote API: price by the gram (planted) | scripted | lands a change that throws in production → tail errors → auto-revert → card reopened |

No parents between t1..t7: the plan-first cards (t2, t3) start right away and implement once an
accepted signature change to `src/auth/session.ts#createSession` appears in the Weft log (a peer
reading the shared log, not a coordinator telling it). t8 is created after the others land.

## Lane (what each card's worker runs)

1. `POST /v1/repos/weft-demo-site/tasks/<card>/candidates` — one Artifacts fork per harness (retried on 503).
2. Each harness in its own clone of its fork with its own Weft adapter (Claude Code / Codex / OpenCode /
   Gemini CLI hooks; Hermes via the Weft Hermes plugin in candidate mode, `WEFT_HERMES_*`).
3. The card's turns (plan → wait for cue → implement for t2/t3; one turn otherwise; t1 stays to answer
   proposals until none arrived for 150 s).
4. Commit + push to the fork → Artifacts `pushed` event → ProcessRevision: rebase, tests, preview,
   screenshots, pixel diff, risk, review.
5. `POST /tasks/<card>/select` → BestOfN ranks; when a human must approve, the lane waits for the
   Approve click in Otto's Weft panel (the same `POST /v1/repos/<repo>/actions {action: approve}` with
   John's human token); after `--approve-wait` seconds it sends that action itself and records it as a
   scripted fallback.
6. LandChange (CAS on trunk; git → Mergiraf → resolver layers).

## Run

```sh
cd ~/github/weft/.worktrees/t_83def502            # or main after merge
node demo/otto/trunk.mjs release-all && node demo/otto/trunk.mjs seed --run N
node demo/otto/trunk.mjs follow --deploy > demo/evidence/otto/run-N/follow.log 2>&1 &
# rehearsal without cards:
for k in t1 t2 t3 t4 t5 t6 t7; do node demo/otto/lane.mjs start --run N --task $k --card rN-$k --approve-wait 60; done
# with cards: create the 7 cards on board weft-demo-site (body below), the dispatcher's workers run the lanes
node demo/otto/lane.mjs start --run N --task t8 --card <t8 card>     # after t1..t7 land
node demo/otto/trunk.mjs check --run N && node demo/otto/report.mjs --run N --runs 1,2,N
```

Card body (per card, `tK`): the worker runs `node demo/otto/lane.mjs start --run N --task tK --card $HERMES_KANBAN_TASK`,
then loops `lane.mjs wait --run N --task tK --timeout 540` until `FINAL`, comments progress, completes the
card on `landed`, blocks it on errors, and for t8 blocks it on `reverted` (= the card reopened).

## Honest limits

- Cursor Agent is installed but not logged in (needs John's browser OAuth), so it is not used.
- Production deploys come from `trunk.mjs follow --deploy`, not Workers Builds.
- Gemini CLI uses the free API tier; quotas are per model per day (`GEMINI_MODELS` in lib.mjs).
- The "scripted fallback" approval sends exactly the action Otto's Approve button sends, with the same
  token; the report marks which approvals were clicks and which were fallbacks.
