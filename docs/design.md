# Weft — design v0

Working name. "Weft" is the thread woven across the warp; here, the coordination layer
woven across many agents working one codebase. Protocol: **Weft Coordination Protocol (WCP)**.

Target: Cloudflare "build the next Git platform" competition (Artifacts + Workers).
Deadline 2026-10-14. Source: https://blog.cloudflare.com/next-git-platform-on-cloudflare/

## 1. Thesis

GitHub coordinates humans at merge time. Agents need coordination at **edit time**.

Every agent changes code through tool calls (Edit/Write/apply_patch/shell). Those calls are
the real unit of change. Weft streams every tool-call edit into one strictly-ordered log per
repo, validates each edit against everything that landed in the log since the agent's base
(optimistic concurrency, read/write sets at symbol granularity), and pushes the result back
into the agent's run as **diagnostics** — the multi-agent equivalent of an editor's red
squiggles. Conflicts get resolved while the code is being written, before any commit exists.

Above that sits a thin platform: tasks (intent) → candidate changes (stable Change-Ids) →
evidence (tests, previews, screenshots, transcripts) → selection → serialized landing on
trunk → automatic revert from the operation log. Artifacts holds every repo and fork.

The competition minimum ("multiple agents working on changes concurrently") is the core of
this design, not an add-on.

## 2. Principles

1. Trunk-based. One trunk per repo. Agents work on short-lived Artifacts forks that are
   continuously rebased; everything lands on trunk through one queue.
2. Stable change identity. Every commit carries trailers `Change-Id`, `Task-Id`, `Agent-Id`
   (installed by a commit-msg hook in every agent workspace). Evidence binds to Change-Id,
   not SHA.
3. One ordered log, one sequencer. Order is assigned by the sequencer (a Durable Object per
   repo), never by wall clocks. The DO is the elected leader; Cloudflare runs the election.
4. Validate, don't lock. Agents work freely; the sequencer validates each event's
   read/write sets against writes since its base sequence number.
5. Squiggles, not walls. Diagnostics are positioned, explained, and severity-graded.
   Errors block only on committed facts or firm claims; in-flight work produces warnings.
6. Asymmetric arbitration. On conflict exactly one party gets the error (log order, then
   priority via wait-die / wound-wait). No mutual retreat, no livelock.
7. Everything is an event. Edits, claims, negotiation messages, landings, reverts. The
   log is replayable and every diagnostic cites the event that caused it.
8. Harness-neutral. WCP is a wire protocol; each harness gets a thin adapter over its
   native hooks. Claude Code first, Codex second, then Gemini CLI / Cursor / Copilot.
9. The editor disappears. Agents change code with no human watching an editor. The
   human surface is a FEED — intent, edits, squiggles, negotiations, landings, reverts —
   readable on any device (first client: the Hérmes iOS app), with editor-free controls:
   approve, undo, pause, message an agent. WCP has a read-only observer role and a
   human-action scope for this. Every event carries a one-line human summary.
10. Dogfood. Weft's own build is coordinated by Weft (Hermes adapter on the build's
   kanban workers), and its change log is watched from the phone.

## 3. Core objects

- **Task**: kanban card. goal, acceptance criteria, risk tier, predicted scope (symbols),
  candidate count N, status, parent.
- **Change**: one agent's attempt at a task. Stable Change-Id, Artifacts fork, list of
  revisions (git SHAs). A task can have N competing changes (candidates).
- **Event** (WCP): `{seq, repo, agent, task, change, base_seq, kind, files, reads[], writes[],
  diff?, intent?, ts}`. kinds: `intent`, `edit`, `checkpoint` (push), `claim`, `release`,
  `negotiate.*`, `land`, `revert`.
- **Claim**: predicted (from planner) or actual (from edits) writes, with TTL.
- **Diagnostic**: `{severity: info|warning|error, file, range?, symbol, message,
  caused_by_seq, caused_by_agent, caused_by_task, suggestion}`.
- **Evidence**: per revision — test results, preview URL, screenshots, review verdict,
  cost, transcript pointer.
- **Operation**: append-only op log entry with refs before/after; undo = new op (revert
  commit on trunk, ref rewind elsewhere).

## 4. Validation rules (sequencer)

For incoming event E with base `b`, let W = writes of all accepted events with seq > b.

1. `E.writes ∩ W ≠ ∅` and the overlapping writer is committed/landed → **error** (stale
   overwrite). If the overlapping writer is in-flight → **warning** + arbitration.
2. `E.reads ∩ W ≠ ∅` where W changed a signature/exported contract → **error** (stale
   assumption: you call something that changed). Body-only changes → **warning**.
3. Else accept, assign seq, broadcast to agents whose reads/writes/claims intersect.

Symbol keys: `path#qualified.name` (e.g. `src/auth/session.ts#refreshToken`). Reads =
referenced symbols (calls, imports, types). Writes = symbols whose span the diff touches;
signature-vs-body distinguished. TypeScript/JavaScript via the TS compiler API; other
languages via tree-sitter (Python first). Support matrix: [languages.md](languages.md).

