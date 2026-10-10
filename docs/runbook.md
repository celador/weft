# Weft runbook

## Prerequisites

- Node.js 22 or newer (Node 24 is used in CI)
- pnpm 9
- Cloudflare Wrangler authentication for preview deployment

## Install

```sh
pnpm install --frozen-lockfile
```

## Gate

The repository gate is:

```sh
pnpm -r typecheck && pnpm -r test
```

The root aliases are also available:

```sh
pnpm typecheck
pnpm test
```

## Run an app locally

Each app is a Worker placeholder with its own Wrangler configuration. Start one with:

```sh
pnpm --filter @weft/gateway dev
# or: pnpm --filter @weft/workflows dev
# or: pnpm --filter @weft/sandbox dev
# or: pnpm --filter @weft/web dev
```

The command runs `wrangler dev` using that app's `wrangler.toml`. Local Durable Object state, when introduced, remains local to the selected Wrangler environment.

## Deploy a preview

Authenticate using Wrangler OAuth, ensure `CLOUDFLARE_API_TOKEN` is unset, then deploy the selected app without production intent:

```sh
unset CLOUDFLARE_API_TOKEN
pnpm --filter @weft/gateway deploy:preview
```

All Worker names and future Cloudflare resources must begin with `weft-`. Do not use the preview command to deploy production without an approved environment configuration.

## Production signal and auto-revert (B13)

`@weft/production-signal` is a Tail Worker and Queue consumer. It writes exception-only tail
events to Analytics Engine (`weft_prod` / `weft_prod_preview`), persists the short detector
window in the shared Weft D1 database, and starts the normal `RevertOperation` workflow only
when the configured threshold is reached after an unreverted `landings` operation. The workflow
remains the sole component that changes trunk state, reopens the task, and attaches the stack
trace evidence.

Before a first preview deploy, create the Queue and apply the gateway migration to the same D1
database. Then deploy the consumer:

```sh
wrangler queues create weft-prod-events-preview
pnpm --filter @weft/gateway exec wrangler d1 migrations apply weft-preview --remote
pnpm --filter @weft/production-signal deploy:preview
```

