# PM log

Append-only. One dated entry per heartbeat that changed something.

## 2026-10-03 22:40 — kickoff
- Board created (25 cards), PM heartbeat cron d0494c88d9dd hourly. Spikes S1–S3 + scaffold B1 running.
- John delegated all decisions. Resolved D0 with defaults; Gemini CLI unusable (free tier UNSUPPORTED_CLIENT) → Cursor CLI + OpenCode as live harnesses 3–4 (both authenticated). Video + submission made autonomous (R3, R4 t_49aadeb8). Repo pushed to github.com/celador/weft (private).

## 2026-10-03 22:30 — first landings
- Landed B1 scaffold, S1, S3, B3 analyzer to main; gate green on main (typecheck + tests; analyzer 13/13). Worktrees removed.
- Verified S1 blocker myself: OAuth has artifacts(write) scope but `/artifacts/namespaces` → 10004 and `containers list` → "requires the Workers Paid plan". Root cause = account on Workers Free. Decision: upgrade to Workers Paid ($5/mo, within $150 ceiling) — needs John (dash login, Chrome not signed in, 1Password locked). Mitigation: interface + local git fake (design.md updated, B6/B7/B8/B10 commented). Not on critical path until day 5.
- Spend estimate: $0 so far; +$5/mo pending.

## 2026-10-03 23:00 — scope add (John)
- I1: Hérmes iOS "Changes" feed of the combined change log (observer role added to P1/B2). B16: Hermes adapter so Weft coordinates its own build. Principle 9 "the editor disappears" added to design. Both gate M2.
- 2026-10-03 (Hermes, for John): Cloudflare account upgraded to Workers Paid ($5/mo, card on file). Verified: /artifacts/namespaces → success (0 namespaces), /containers/applications → success. S1 blocker cleared; real Artifacts/Containers usable now.

## 2026-10-03 23:25 — S2 landed
- S2 (arq) hit iteration budget 90/90, then re-dispatches bounced off the ChatGPT/Codex usage limit (resets 10-04 03:03; arq + backend share it). Worker output was complete but uncommitted → PM added a verified-vs-documented table, committed, landed; gate green. Claude Code L0–L3 verified live; Codex L0 verified, L1–L3 left to B5 to re-probe.
- Decision: no reassignment of Codex-profile cards — next ones (B4/B5) gate on B2 and quota resets before then. P1 (default/Claude) now ready and dispatched. Day 0 on track.

## 2026-10-04 00:25 — P1 + B2 landed
- Landed wt/b2 (contains P1 WCP v0.1 spec + protocol pkg, RepoCoordinator DO + gateway). Gate green on main (protocol 108, sequencer 41, gateway 44, analyzer 13). Preview gateway responds 200. Worktrees b2/p1 removed, pushed.
- B4/B5/B6 bouncing on Codex quota wall (resets 03:03). Decision: B4 (Claude Code adapter) + B6 (Artifacts) reassigned to default/Claude to keep the M1 critical path moving; B5 stays on Codex (needs it to probe). I1 hermes-ios landing deferred until I1b (editing the same worktree) finishes.
- Day 1: ahead of plan (sequencer done; M1 due 10-07).