Arbitration: earlier seq keeps the area by default. Higher-priority task may wound a
younger one (wound-wait). The losing agent may: retreat (rework), wait (until the other
lands), or negotiate (`negotiate.propose` to the owner, e.g. "keep old signature as
overload"), or escalate to coordinator (merge tasks).

## 5. Injection points (per harness)

| Need | Claude Code | Codex | Others |
|---|---|---|---|
| pre-edit allow/warn/deny | PreToolUse (deny + reason) | PreToolUse (beta) | verify (S2) |
| post-edit ship diff + inbox drain | PostToolUse (additionalContext) | PostToolUse | verify |
| refuse to finish while errors open | Stop hook | SessionStop? verify | verify |
| last gate | git pre-commit | git pre-commit | git pre-commit |

Capability levels in WCP: L0 observe (file watcher), L1 inject (context back to model),
L2 block (pre-edit deny), L3 gate (stop/commit refusal). Adapters declare their level.

## 6. Platform layer

1. Intake: task created → planner predicts scope → predicted claims → overlap triage.
2. Dispatch: fork trunk in Artifacts per candidate, repo-scoped token, sandbox with
   agent + adapter + hooks, AGENTS.md + task context.
3. Continuous sync on every checkpoint push (Artifacts event → Queue → Workflow):
   rebase onto trunk (git → Mergiraf structural merge → resolver agent → back to agent),
   tests, preview deploy, screenshot, review agent → evidence.
4. Selection: candidates ranked (tests, review, diff size, visual diff, cost). Risk tier
   decides auto-land vs human approval (Workflows waitForEvent).
5. Landing: submit queue in the repo DO; final rebase + presubmit; trunk advance is
   compare-and-swap (non-fast-forward push rejected). Op logged, claims released.
6. Post-land: Workers Builds deploys trunk; Tail Worker errors → Analytics Engine; spike
   after landing → revert op, task reopened with stack trace as evidence.

## 7. Cloudflare mapping (every product load-bearing)

Core: Artifacts, Workers, Durable Objects (SQLite), Agents SDK, Workflows, Queues,
Sandbox SDK/Containers, Workers Builds + Previews.
Strong: AI Gateway (all model calls tagged with task/change → cost + transcripts),
Workers AI (embeddings, risk classification), Vectorize (code/task index), D1 (cross-repo
tasks/changes/evidence), R2 (transcripts, logs, screenshots, op archives), Browser
Rendering (preview screenshots, visual diff), Tail Workers + Observability (auto-revert
signal), Analytics Engine (landing/conflict/agent metrics), Access (humans + service
tokens), Workers for Platforms / dynamic Workers (per-repo policies as code).
Garnish: Secrets Store, Cron Triggers + DO alarms, KV (policy/config cache), Email
Routing/Workers (task by email, approvals), Pipelines + R2 Data Catalog (op log
analytics), Web Search API via AI Gateway.
Skip unless a real use appears: Hyperdrive, Images, Stream, Realtime, Turnstile.

## 8. Demo (5–10 min video)

1. Board with 6 tasks × 3 candidates = 18 real agents (Claude Code + Codex + Gemini).
2. Two tasks collide on one function: agent B gets a live squiggle at its call site
   because agent A changed the signature; B reroutes on its own. Shown in the agent
   transcript and on the board.
3. Same-file, different-function edits land cleanly where plain git would conflict.
4. Negotiation: B proposes an overload; A accepts; both land.
5. Candidate comparison with preview screenshots + evidence; human approves one.
6. Planted bug lands → production error spike → auto-revert from the op log → card
   reopened with the stack trace.
7. Close: WCP as an open spec; adapters for N harnesses; proposal to AAIF (Agent Plugins
   1.0 explicitly left hooks unstandardized).

## 9. Open questions (spikes)

- S1 Artifacts: can a Worker binding create commits / move refs, or must landing push
  from a sandbox? Event payload shapes, limits, Workers Builds wiring, Workers Paid plan.
- S2 Hooks: exact block/inject/stop semantics per harness.
- S3 Analyzer: precision of TS symbol read/write extraction; Mergiraf in a container.
- Sandbox cold-start → batching policy for continuous sync.

## 10. Repo layout (target)

```
packages/protocol     WCP types, JSON schema, spec conformance tests
packages/analyzer     TS read/write-set extraction (diff → symbols)
packages/sequencer    RepoCoordinator DO (log, validation, claims, queue, ws)
packages/adapters/*   claude-code, codex, gemini, cursor, watcher (L0)
apps/gateway          Worker: API, MCP endpoint, Artifacts events, dashboard
apps/workflows        ProcessRevision, LandChange, RevertOperation, BestOfN
apps/sandbox          agent/test/merge container images
apps/web              board, candidates, evidence UI
demo/                 demo target repo + scripted scenario
docs/                 design, protocol spec, research, runbook
```

## Update 2026-10-03 (PM, from S1)
- Artifacts binding is read-only for git objects (create/fork/info/readFile/createToken); landing = `git push` with a short-lived write token from a trusted git client (sandbox). No binding-level ref CAS: rely on push semantics.
- Per-fork Workers Builds previews have no documented API; previews use one preconfigured repo with candidate branches.
- Account is on Workers Free → Artifacts/Containers return access denied until upgraded to Workers Paid. All Artifacts/sandbox code sits behind ArtifactsLike/SandboxLike interfaces with a local git-backed fake.

## Update 2026-10-03 (P1, protocol spec)
WCP v0.1 is specified in `docs/protocol/wcp-v0.md` (normative; implemented by `packages/protocol`). Refinements to §3–§5 (details: spec Appendix B):
- Rejected events are logged (seq, `status: rejected`) without effects, so conflicts show in the feed and can be cited.
- Pre-edit validation is a side-effect-free `check` submission (L2); the post-edit `commit` enters the log.
- `base_seq` may not exceed what the coordinator delivered to the session; landings count toward base only after the agent rebased.
- In-flight overlaps are arbitrated through claims (every accepted edit is a soft claim); §4 rule 1 errors only on committed (landed/reverted) writers. §4 rule 2 stays literal (signature change ⇒ error).
- Seniority = task priority, then first-accepted-event seq; wound-wait default, wait-die per repo.
- Added kinds `message`, `control`, `join`/`leave`, `negotiate.counter`; observer + human API per §9 of the spec.

## Update 2026-10-03 (B2, sequencer)
- `RepoCoordinator` (one DO per repo, SQLite) runs `SqlCoordinator`, a table-backed port of the protocol reference; differential tests require identical output to the reference on every conformance step.
- Every state change goes through an **input journal** (`journal` table: op, args, clock). Replaying it into an empty DO reproduces the log and all state byte-for-byte; one operation runs at one frozen instant (found by the replay test: the local runtime clock advanced mid-call).
- Tokens/repos live in a `Registry` DO, issued via `/v1/admin` (operator secret). Observer views redact secrets in `diff`/`intent` (spec §13); the log keeps originals.
- Not yet: `/v1/feed/stream` (spec SHOULD), rate limiting of `check` (SHOULD), Access-gated human tokens (SHOULD). Preview Worker is `weft-gateway-preview` (runbook's preview env); the bare `weft-gateway` name is left for the PM's production deploy.

## Update 2026-10-04 (B16, Hermes adapter + dogfood)
- `packages/adapters/hermes`: a Python Hermes plugin at L3. `pre_tool_call` runs a `check` on
  `write_file`/`patch` and blocks with `verdict.context`. `post_tool_call` sends a `commit`,
  including edits made through the terminal, which are diffed against a snapshot of dirty
  files taken before the command; a HEAD move becomes a `checkpoint`. `transform_tool_result`
  adds `weft_diagnostics` to the tool result. `kanban_complete`/`kanban_request_review` and
  `pre_verify` go through `gate stop`, and a terminal `git commit` goes through `gate commit`.
  Symbol keys come from `@weft/analyzer`, bundled to one `analyze.mjs` that runs as a
  persistent node child, plus cross-file reads from relative imports. Non-TS files get a
  whole-file key `path#*`.
- Scope guard: hooks do nothing outside `~/github/weft` (incl. `.worktrees/*`, so all
  worktrees share repo-relative keys) and `~/code/hermes-ios/.worktrees/weft-feed` (key prefix
  `ios/`). Installed on profiles default/backend/arq, connected to the preview gateway, repo
  `weft`. Agent ids are `hermes-<profile>` (one repo-scoped token per profile) and change ids
  are `hermes-<profile>/<kanban task id>`, so concurrent cards on one profile still arbitrate
  as separate changes.
- Dogfood is live: real kanban workers produced the first collision, and the PM cron's own
  checkpoints are in the same log (`demo/beats/built-under-weft.md`).
- Design gap (proposal): Weft's build lands by `git merge` in the PM, outside Weft. Nothing
  appends `land`, so soft claims of finished cards linger until TTL (30 min) and later cards
  get `claim_wait` against work that is already on main. Proposal: the PM's merge step posts a
  system `land {sha, op_id}` per merged change (system token). That releases its claims and
  sends `trunk_advanced` to everyone affected. B8's landing queue should own this; until then
  a small PM script can do it.
- Done (t_4ea09be8): `packages/adapters/hermes/scripts/weft_land.py`, run by the PM after each
  `git merge` (weft-pm skill, docs/runbook.md). It maps the merged branch to kanban task ids
  (kanban DB, branch name, `[t_…]` commit tags), finds their changes via `GET /events?task=`, and
  posts `land {sha, op_id = uuid5(repo/change/sha)}` with `base_seq` = head for every change with
  edits after its last land; R1 rejections are retried on a fresh head. When B8 lands, the queue
  takes this over: the PM enqueues instead of merging, and the script goes away.
- Adapter fix found by the live landing check: a rebase checkpoint's verdict repeats the still
  unacked `trunk` item, which re-set the adapter's rebase floor right after the commit cleared
  it, so a rebased agent's next edit of a landed symbol was blocked with `stale_overwrite`. The
  floor is now cleared after the verdict is queued.
- Adapter escape hatches, so a dogfood worker can't get wedged: `WEFT_HERMES_MODE=advise`
  (inject only, never block). A completion refused twice for the same open errors is treated
  as a deliberate retreat on the third try: the adapter appends a `release` for those keys,
  which is visible in the feed.

## Update 2026-10-04 (B4, Claude Code adapter)
- `packages/adapters/claude-code` is the first L3 adapter, proven with two real `claude -p` sessions against the preview gateway (`demo/evidence/README.md`): B's stale call is denied at PreToolUse with a positioned `stale_assumption` squiggle, B reroutes, and the merged result typechecks; with B told to give up, the Stop gate refuses 5× and the git pre-commit gate refuses the commit.
- Pre-edit validation uses `submit mode:"check"` (spec §5.3), not an `intent` event: `intent` is never validated (§4.2).
- **The squiggle must carry the other side's code.** In-flight edits live in the other agent's fork, so "read the new signature" is impossible from the receiver's checkout. The adapter fetches the causing event (`GET /events/{seq}`; agent tokens get `observe` scope) and quotes its hunks. Proposal: the coordinator could attach the relevant hunk to `stale_assumption`/`contract_changed` diagnostics itself (spec v0.2).
- **base_seq advances only when coordinator text reaches the model**, to that response's `delivered_through`. Advancing on silent responses would let an agent that read a file before a signature change submit with a base past it, and R2 would miss the stale call (the demo collision). Remaining hole (protocol, not adapter): keys an agent starts using *after* a context injection that advanced its base past an unrelated-at-the-time signature change are not flagged; a per-key/per-file knowledge base would close it (proposal for v0.2).
- Open errors are per WCP session: an adapter must not `bye` a session with open errors at harness exit, or they are silently forgiven. The Claude adapter keeps such sessions alive (detached heartbeat) so the pre-commit gate and resumed conversations still see them.
- Change id = the `Change-Id` trailer (`I` + 40 hex), generated per checkout+task at install.

## Update 2026-10-04 (B6, Artifacts integration)
- `packages/artifacts`: `ArtifactsLike` (structural subset of the binding), fork naming `weft-<repo>-<task>-<n>`, Gerrit-style Change-Ids (`I`+40 hex) and trailer parsing, `pushed` event decoding with an idempotency key, per-fork event-subscription client, in-memory fake (Workers tests) and git-backed fake + **`landByPush`** (Node/sandbox): fast-forward-only `git push --force-with-lease=<ref>:<expected>`; a lost race is `stale_trunk` (live-verified: Artifacts answers `[remote rejected] (stale ref)`).
- Gateway: `POST /v1/repos/{repo}/tasks/{task}/candidates` (system) forks trunk, mints a repo-scoped write token (returned once), registers the Change-Id in D1 and subscribes the fork's `pushed` events to Queue `weft-artifacts-events`; the queue consumer records each push as a revision (D1) and appends a WCP `checkpoint` via the system API, then calls `triggerProcessing` (stub → B8).
- Protocol change: the **system** may append `checkpoint` (an observed push, `actor:{type:system,id:artifacts}`, attributed to the change and, if a session announced the change, its agent). Spec table §4.2/§3 updated; reference + SqlCoordinator identical.
- Correction to §6.3: Artifacts `pushed` subscriptions are per repo (no namespace wildcard), so "Artifacts event → Queue" means one subscription per fork, created at candidate time (needs `WEFT_CF_API_TOKEN`; without it candidates are `subscription: pending` and an operator reconciles via `/v1/admin/artifacts/subscriptions`).
- D1 `weft` (prod) / `weft-preview`: `artifacts_repos`, `tasks`, `changes`, `revisions`, `evidence`, `artifact_events` (apps/gateway/migrations).

## Update 2026-10-04 (B9, web UI)
- `apps/web` (Worker `weft-web`, preview `weft-web-preview`) serves a dependency-free ES-module app plus an allow-listed `/api/*` in front of the gateway over a service binding; details and Access setup in `docs/web-ui.md`. The browser never holds a WCP token: the Worker uses its own `observe`+`human` token and annotates actions with the signed-in identity.
- Views: Live (log + squiggle feed over the repo DO WebSocket, cause links, animated Replay for recordings), Board, Task (candidates side by side: diff stats from log diffs, D1 evidence, revisions, Approve), Ops (land/revert op log with Undo). All state is derived client-side from the WCP log (`public/lib/model.js`) plus the D1 index, so every view updates live.
- Gateway addition: `GET /v1/repos/{repo}/tasks` (observe) — tasks with candidates (no tokens) and a per-candidate evidence tally, for the board.
- Op log for humans is derived from `land`/`revert`/`control undo` records (observer scope) rather than `/system/ops` (system scope), so the UI never needs a system token.
- Approve = WCP `control approve` (spec §9.6) **and**, when a `BESTOFN` Workflows binding exists, `sendEvent("approve")` to instance `bestofn-<repo>-<task>`. B10/BestOfN must use that instance id (or the UI's `bestOfNInstanceId()` must change with it).
- Auth: Cloudflare Access JWT verified in the Worker (aud/iss/exp/RS256); operator-key session as fallback; fails closed. Access itself needs a dashboard step by John (wrangler OAuth has no Access scopes).

## Update 2026-10-04 (B7, sandbox runner)
- `apps/sandbox` (`weft-sandbox[-preview]`): one Durable Object + one container per agent run (Containers, `scheduling_policy=durable_object`). Sandbox SDK 1.0 only adds file helpers on top of `ctx.container`; Weft drives `start/exec` directly. Image: git, node 24, Claude Code 2.1.289, Codex 0.160.0, Mergiraf 0.20.0 (registered as git merge driver `mergiraf`), pnpm, the Claude WCP adapter (Codex adapter slot staged when B5 ships a bundle) and `/opt/weft/agent-run.mjs` (clone fork → trailers → inject task/AGENTS.md → adapter install with the candidate's Change-Id → headless harness → push → `result.json`).
- **The container holds no secrets** (stronger than "secrets via wrangler secrets"): it starts with `enableInternet:false` and every HTTP(S) request goes through the Worker's `Outbound` entrypoint with per-run props. Outbound adds the fork token (this fork's path only), the Weft agent token (replacing the adapter's placeholder), the provider key / gateway token for AI Gateway `weft`, and **forces** `cf-aig-metadata {run, task, change, agent, repo}` so cost/transcript attribution cannot be spoofed by the agent; everything else is 403. Live-verified: AI Gateway log shows the metadata + tokens + cost; a sandbox push became WCP checkpoint #1 of the candidate's change; Claude Code's SessionStart hook reached the coordinator through the token swap.
- Cold start (container start → first exec) is 0.27–0.42 s on standard-1/2 (median 0.38/0.34 s, warm hosts); clone of the demo fork 1.1 s; `lite` cannot boot the 1.17 GB image. Consequence for §6.3: no batching for latency. Keep one warm sandbox per change for ProcessRevision (DO named by Change-Id, 30 min inactivity timeout, incremental fetch), coalesce bursts to the newest head per change, and batch only in the land queue to save test time. Details: `docs/research/sandbox.md`.
- Booting happens in the DO alarm, not the request: a cold start inside `blockConcurrencyWhile` (30 s cap) reset the DO in the first live probe.
- The full model transcript is the harness's own JSON event stream (Claude `stream-json`, Codex `--json`) shipped to R2 per run; AI Gateway's `getLog` returns metadata/tokens/cost but not bodies.
- Gap: AI Gateway `weft` must be created by John (dashboard / API token); the preview runs with `AI_GATEWAY_ID=default` until then. Real Claude/Codex sessions need a model credential (Worker secret or BYOK in the gateway); Workers AI models work without one.

## Update 2026-10-04 (B8, workflows)
- `apps/workflows` (`weft-workflows[-preview]`): **ProcessRevision**, **LandChange**, **RevertOperation**, **BestOfN** as Cloudflare Workflows. The logic is runtime-neutral (`src/core`, `StepLike` + `Deps`) and is tested end to end in Node with a fake durable step, real git + Mergiraf, D1 = node:sqlite with the gateway migrations and a journaled `SqlCoordinator`; the Cloudflare glue binds D1, Artifacts (token minting), the sandbox (`SandboxRunner` RPC) and the gateway (system API).
- **Git runs in the sandbox, not the Worker**: `apps/sandbox/image/weft-job.mjs` (`rebase` | `land` | `revert`) in a `script`-harness container per job (cold start 0.5–10 s). Runs now take extra `remotes` (trunk + fork); Outbound adds each repo's token for its path only. Tokens are minted inside the workflow's start step and never become step output.
- **Layered merge** = per-commit replay: plain git → Mergiraf (as merge driver, diff3) → resolver agent (`llm`: Workers AI via AI Gateway with forced metadata; `command`: any harness) → bounce. The resolver fails closed (markers left, empty/truncated answer). The rebased result goes to the fork's `refs/heads/weft/rebased` (the agent's branch is never rewritten); LandChange reuses it when it sits exactly on today's trunk. The gateway ignores pushes to `refs/heads/weft/*`.
- **Bounce to agent** needs a system-authored message: WCP now lets the **system** append `message` (spec §1/§4.2; reference + SqlCoordinator identical, differential test). ProcessRevision bounces conflicts (with hunks) and failing tests; LandChange bounces failed presubmits; RevertOperation tells the agent why its change was reverted.
- **Submit queue** = the repo DO's existing `submit_queue` (`enqueue`/`queue_status`, B2) driven over the gateway's system API: LandChange enqueues, waits until it heads the queue (durable sleeps), marks `landing`, lands by CAS push (3 attempts on `stale_trunk`), then appends `land {sha, op_id}` (op log, claims released, queue entry landed). Op ids are deterministic (`sha256(repo/change/after)`) and checked against `ops` before appending, so retries never double-log. D1 `landings` mirrors the op log with git before/after (needed for revert ranges).
- **Revert** works from the op log: `revert` of `before..after` on the current trunk (Mergiraf layer on conflict), one commit with a `Weft-Reverts-Op:` trailer (idempotent re-runs), `revert {op_id, reverts_op_id, reverts_seq, sha, reason, requested_by: Actor}`, change `reverted`, task reopened, evidence (e.g. stack trace) attached. Human `undo` and `POST /system/revert` (auto-revert hook for B-later Tail Worker) both start it.
- **BestOfN**: waits for N processed candidates (`candidate` events from ProcessRevision, D1 polling as backstop), ranks (tests ≫ rebase layer > churn > cost), records `rank` evidence, then auto-lands (risk `low`) or `waitForEvent("approve")` (risk `medium`/`high`) and starts LandChange for the winner. Instance id `bestofn-<repo>-<task>` and event `approve` match `apps/web`.
- Correction to §6.3: ProcessRevision coalesces to the newest head per change (an older checkpoint is `superseded`), per the B7 batching note; no warm per-change sandbox yet (each job is a fresh container, destroyed when its result is read).
- Known gaps: kanban "close card" is the D1 task status (`landed`), not the Hermes kanban card; the PM's `weft_land.py` can now be replaced by `POST /changes/{id}/land` once the build itself pushes through Artifacts. Preview screenshots / review agent evidence: see the B10 update below.

## Update 2026-10-04 (M1, Claude Code + Codex on one coordinator)
- M1 scenario (`demo/scenarios/m1.md`, driver `demo/m1-collision.mjs`, target `demo/target-app`): Claude Code changes `createSession`'s signature while Codex, which planned against the old one, implements a caller. Codex's apply_patch is denied at PreToolUse with `stale_assumption` citing Claude's event and quoting its diff. Codex passes the new options, both branches merge with no conflict, and `tsc` + tests are green. 2/2 valid runs passed; 2 runs were aborted by the Codex model backend's quota. Report: `demo/evidence/m1-report.md`.
- Codex adapter fixes (verified live, codex-cli 0.154):
  - Hooks go in `.codex/hooks.json`, not settings.local.json. For a linked git worktree, Codex reads the project layer from the **main** worktree, so the installer writes there too; the hook command resolves the checkout from the hook's cwd.
  - SessionStart/UserPromptSubmit/Stop/SessionEnd are registered, because without SessionStart, base = head at the first edit and R2 can never fire. `exec resume` keeps the hook session_id.
  - `Update File` patches are checked pre-edit (full apply_patch grammar).
  - **Models without Codex catalog metadata (any OpenRouter model) get no native apply_patch tool.** They run `apply_patch <<'PATCH'` through the shell, Codex applies it, the hooks see `Bash`, and no PostToolUse fires. The adapter routes shell apply_patch through the same check, and commits a pending pre-edit from disk at the next hook.
- Git worktrees share `<common>/hooks`: two adapters in two worktrees overwrote each other's commit-msg/pre-commit. Both installers now set a worktree-scoped `core.hooksPath`.
- Hook latency against the preview gateway: about 400 ms per coordinator call, about 0.55 s for a pre-edit check hook. Diagnostics overhead is under 0.1% of the receiving agent's tokens; the quoted causing hunk is about 60% of the deny text and is what makes the reroute one-shot.

## Update 2026-10-04 (B10, evidence)
- **Previews come straight from Artifacts, not from a deploy.** `apps/previews` (`weft-previews[-preview]`) serves `/p/<artifacts-repo>/<sha>/<sig>/…`: the static site of that exact commit, read with the Artifacts binding (`readFile({ref: sha, path})`). The site root and key routes come from `.weft/preview.json` in the tree (`{"root":"public","routes":["/","/pricing.html"]}`). URLs are capabilities (HMAC over repo+sha with `WEFT_PREVIEW_KEY`, shared with weft-workflows), immutable, and isolated per document by a `sandbox` CSP (opaque origin). Root-relative URLs in HTML are rewritten into the prefix (HTMLRewriter). No deploy credential, no per-candidate Worker, no Workers Builds (S1: per-fork Builds have no API; `wrangler versions upload` would need an API token in the sandbox, which wrangler OAuth cannot mint). Design change vs §5/§6.3: "Workers Builds preview" → "Artifacts-served preview of the rebased revision"; server-rendered apps need a Worker-Loader variant (not built).
- **ProcessRevision evidence stages** (`src/core/evidence.ts`, one durable step each), after rebase + tests, skipped for a failing candidate: (1) **preview** of the candidate as it would land (`weft/rebased` sha in the fork) and of trunk at the rebase base; (2) **screenshots** via Browser Rendering (`@cloudflare/puppeteer`, 1280×800) of each key route, candidate and trunk, pixel diff computed in the headless browser (canvas), PNGs in R2 `weft-evidence[-preview]` served as signed `/e/<sig>/<key>` URLs, plus a `visual_diff` row (per-route ratio); (3) **risk**: deterministic path/size heuristic as a floor (migrations/auth/CI/deploy config → high; deps/config/SQL/deletions/>400 lines → medium) raised, never lowered, by a Workers AI classifier (`@cf/meta/llama-3.1-8b-instruct-fast`); (4) **review agent**: Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` through AI Gateway (`default` until `weft` exists; metadata `purpose/repo/change`) scores the diff + tests + visual diff against the task's **acceptance criteria** (`tasks.acceptance`, migration 0003, set via `POST …/tasks/{task}/candidates {acceptance:[…]}`; falls back to the title). It fails closed: a "pass" with an unmet/unknown criterion becomes fail/needs_human. A missing capability is `info` evidence; an operational failure is `fail` evidence.
- weft-job's `rebase` result now carries `patch` (unified diff onto..rebased, capped 48 KB, secrets redacted) and `files` (name-status) for the classifier and reviewer.
- **x_evidence**: after the stages ProcessRevision appends a system `checkpoint` (`ref: refs/weft/evidence`, same sha) whose payload carries `x_task_title` and `x_evidence {preview_url, trunk_preview_url, tests{passed,failed,total}, screenshots[], visual_diff[], review{verdict,summary,score}, risk, cost_usd}`; LandChange's `land` payload carries the same (rebuilt from D1 rows). Hérmes and the video read payload fields (I1b).
- **Selection uses it**: rank adds up to +60 for a review pass (by score) and −300 for a review fail (still eligible); BestOfN asks a human when the top candidate's classified risk exceeds the task's tier or its review is not a clean pass.
- B9 shows per-candidate screenshots with route, Δ%, trunk + diff links, preview (candidate/trunk), visual row, review verdict + score + per-criterion ✓/✗, and a risk metric.
- Live (`apps/workflows/scripts/live-b10.mjs`, `demo/evidence/b10-evidence-live/`): two candidates for "Add kiwi to the pricing page" — the right one got review pass 100 (pricing Δ 0.14%, home 0.00%), the wrong one (changed the home hero, Δ 1.67%) fail 33; BestOfN auto-landed the right one; push → landed in ~80 s.
- Gaps: preview only for static sites; no cost evidence for the review/risk calls yet (`cost_usd: null`); the review is text-only (the screenshot bytes hook exists, no vision model wired); preview links are capabilities without expiry.

## Update 2026-10-04 (B13, production signal → auto-revert)
- §6.6 is live on preview. Demo target = Worker `weft-demo`, deployed by **Workers Builds from the Artifacts trunk** (`weft-preview/weft-demo`, `main`); every land/revert push redeploys it (5–40 s observed). The Artifacts connection is a one-time dashboard step (Builds API needs Workers CI permissions the wrangler OAuth token lacks).
- The target declares `tail_consumers: weft-production-signal[-preview]` in its own wrangler config. `apps/production-signal` = Tail handler (exception-only → Analytics Engine `weft_prod` with `index1 = repo`, plus Queue `weft-prod-events`) and Queue consumer (detector). Detector: ≥ threshold (5) exceptions within the window (600 s) after the latest unreverted `land` in D1 `landings` → `RevertOperation` instance `prod-revert-<op_id>`, `requested_by: system/weft-production-signal`, evidence `production_tail_error` = the stack trace (+ request method/path). A D1 unique latch (`production_reverts`) makes it once per land op under queue redelivery.
- Live proof (`demo/evidence/b13-auto-revert-live`): planted bug landed → 500s in 6 s → revert started 16 s after the land → trunk reverted and redeployed 43 s after the land; task reopened, change `reverted`, agent told.
- Facts learned live: Tail `exceptions` are top-level on the trace item and `stack` holds frames only; Analytics Engine allows one index per data point. The workflows operator API answers 400 `instance.not_found` for unknown ids.
- Limits/gaps: the detector attributes any exception in the window to the latest land (no per-route or baseline-rate comparison; the demo target returns 404, not an exception, for expected errors). It treats a repo's single Worker as its production; multi-Worker repos need a script→repo map instead of the `WEFT_REPO` var.

## Update 2026-10-04 (B11, negotiation + arbitration)
- **All four loser options are protocol actions now** (spec §7.2, §7.4, §7.6). Retreat and wait
  were already implicit; negotiate (`negotiate.propose|counter|accept|reject`) existed on the
  wire but no agent could send it; escalate was "surface to humans". B11 closes both:
  - **Agents negotiate from their shell.** Each adapter install writes `<checkout>/.weft/bin/weft`
    (`negotiate propose|accept|reject|counter|escalate`, `inbox`; grammar shared in
    `@weft/protocol` `parseNegotiate`). `propose`/`escalate` without `--to` target the agent behind
    the session's newest open error, with the keys it blocks; `--wait N` blocks until the reply.
    Every loser-side error the adapter injects (`stale_assumption`, `claim_wait|die|wounded`) ends
    with an options line that spells out the exact commands.
  - **Proposals reach the owner as injected context**: the inbox item renders as
    `[weft negotiation] #n <agent> (change, task) proposes to you: overload on <key> — "<terms>".
    Answer it: …` plus the answer commands, at the next hook (PostToolUse/UserPromptSubmit/
    SessionStart).
  - **Negotiation is binding (stop gate, spec §8.4).** The stop gate refuses while a proposal
    addressed to the session is unanswered, and — for an accepted `overload` — until the giver has
    an accepted edit of the agreed keys. A new session of the change gets the pending items
    redelivered, so an owner that already exited sees the proposal when it is resumed.
  - **Escalation merges tasks** (`negotiate.escalate`, spec §7.6). With repo policy
    `escalation: auto` (default) the coordinator appends a system `control merge` record; with
    `human`, a human `merge` action does it. Accepting `merge_tasks` terms merges too. A merged
    group is one unit for validation: no R1/R2 between members, no arbitration between members'
    claims, seniority = the lead's, cross-member open errors forgiven, every member told.
- **Wound-wait priority comes from the task**: `hello.task.priority` (adapters: `--priority`,
  Hermes adapter: the kanban card's priority; sandbox: `spec.weft.priority`) is the first
  seniority key; a merged group ranks by its lead, so a higher-priority change still wounds a
  whole group (scenario `escalation-merge`).
- SQL coordinator: schema v2 adds `changes.merged_into` via an idempotent `ALTER TABLE` on
  startup (existing preview/production DOs migrate in place); configs written before B11 read as
  `escalation: auto`. 4 new conformance scenarios; reference, SqlCoordinator and the gateway DO
  are identical on all 15, journal replay included.
- Demo: `demo/b11-negotiation.mjs` (two live `claude -p` agents; evidence `demo/evidence/b11/`).
- Gaps / proposals: landing workflows should land a merged group together (LandChange per group);
  the web UI shows negotiation records generically by summary (thread view is a follow-up); the
  Hermes adapter has no `negotiate` command yet; a Codex agent needs
  `sandbox_workspace_write.network_access=true` for its shell to reach the coordinator.

## Update 2026-10-04 (B12, more harnesses + L0 watcher)
- **One WCP core, thin translators.** The Claude Code adapter's core (`ClaudeAdapter`) now takes
  an `identity {harness, adapter, capabilities}`; `claude-code/src/host.ts` holds everything
  that is not harness-specific (install, git hooks, heartbeat, `negotiate`/`inbox`, status,
  hooks.jsonl timing, "carry" of context a harness cannot deliver at the hook that produced it)
  and `tools.ts` normalizes tool calls by argument shape. New adapters are translators of a
  few hundred lines each: `packages/adapters/{cursor,opencode,gemini,watcher}`. Codex still has
  its own copy of the core (apply_patch multi-file); folding it in is a follow-up.
- **OpenCode (live, L3 with a caveat).** A generated plugin bridges `tool.execute.before`
  (throw = deny), `tool.execute.after` (append to tool output), `experimental.chat.system.transform`
  (welcome) and `session.idle` (`client.session.prompt` = stop refusal) to the Node bundle.
  Verified live on 1.18.31 with `opencode/big-pickle`. The stop gate needs a long-lived OpenCode
  process (`opencode serve` + `run --attach`, or the TUI): one-shot `opencode run` exits on idle.
  OpenCode reads its project dir from `$PWD`. `apply_patch` is accounted after the fact only.
- **Cursor CLI (documented L3, not live-verified).** `.cursor/hooks.json`: `preToolUse` deny with
  `agent_message`, `postToolUse` `additional_context`, `stop` `followup_message` (`loop_limit` 5),
  `afterFileEdit` as a deduplicated safety net. The live run was blocked by an expired
  `cursor-agent` login (browser OAuth needed from the account owner). Cursor does not document
  its edit tools' schemas, so edit detection is by argument shape.
- **Gemini CLI (fixture-only, labelled).** `BeforeTool`/`AfterTool`/`AfterAgent`/`BeforeAgent`
  mapping per the reference; no usable Gemini auth.
- **L0 file watcher.** `weft-watch run|scan`: snapshot diff per changed file → `commit` edit
  with analysis; diagnostics printed for the human; git pre-commit gate. Declares
  `{level 0, observe async, inject false, commit_gate "native"}` (spec §8.5 now defines `native`
  as git's own pre-commit hook).
- Demo: `demo/b12-harnesses.mjs` (Claude Code + Codex + OpenCode + watcher on one coordinator;
  `--sim-a`, `--give-up` for the stop-gate proof). Evidence `demo/evidence/b12*/`.

## Update 2026-10-04 (M2, the full demo end to end)
- `demo/run-full.sh` (driver `demo/m2-full.mjs`, scenario `demo/scenarios/full.md`, report
  `demo/evidence/m2-report.md`) runs §8 beats 1–6 on the preview stack in one command: 6 tasks ×
  3 candidates = 18 live agents (Claude Code, Codex, OpenCode per task), each in a clone of its own
  Artifacts fork with its adapter, all on one coordinator (`weft-demo`); every push goes through
  ProcessRevision → BestOfN → LandChange; the planted-bug beat is B13's `live.mjs prove`.
- **Protocol change: alternatives (spec §7.7).** Candidates of one task are competitors, not
  collaborators: at most one lands. Before M2 the coordinator treated them like any two changes,
  so with live best-of-N on one coordinator the second and third candidate got `claim_wait` /
  `claim_wounded` against their siblings and `stale_assumption` on a sibling's signature edit.
  Now changes with the same `task` skip in-flight R1/R2, claim arbitration and `contract_changed`
  between each other; a landed/reverted alternative is trunk for the rest. Reference +
  SqlCoordinator identical (new conformance scenario `alternatives-best-of-n`).
- Analyzer limit found live: a change to an `export const f = (…) => …` arrow function is
  classified as a `signature` write (the declaration has no body span), so two tasks editing
  adjacent arrow one-liners collide with `stale_assumption`. Function declarations get `body`
  writes, even on one line. The demo seed uses function declarations; teaching the analyzer the
  arrow's parameter/return-type span is a follow-up.
- Ops facts: concurrent `opencode serve` processes share one SQLite store and fail with
  "database is locked" — give each agent its own `XDG_DATA_HOME`. The `*.elier.ai` custom
  domains had no public DNS records during M2 (the Cloudflare authoritative servers answered
  NXDOMAIN although the Workers custom domains exist and the edge serves them by SNI); the
  driver pins them locally (`WEFT_PIN_EDGE_IP`, `demo/lib/pin-dns.cjs`) and server-side
  Browser Rendering of preview URLs still worked.
- The human approval in the driver goes through the same gateway human action the web UI's
  Approve button sends (`POST /actions {action: approve}` with John's `observe+human` token),
  which forwards to the waiting BestOfN.