Demo target (live since 2026-10-04): Worker `weft-demo`
(https://weft-demo.elier.ai) is connected to **Workers Builds** from the
Artifacts trunk `weft-preview/weft-demo` (branch `main`, deploy `npx wrangler deploy`, Preview
builds on). Every trunk push deploys it in ~5–40 s. The connection was made in the dashboard
(*Workers & Pages → Create application → Continue with Artifacts*): the Workers Builds API needs
"Workers CI" permissions that the wrangler OAuth token does not carry (`403 code 10000`). If the
Worker is ever deleted, repeat that once; nothing else is manual.

The Tail Consumer is declared by the target, so it lives in the trunk's `wrangler.jsonc`:

```jsonc
"tail_consumers": [{ "service": "weft-production-signal-preview" }]
```

`node apps/production-signal/scripts/live.mjs seed` (re)writes `src/worker.ts` (quote API) and
`wrangler.jsonc` on trunk; other cards' seeds (B8 catalog, B10 storefront) leave both files alone.

Proof (planted bug → auto-revert, ~2.5 min, no human step after the land):

```sh
node apps/production-signal/scripts/live.mjs prove   # -> demo/evidence/b13-auto-revert-live/run.json
```

It lands a change whose `/quote` handler throws, waits for Workers Builds to deploy it, sends 8
requests, and checks `prod-revert-<land op>` (D1 `production_reverts` latch), the revert commit and
redeploy, the reopened task and the `production_tail_error` evidence. The bug never outlives the
run: the revert redeploys the healthy trunk.

Detector knobs (`wrangler.toml` vars): `WEFT_SPIKE_THRESHOLD` (5 exceptions) and
`WEFT_SPIKE_WINDOW_SECONDS` (600; covers Workers Builds latency after the land). Only exceptions
count (5xx responses without an exception are ignored). Inspect:

```sh
wrangler d1 execute weft-preview --remote --env preview --command "SELECT * FROM production_reverts"
# Analytics Engine (SQL API): SELECT blob1 AS script, count() FROM weft_prod_preview WHERE index1 = 'weft-demo' GROUP BY blob1
```

Production (`weft-production-signal`, queue `weft-prod-events`, dataset `weft_prod`, D1 `weft`) is
configured but not deployed; a production target would name `weft-production-signal` instead.

## Gateway + sequencer (B2)

Preview: `https://weft-gateway-preview.elier.ai` (`/v1/health` is public).

- `packages/sequencer`: `SqlCoordinator` (WCP v0.1 over SQLite, a port of the protocol's
  reference coordinator), `JournaledCoordinator` (input journal + `replay()`), and the
  `RepoCoordinator` Durable Object (one per repo, `idFromName(repo)`).
- `apps/gateway`: the HTTP/WS binding (spec §2, §8, §9) and the `Registry` Durable Object
  (repos + SHA-256-hashed tokens).

Operator secret: `WEFT_ADMIN_TOKEN` (`wrangler secret put WEFT_ADMIN_TOKEN --env preview`).
The preview's value lives in `~/.config/weft/preview-admin-token` (mode 600) on John's
MacBook; never print it.

```sh
ADMIN=$(cat ~/.config/weft/preview-admin-token); U=https://weft-gateway-preview.elier.ai
# create a repo (policy wound-wait|wait-die; enforcement advise|block, default advise; optional claim_ttl_ms, session_ttl_ms)
curl -sX POST $U/v1/admin/repos -H "authorization: Bearer $ADMIN" -d '{"repo":"weft"}'
# agent token: exactly one repo, bound agent id (optionally change)
curl -sX POST $U/v1/admin/tokens -H "authorization: Bearer $ADMIN" \
  -d '{"principal":"claude-a","scopes":["agent"],"repos":["weft"],"agent":"claude-a"}'
# observer token for a phone (read-only), human token (approve/undo/pause/message), system token (landing queue)
curl -sX POST $U/v1/admin/tokens -H "authorization: Bearer $ADMIN" -d '{"principal":"johns-iphone","scopes":["observe"],"repos":"*"}'
curl -sX POST $U/v1/admin/tokens -H "authorization: Bearer $ADMIN" -d '{"principal":"john","scopes":["human"],"repos":"*"}'
curl -sX POST $U/v1/admin/tokens -H "authorization: Bearer $ADMIN" -d '{"principal":"landing-queue","scopes":["system"],"repos":"*"}'
# list (no secrets) / revoke
curl -s $U/v1/admin/tokens -H "authorization: Bearer $ADMIN"; curl -sX DELETE $U/v1/admin/tokens/<id> -H "authorization: Bearer $ADMIN"
```

Live smoke test (creates a throwaway `smoke-*` repo, plays the demo collision, checks the
observer API, feed and resumable stream): `node apps/gateway/scripts/smoke.mjs`.

Endpoints beyond the spec: `GET|POST /v1/repos/{repo}/system/queue` (submit queue: enqueue
`{change}`, set `{id,status}`), `GET /v1/repos/{repo}/system/ops` (operation log), agent WS
`submit` frames may carry `idempotency_key`.

## PM landings → Weft `land` (B16 follow-up, stopgap until B8)

The PM lands kanban branches with `git merge`, outside Weft. Each merge must be followed by a
system `land` record, or the merged card's soft claims linger for their 30-minute TTL and later
cards get `claim_wait` against code that is already on main. After every merge into main:

```sh
python3 packages/adapters/hermes/scripts/weft_land.py                # the merge commit at main
python3 packages/adapters/hermes/scripts/weft_land.py --recent 20    # catch-up (idempotent)
python3 packages/adapters/hermes/scripts/weft_land.py --branch wt/x --sha <sha>   # fast-forward merge
# add --dry-run to see the mapping and decisions without writing
```

- Branch → change: task ids come from the weft board's kanban DB (`branch_name`, or
  `workspace_path` = `.worktrees/<key>` for `wt/<key>`), a `t_<hex8>` in the branch name, and
  the `[t_…]` tags / `Kanban-Task:` trailers of the commits the merge brought in
  (`merge^1..merge^2`). The changes are looked up with `GET /events?task=<id>`; the Hermes
  adapter names them `hermes-<profile>/<task id>`.
- A change is landed when it has an accepted `edit`/`claim` after its last accepted `land`
  (a reopened card is landed again; a rerun is a no-op). Draft:
  `POST /v1/repos/weft/system/events {kind:"land", base_seq:<head>, change, payload:{sha:<merge sha>, op_id}}`,
  `op_id` = uuid5(repo, change, sha). Per spec §6.3 the land removes the change's claims, clears
  its open errors and pushes `trunk_advanced` (requires_rebase) to the changes that touch its keys.