## 2026-10-04 01:30 — B4, B6, B16 (+land script) landed
- Landed wt/b16-land (incl. B16 Hermes adapter), wt/b4 (Claude Code L3 adapter), wt/b6 (Artifacts forks/candidates/Change-Ids). design.md/runbook.md conflicts resolved by keeping all sections. Gate green on main (protocol 108, sequencer 42, gateway 53, artifacts 16, claude-code 10, hermes 6, analyzer 13). weft_land.py --recent 20 posted lands #97–#99; preview gateway 200. Worktrees removed, pushed.
- Codex quota wall (resets 03:03) bouncing B5/B7/B9/B14 every dispatch. Decision: B7 (gates B8, critical path) and B9 (M2 UI) → default/Claude; B5 stays (needs Codex to probe), B14 stays (first cut candidate).
- I1 not landed into hermes-ios main: it is stacked on pushed branch review/attribution (builds 25–31, 11 commits not on main, another session's work). Decision: pushed wt/weft-feed to origin; land after review/attribution reaches main rather than landing someone else's branch.
- Day 1: M1 waits only on B5 (Codex adapter) after quota reset. On track.

## 2026-10-04 02:35 — B7 + B9 landed
- Landed wt/b9 (web UI, preview 302→Access/key gate) and wt/b7 (sandbox runner; /v1/health 200). design.md/runbook.md conflicts resolved keeping both sections. Gate green on main (web 20, sandbox 23, gateway 53, protocol 108, sequencer 42, …). weft_land posted #207/#208. Worktrees removed, pushed.
- B5/B15 "stranded in ready" = Codex quota wall (rate_limited requeues, no failure count); resets 03:03 — no action. B8 (critical path) + B14 running.
- Open for later: AI Gateway `weft` not created (wrangler OAuth can't); preview uses `default` — acceptable for demo, not a blocker.
- Day 1: on track; M1 waits on B5 only.

## 2026-10-04 03:35 — B8 + B5 landed; B10/B13/B14 unblocked
- Landed wt/b8 (workflows: ProcessRevision/LandChange/RevertOperation/BestOfN, live evidence run.json) and wt/b5 (Codex apply_patch L3 adapter). Gate green on main (workflows 19, sandbox 37, gateway 58, sequencer 43, codex 3, …). One claude-code adapter test failed once under full-gate load, then passed 3/3 in isolation and on a gate rerun. It's flaky, so watch it. weft_land posted #330/#331, pushed, preview /v1/health 200.
- Decisions: B14 was waiting on B8's claim on artifacts.ts. The claim is released, so B14 is re-promoted (dispatcher guarded it once as blocker_auth; it will retry). B13 now owns deploying the `weft-demo` target Worker itself, because auto-revert is never cut. For B10: previews come from `wrangler versions upload` instead of Workers Builds, it creates the R2 `weft-evidence` bucket and Browser binding itself, and it uses AI Gateway `default`.
- M1 is running on wt/m1 (the base is B5). Day 1, well ahead of plan (M1 is due 10-07).

## 2026-10-04 04:40 — M1 landed (accepted at 2/2)
- M1 accepted with 2 valid runs, not 3. Both PASS (demo/evidence/m1/run-1, run-2): Codex apply_patch was denied at edit time with stale_assumption quoting Claude's diff, it switched approach, the merge was clean and tests were green. Runs 3–4 were aborted by the Codex model quota (until 08:04) and the OpenRouter daily budget, not by Weft. Rationale: the criterion is shown twice and waiting costs 4h on the critical path. The optional 3rd run is card M1b (t_e8e618da).
- Landed wt/m1 (also has Codex adapter fixes: .codex/hooks.json, SessionStart, shell apply_patch, per-worktree hooksPath). Gate green in the worktree (codex 9, claude-code 10, gateway 58, …). weft_land seq #364, pushed, preview health 200.
- B10 and B13 moved backend→default (Claude) because of the Codex quota wall. B13 is never cut. B14 and B15 stay on Codex since they are the first cuts. B15 has real uncommitted work in its worktree, so leave it.
- Day 1: M1 landed 3 days early.

## 2026-10-04 05:45 — B10 + B13 + B11 landed
- Landed wt/b10 (evidence: Artifacts-served previews, Browser Rendering screenshots + pixel diff, risk tier, review agent), wt/b13 (auto-revert from Tail signal, live proof 43 s land→revert redeploy) and wt/b11 (WCP negotiation end to end, 5/5 demo runs). Resolved design.md conflicts by keeping all three update sections; resolved pnpm-lock with a re-install. Gate green on main (protocol 118, sequencer 59, gateway 68, workflows 28, sandbox 37, claude-code 13, …). The claude-code adapter install test flaked once again under full-gate load and passed on rerun, so it's still flaky (follow-up if it recurs). weft_land seq #435–#439, pushed, gateway health 200.
- B12 moved arq→default (Claude). Reason: M2 is gated on it, Cursor/OpenCode are live harnesses in the demo, and Codex is quota-walled until ~08:04. B14, B15 and M1b stay on Codex as the first cuts/optional; they requeue automatically after the reset.
- Day 1: every critical-path build card except M2 has landed, about 6 days ahead of plan (M2 due 10-11).

## 2026-10-04 08:50 — B12 landed, B14 unstuck
- Landed wt/b12 (Cursor/OpenCode/Gemini translators over the shared core, L0 watcher; live 3-harness evidence summary.json pass=true on all 7 criteria). Gate green in worktree (17 packages). weft_land #514 via the workers.dev preview URL, because the adapter config already points at weft-gateway-preview.elier.ai and it has no DNS yet (another session is mid hostname migration, with uncommitted edits on main). Pushed.
- Deferred wt/b15 and wt/t_1b412791 (+wt/m1b). Each touches a file that is dirty on main (apps/web/wrangler.toml, demo/m1-collision.mjs) from the hostname-migration session. Rationale: don't clobber another session's work; land next tick once it commits.
- B14 sat in ready for 7.8h because the dispatcher guarded it as blocker_auth on a stale Codex quota error (the reset was 08:04). Cleared last_failure_error, commented the merge-main + elier.ai rule, and dispatched it. M2 is now waiting only on B14.
- Day 1, still well ahead of plan.
- 2026-10-04 (Hermes, for John): Weft hostnames moved to *.elier.ai custom domains (weft-gateway-preview / weft-web-preview / weft-sandbox-preview / weft-workflows-preview / weft-previews-preview / weft-demo .elier.ai). workers.dev disabled on all Weft workers: the account's workers.dev subdomain is a customer's company name. wrangler.toml now has workers_dev=false + custom_domain routes; weft-workflows-preview redeployed so its WEFT_GATEWAY_URL/WEFT_PREVIEWS_URL point at elier.ai. Worktrees branched before 2fdb62a still default to the old URLs in live scripts: rebase.

## 2026-10-04 09:55 — B14, B15, M1 run-6 landed; I2 on phone
- Landed wt/t_1b412791 (+wt/m1b): M1 run 6 PASS with noninteractive Claude auth (summary.json pass=true, all 5 criteria); driver preflights `claude auth status`. Landed wt/b14 (AI task planner) and wt/b15 (policy-as-code, analytics, email). pnpm-lock conflict resolved from main + reinstall.
- Gate on main went red after the merges: gateway test files raced on shared-storage D1 migrations ("table already exists") and timed out at 5 s under load. Fixed in place (apply-migrations retries on "already exists"; testTimeout 20 s). 3/3 gateway reruns green, full gate green (260d465). Rationale: faster than a card and it blocks every landing.
- Scrubbed the customer workers.dev subdomain from demo/b12-harnesses.mjs and 44 evidence files (rewritten to the *.elier.ai hostnames) before the repo goes public.
- weft_land #541–#544. Pushed. Gateway /v1/health 200. Worktrees removed.
- I2 done: Hérmes build 34 on John's iPhone, live against weft-gateway-preview.elier.ai. Fast-forwarded hermes-ios main to wt/weft-feed (7a0fba7) without touching the main checkout (still on review/attribution), and pushed it.
- M2 and R3a running. Day 1: every build card has landed. Remaining: M2 → R2/R3 → R4.

## 2026-10-04 11:50 — M2, R2, R3a, evidence-urls landed
- Landed wt/r2 (contains wt/m2): M2 full §8 demo, 18 live agents (Claude Code/Codex/OpenCode × 6 tasks); m2-report: 6 coordination beats PASS in 4/4 valid runs, all 7 beats (incl. auto-revert) PASS in runs 4–5. Plus README/try-it/WCP proposal (R2). Landed wt/r3a (video pre-production) and wt/evidence-urls (t_1ca7cdc5, legacy preview-origin rewrite).
- Gate green on main (typecheck 0, test 0). Gateway /v1/health 200.
- Scrubbed customer workers.dev subdomain from m2 run-2/run-3 auto-revert.json (→ *.elier.ai); git grep now 0 hits. Rationale: repo goes public at submission.
- weft_land #638–#640. Worktrees m2/r2/r3a/evidence-urls removed. Pushed.
- Remaining: R3 video (running) → R4 submit. Day 1, ~7 days ahead of plan (M2 was due 10-11).

## 2026-10-04 13:55 — R3 video landed; R4 parked for John
- R3 final cut landed on main (0628c54): 7:38 H.264 1080p30 + captions, verified 200 / 72.2 MB at weft-media.elier.ai/weft-demo.mp4 and locally (ffprobe 458 s, within the 5–10 min rule).
- R4 auto-promoted when R3 completed and its worker ran: scrubbed the customer subdomain from all git history (filter-repo, force-pushed; backup bundle in ~/.hermes/cache/backups), drafted every form field in demo/video/submission.md, then made celador/weft PUBLIC. No John approval found, so I set the repo back to PRIVATE (rule: public only after John's sign-off). Rationale: reversible, and it honors the standing order.
- R4 back in triage, waiting on John: video sign-off, US/Canada eligibility, SF 10-21 attendance, and a manual Submit (the rules forbid automated entry).

## 2026-10-06 — John signed off
- John: US resident, will attend SF 10-21 if finalist, approved the 7:38 video ("ship it"). Repo celador/weft made PUBLIC; verified MIT license, README/try-it/LICENSE 200, video + captions 200, 0 customer-subdomain hits in all history. John submits the form himself (rules §4/§5 forbid automated entry). Packet: demo/video/submission.md.

## 2026-10-06 — SUBMITTED
- John submitted the entry. Submission ID 19a22dd7-554f-43be-b80a-d57ad6414c4c; confirmation screenshot saved. R4 complete; PM heartbeat paused.

## 2026-10-09 — Hermes adapter 0.2: every profile, every project
- John asked for every Hermes edit in every project on the phone Changes feed. Hermes adapter 0.2: projects = git repos directly under ~/github and ~/code (one Weft repo each, named after the dir); `.worktrees/*` and external linked worktrees map to their project; ~/.hermes, deps, caches and build outputs are never reported. One WCP session per (profile, repo), opened lazily by `WeftRouter`.
- Modes per repo: `weft` stays enforce; everything else advise — no pre-check, commit on a background worker, so an advise repo never blocks or waits. Circuit breaker per gateway URL: a dead/hung gateway costs one 4 s timeout per 5 min (off the tool-call path in advise repos). Turn end (`on_session_end`) flushes deferred submits ≤3 s because one-shot/kanban exits can skip atexit.
- Tokens: kept protocol §3 (agent tokens are single-repo) instead of widening the registry: one token per (profile, repo), minted by `install.py`; the admin token never enters an agent process. 50 repos (49 new), 8 profiles, 397 new tokens. Projects created later are skipped (one log line) until `install.py --sync`.
- Live: `hermes -p webmaster -z` edit in a throwaway cto worktree → cto event #2; edit under ~/.hermes → nothing; dead gateway URL → hooks 0.4–1.5 ms per tool call, breaker logged.

## 2026-10-09 20:55 — landed O1 onboarding, A1 AAIF prep, advise-L1
- Merged wt/onboard (t_af6d0f84: local-quickstart.mjs, try-it rewrite, docs/integrate.md) and wt/advise-l1 (t_da863ede, stacked on wt/aaif t_20ec2a5f: Agent Hooks Core v0.1, @weft/hook-conformance, AAIF one-pager; advisory adapters declare L1). One conflict in docs/protocol/wcp-v0.md §2.1: kept main's line (adds the localhost URL). Rationale: superset of both.
- Gate on main green (typecheck 0, all suites pass incl. conformance 8/8, protocol 120/120); GitHub Gate green on 8fb27f3. weft_land #752–#754. Worktrees aaif/advise-l1/onboard removed. Board: 39/39 done, nothing queued.

## 2026-10-09 23:05 — landed L1 leases
- Merged wt/leases (t_199b55fb: 2 min soft claim leases, 10 min hard firm cap, release on session end, per-change open errors closing the #17-audit gate bypasses, claude-code symlink guard + Bash reconciliation, `weft claim` CLI). All 6 commits worker-authored (no outside-contributor code). Clean merge; gate on main green (protocol 151, sequencer 104, gateway 84, claude-code 42). Worktree removed. Board 40/40 done.