- A rejected land (R1 trunk CAS, `stale_overwrite`) is logged and retried up to 3 times against a
  fresh head: git already holds the merge, so the rebase is re-reading Weft's trunk view.
  Exit status 1 if any land still failed.
- Token: system token `weft-pm-land` (scopes `system`+`observe`, repos `[weft]`), minted on first
  use from `~/.config/weft/preview-admin-token` and stored under `land` in
  `~/.config/weft/hermes-adapter.json` (mode 600). `install.py --uninstall` revokes it with the
  last profile. Never printed.
- Log: one JSON line per decision in `~/.cache/weft-hermes/land.log`.
- Live check (throwaway repo; real adapter, git merge, gateway):
  `python3 packages/adapters/hermes/scripts/verify_land_live.py` — claim_wait before the land,
  `land` accepted, `trunk_advanced` to the other card, and after it rebases its edit of the same
  symbol carries no `claim_wait`/`stale_overwrite`; rerun is a no-op.
- Agents still have to rebase after a land: their next edit of a landed symbol is
  `stale_overwrite` until their worktree gets a new commit that includes main (`git merge main`).

## Artifacts integration (B6)

Resources (all `weft-`): Artifacts namespaces `weft` (prod) / `weft-preview`; Queues `weft-artifacts-events` /
`weft-artifacts-events-preview` (consumer: the gateway's `queue()`); D1 `weft` / `weft-preview`
(`apps/gateway/migrations`). Deploys need wrangler 4.147 (root devDependency) for the `[[artifacts]]` binding.

```sh
cd apps/gateway; unset CLOUDFLARE_API_TOKEN
pnpm exec wrangler d1 migrations apply weft-preview --env preview --remote
pnpm exec wrangler deploy --env preview
# Per-fork event subscriptions from the gateway need a CF API token (Account > Queues: Edit):
pnpm exec wrangler secret put WEFT_CF_API_TOKEN --env preview
```

```sh
ADMIN=$(cat ~/.config/weft/preview-admin-token); U=https://weft-gateway-preview.elier.ai
# bind a Weft repo to an Artifacts trunk (create:true creates it in the env's namespace)
curl -sX POST $U/v1/admin/artifacts/repos -H "authorization: Bearer ***" -d '{"repo":"weft-demo","create":true}'
# candidates (system token): fork + write token (returned ONCE) + Change-Id + trailers
curl -sX POST $U/v1/repos/weft-demo/tasks/t_123/candidates -H "authorization: Bearer ***" -d '{"count":3,"agents":["claude-a","codex-b","cursor-c"]}'
# observe: GET  /v1/repos/{repo}/tasks/{task}/candidates, GET /v1/repos/{repo}/changes/{change} (revisions, evidence)
# system:  POST /v1/repos/{repo}/changes/{change}/token {scope?,ttl?}; DELETE /v1/repos/{repo}/changes/{change};
#          POST /v1/repos/{repo}/system/trunk-token {ttl?}   (landing: landByPush from @weft/artifacts/git)
# subscriptions left pending (no WEFT_CF_API_TOKEN): GET|POST /v1/admin/artifacts/subscriptions {change, subscription_id}
```

Agent push: `git -c http.extraHeader="Authorization: Bearer $TOKEN" push $REMOTE HEAD:main` with trailers
`Change-Id`, `Task-Id`, `Agent-Id` (from the candidate response). Each push becomes a `checkpoint` in the repo log
(~5 s) and a `revisions` row with `status=queued` (B8 picks it up).

Live proof (creates and deletes a throwaway trunk/fork/subscription): `pnpm --filter @weft/artifacts test:live`.

## Web UI (apps/web)

Preview: `https://weft-web-preview.elier.ai` (operator key in
`~/.config/weft/web-preview-key`; gateway token in `~/.config/weft/web-preview-token.json`,
both mode 600). Deploy: `cd apps/web && pnpm exec wrangler deploy --env preview`. Access
setup, secrets, local dev and the `scripts/demo-feed.mjs` traffic generator: `docs/web-ui.md`.

## Sandbox runner (B7)

Preview: `https://weft-sandbox-preview.elier.ai` (`/v1/health` public).
Code + API: `apps/sandbox/README.md`. Numbers: `docs/research/sandbox.md`.

- Resources: Worker `weft-sandbox-preview` (DO `WeftSandbox` + container application
  `weft-sandbox-preview-weftsandbox`, image built from `apps/sandbox/Dockerfile`), R2
  `weft-sandbox-logs-preview` (`runs/<run>/<stream>/<seq>`, `runs/<run>/status.json`). Prod
  (`weft-sandbox`, R2 `weft-sandbox-logs`) is configured but NOT deployed/created.
- Deploy needs Docker running (wrangler builds + pushes the linux/amd64 image):
  `cd apps/sandbox && unset CLOUDFLARE_API_TOKEN && pnpm deploy:preview`. An unchanged image is
  not re-pushed (deploy ≈ 6 s); a changed image ≈ 2 min.
- **AI Gateway:** wrangler.toml says `AI_GATEWAY_ID = "weft"`, but gateway `weft` does not exist yet
  (needs the dashboard or an API token with AI Gateway Edit; wrangler OAuth cannot). The preview
  is therefore deployed with `--var AI_GATEWAY_ID:default` (auto-created). After John creates
  `weft`: `pnpm exec wrangler deploy --env preview` (no override).
- Secrets (`pnpm exec wrangler secret put <NAME> --env preview`): `WEFT_RUNNER_TOKEN` (set; value in
  `~/.config/weft/preview-sandbox-token`, mode 600), optional `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  (added by Outbound to `/anthropic` / `/openai` gateway calls), `AI_GATEWAY_TOKEN` (authenticated
  gateway + BYOK keys), `WEFT_RUNNER_REPORT_TOKEN`. None of them ever enters a container.

```sh
T=$(cat ~/.config/weft/preview-sandbox-token); S=https://weft-sandbox-preview.elier.ai
curl -sX POST $S/v1/runs -H "authorization: Bearer $T" -d @run.json     # RunRequest (fork.token from B6 candidates)
curl -s $S/v1/runs/<run> -H "authorization: Bearer $T"                   # state, timings.cold_start_ms, result
curl -s $S/v1/runs/<run>/logs/agent.stdout.log -H "authorization: Bearer $T"
curl -sX POST $S/v1/runs/<run>/destroy -H "authorization: Bearer $T"     # free the instance
cd apps/sandbox && node scripts/live.mjs e2e      # live proof (creates + deletes a throwaway trunk/fork)
```

## Workflows (B8)

Preview: `https://weft-workflows-preview.elier.ai` (`/v1/health` public).
Code + API: `apps/workflows/README.md`. Live evidence: `demo/evidence/b8-workflows-live/run.json`.

- Resources: Worker `weft-workflows-preview` with Workflows `weft-process-revision-preview`,
  `weft-land-change-preview`, `weft-revert-operation-preview`, `weft-best-of-n-preview`; bindings to
  D1 `weft-preview`, Artifacts `weft-preview`, `weft-sandbox-preview#SandboxRunner`,
  `weft-gateway-preview`. The gateway preview binds the same four Workflows (`script_name`).
  Prod (`weft-workflows`, `weft-*` workflow names) is configured but NOT deployed.
- D1 migration `apps/gateway/migrations/0002_workflows.sql` (applied to `weft-preview`).
- Secrets: `WEFT_SYSTEM_TOKEN` (gateway token `weft-workflows`, scopes system+observe, all repos;
  `~/.config/weft/preview-workflows-system-token`) and `WEFT_WORKFLOWS_TOKEN` (operator API;
  `~/.config/weft/preview-workflows-token`), both mode 600.
- Deploy order when bindings change: sandbox (image has `/opt/weft/weft-job.mjs`) → workflows → gateway.

```sh
cd apps/gateway && unset CLOUDFLARE_API_TOKEN && pnpm exec wrangler d1 migrations apply weft-preview --env preview --remote
cd ../sandbox && node scripts/stage.mjs && pnpm exec wrangler deploy --env preview --var AI_GATEWAY_ID:default
cd ../workflows && pnpm exec wrangler deploy --env preview
cd ../gateway && pnpm exec wrangler deploy --env preview
node apps/workflows/scripts/live.mjs        # ~3 min: all four workflows on weft-demo

ADMIN=$(cat ~/.config/weft/preview-admin-token); U=https://weft-gateway-preview.elier.ai
# per-repo workflow config (tests, resolver, layers, allow_hosts)
curl -sX POST $U/v1/admin/artifacts/repos -H "authorization: Bearer $ADMIN" \
  -d '{"repo":"weft-demo","trunk":"weft-demo","config":{"tests":{"command":["node","--test"]},"resolver":{"kind":"llm"}}}'
# land / select / revert (system or human token)
curl -sX POST $U/v1/repos/weft-demo/changes/$CHANGE/land -H "authorization: Bearer $TOKEN"
curl -sX POST $U/v1/repos/weft-demo/tasks/$TASK/select -H "authorization: Bearer $TOKEN" -d '{"n":3,"risk":"high"}'
curl -sX POST $U/v1/repos/weft-demo/system/revert -H "authorization: Bearer $SYS" -d '{"op_id":"op-…","reason":"5xx spike","evidence":{"text":"…stack…"}}'
# workflow status / step history
W=https://weft-workflows-preview.elier.ai; WT=$(cat ~/.config/weft/preview-workflows-token)
curl -s $W/v1/workflows/land/<instance> -H "authorization: Bearer $WT"
cd apps/workflows && pnpm exec wrangler workflows instances describe weft-land-change-preview <instance>
```

- A step that keeps failing (e.g. the gateway rejects a draft) retries with backoff, then the
  instance errors; `instances describe` shows the error per attempt. Git side effects are idempotent
  (CAS push; revert finds its `Weft-Reverts-Op:` trailer; op ids are deterministic), so re-creating
  the workflow for the same change/op is safe.

## Evidence: previews, screenshots, review (B10)

Previews: `https://weft-previews-preview.elier.ai` (`/v1/health` public;
everything else needs a signed URL minted by weft-workflows). Code: `apps/previews`,
`apps/workflows/src/{core/evidence.ts,evidence-cf.ts}`. Live evidence: `demo/evidence/b10-evidence-live/`.

- Resources: Worker `weft-previews-preview` (Artifacts `weft-preview`, R2 `weft-evidence-preview`);
  R2 buckets `weft-evidence-preview` and `weft-evidence` (prod, created, unused until prod deploy);
  weft-workflows-preview gained `BROWSER` (Browser Rendering), `AI` (Workers AI) and `EVIDENCE` (R2)
  bindings and vars `WEFT_PREVIEWS_URL`, `AI_GATEWAY_ID=default`. Prod config is written, NOT deployed.
- Secret `WEFT_PREVIEW_KEY` (same value on weft-previews and weft-workflows):
  `~/.config/weft/preview-evidence-key` (mode 600).
- D1 migration `0003_evidence.sql` (`tasks.acceptance`) applied to `weft-preview`.
- A repo opts into previews with `.weft/preview.json` in its tree: `{"root":"public","routes":["/","/pricing.html"]}`.
- Acceptance criteria: `POST /v1/repos/{repo}/tasks/{task}/candidates {"acceptance":["…","…"], …}`.
- Optional model overrides (vars on weft-workflows): `WEFT_REVIEW_MODEL`, `WEFT_RISK_MODEL`.

```sh
cd apps/gateway && unset CLOUDFLARE_API_TOKEN && pnpm exec wrangler d1 migrations apply weft-preview --env preview --remote
cd ../previews && pnpm exec wrangler deploy --env preview
pnpm exec wrangler secret put WEFT_PREVIEW_KEY --env preview < ~/.config/weft/preview-evidence-key
cd ../workflows && pnpm exec wrangler deploy --env preview
pnpm exec wrangler secret put WEFT_PREVIEW_KEY --env preview < ~/.config/weft/preview-evidence-key
cd ../sandbox && node scripts/stage.mjs && pnpm exec wrangler deploy --env preview --var AI_GATEWAY_ID:default   # weft-job emits patch/files
cd ../gateway && pnpm exec wrangler deploy --env preview                                                      # acceptance on candidates
node apps/workflows/scripts/live-b10.mjs    # ~90 s: 2 candidates -> evidence -> BestOfN -> land
```

- Evidence rows per revision (D1 `evidence`, `GET /v1/repos/{repo}/changes/{change}`): `preview`,
  `screenshot` (one per route; `uri` = signed PNG, `data.trunk_uri`, `data.diff_uri`, `data.diff_ratio`),
  `visual_diff`, `risk`, `review`. The `checkpoint` with `payload.ref = "refs/weft/evidence"` carries
  `payload.x_evidence`; so does the `land` record.
- Rotating `WEFT_PREVIEW_KEY` invalidates every preview/screenshot link already stored.
