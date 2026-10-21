# Deep-dive judge questions

For the Git-competition panel (Wed). Judges at the Cold Start panel dug into how things work.
These are the 12 deepest questions we expect. Answers are short and true: say them, then stop.
Where something is not built, the answer says so. Each answer has a hidden notes line
(`<!-- notes: ... -->`) with the files it was checked against, as of commit 391683d (Oct 19).

Rev 6 (Oct 20): the talk is now criteria-led (headline, what I built, why it's new, Cloudflare's
four questions, why Artifacts). The origin story, the build numbers, traction and the roadmap
moved out of the talk and into the sections at the end of this file: "Origin story", "Traction"
and "What's next". Questions 1-12 still match the talk; slide pointers are in brackets.

Rev 7 (Oct 20): slide 8 is the 58 s Otto clip (run-4 of the team demo); old slides 8-12 are now
9-13. Pointers below use rev 7 numbers. The Otto run, with its honest failures, is in "The Otto run".

Cloudflare terms in plain words: a **Worker** is a stateless web service. A **Durable
Object (DO)** is one single-threaded server with its own small SQLite database; there is exactly
one per name. **Queues** is a message queue, **Workflows** is a job runner with retries,
**Containers** are short-lived Linux boxes, and **Artifacts** is hosted Git repos.

---

**1. How does conflict detection work, exactly?** [slides 3, 5, 9]
When an agent starts a change, it gets the log position it started from, its "base". Every edit
it sends says what it changed and which functions and types it relied on, its read set. The
coordinator looks only at what other changes wrote after that base. If one of them landed a write
to the same function, the edit is rejected as a stale overwrite. If one changed the signature of
something you read, or deleted it, the edit is rejected too. A body-only change to something you
read is just a warning. It's the same idea as optimistic concurrency in a database: check against
what changed since you read, don't lock.
<!-- notes: docs/protocol/wcp-v0.md §6.1-6.2 (W = records with seq > base, rules R1 stale_overwrite, R2 stale_assumption/stale_read, R3 claims); packages/sequencer/src/coordinator.ts (validate); packages/analyzer/src/index.ts (reads/writes, keys path#qualified.name) -->

**2. And when two agents are editing the same thing at the same time, before either lands?** [slide 9: "priority decides who adapts"]
Agents can claim a function for a short time, like a lease. If two claims collide, the more senior
change wins: higher task priority first, then whoever started first. The default rule is
wound-wait: a senior agent proceeds and the junior one is told to back off; the alternative is
wait-die. Exactly one side is told to adapt, and the ordering never changes, so they can't deadlock
or keep backing off from each other. By default this is advice, a warning; a repo can switch to
"block" so the losing edit is refused.
<!-- notes: docs/protocol/wcp-v0.md §7.1 seniority (priority, birth seq, change id), §7.2 wound-wait default / wait-die, enforcement advise|block (default advise); claim TTLs expired by the DO alarm, packages/sequencer/src/do.ts:4,210-218 -->

**3. The sequencer is one Durable Object per repo. Isn't that a bottleneck, and what if it goes down?** [slides 5, 12]
Yes, by design: one object per repo is what gives a single, ordered log, the way a database
primary does. Repos don't share anything, so a thousand repos are a thousand independent objects.
The log is in that object's own SQLite storage, so if it restarts, Cloudflare brings it back with
its data. While it's unreachable, the adapters fail open: the agent keeps working unchecked and
the miss is logged. That's a deliberate choice, and an honest gap if you need strict guarantees.
<!-- notes: apps/gateway/src/index.ts:81 (WEFT_REPO.idFromName(repo)); packages/sequencer/src/do.ts:67 (ctx.storage.sql); packages/adapters/claude-code/src/hooks.ts:26-27,365 (failOpen); docs/pm-log.md Oct 9 (circuit breaker: dead gateway costs one 4 s timeout per 5 min) -->

**4. How much latency does it add per edit?**
A pre-edit check measured a median of 558 ms, 753 ms worst case, against the deployed gateway.
Most of that is the round trip from the laptop to Cloudflare; the check itself is a few small SQL
reads. Agents spend seconds on each model turn, so it's a small slice. In "advise" repos the edit
isn't held at all; it's reported in the background.
<!-- notes: demo/evidence/m1-report.md line 115 (558 ms p50 / 753 ms max); docs/design.md:278 (~400 ms per coordinator call, ~0.55 s pre-edit hook); docs/pm-log.md Oct 9 (advise repos: no pre-check, commit on background worker) -->

**5. How does it scale to many agents and many repos?**
Repos scale out, since each repo is its own object. Per repo, the ceiling is how many checks one
object can handle per second, and I haven't load-tested that ceiling. The largest real run was 18
live agents on one repo, and my own setup reports edits from 8 agent profiles across 50 repos. A
load test is the first thing the credits would pay for.
<!-- notes: apps/gateway/src/index.ts:81; demo/evidence/m2-report.md (18 live agents); docs/pm-log.md Oct 9 (50 repos, 8 profiles); no load test in repo -->

**6. What about false positives?**
The main source is coarseness. For TypeScript and JavaScript the analysis is per function and per
type. For other languages, and for files the parser can't read, it falls back to the whole file, so
two agents in different parts of one Python file will get a warning. Body-only changes are warnings,
never blocks, and only signature or delete changes to things you actually read are errors. I don't
have a measured false-positive rate yet.
<!-- notes: packages/adapters/claude-code/src/analysis.ts:16,83 (whole-file fallback); packages/analyzer/README.md (TypeScript only, single-file program, renames = deleted+new); wcp-v0.md §6.2 R2 (body = warning) -->

**7. Why not file locks, git worktrees or CRDTs?**
Locks make agents wait and they're too coarse, since two agents in one file is usually fine.
Worktrees we do use, one per agent, but they only isolate. They hide the conflict until merge
time, and Weft is what tells them about each other. CRDTs merge text automatically, but here the
danger is the opposite: two edits that merge cleanly as text and still break the build, like
calling a function whose signature just changed. We want that conflict reported, not merged away.
<!-- notes: README.md:5 (without file locks); docs/design.md:199-200,277 (worktrees share repo-relative keys); wcp-v0.md §6.2 R2 stale_assumption; no CRDT anywhere in repo -->

**8. How do agents hook in? Which ones work today?** [slide 4]
Each coding agent has hooks that run before and after a tool call. Our adapter is a small program
those hooks call: before an edit it asks the coordinator, and if the answer is reject, the agent
sees the reason and adjusts. Live today: Claude Code, Codex, OpenCode, Hermes and Gemini CLI
(Gemini's hooks ran live in the Otto run: every edit checked and accepted, a candidate pushed; no
Gemini edit happened to be refused there). The Cursor CLI adapter is tested against its documented
format only, and there's a file-watcher for tools with no hooks.
<!-- notes: packages/adapters/{claude-code,codex,opencode,hermes,cursor,gemini,watcher}; packages/adapters/claude-code/src/hooks.ts (PreToolUse); docs/standardization/reports/README.md; qa.md #12 -->

**9. How do security and auth work?**
Every agent gets its own token, scoped to one repo and bound to that agent's id. It can't act as
another agent or touch another repo; a wrong repo just looks like "not found". Tokens are stored
only as SHA-256 hashes and shown once when issued. Read-only observer tokens are separate. The
containers that run git and tests hold no secrets. What's missing is self-serve token issuance and
any SSO; today the operator mints tokens.
<!-- notes: packages/sequencer/src/auth.ts:6-25 (Grant: scopes, repos, agent binding; canAccessRepo); docs/protocol/wcp-v0.md §3 (404 repo_not_found, no issuance endpoint in v0); apps/gateway/src/registry.ts:3,21 (SHA-256) -->

**10. What's actually live, and what's a prototype?**
Live: the coordinator and gateway on Cloudflare, the adapters for my own agents across my repos,
and the public read-only web UI at weft.elier.ai. The rebase, test and land pipeline on Artifacts,
Workflows and Containers ran in the demo runs, but it needs real Cloudflare setup and no outside
team runs it. Not built yet or not merged: analysis for languages other than TypeScript, and the
fully local mode, which is on a branch.
<!-- notes: README.md:7 (weft.elier.ai); apps/gateway/wrangler.toml (Queues, Workflows, Artifacts); demo/evidence/m2-report.md; qa.md #17 (weft serve on a branch); docs/pm-log.md Oct 9 -->

**11. What does it cost to run on Cloudflare?**
I haven't measured cost per repo, so I won't give a number. Development ran on the $5-a-month
Workers Paid plan. An idle repo is just stored data in its object, so it costs almost nothing. The
real costs are container minutes for rebases and tests and model calls for reviews, and they grow
with how much work lands, not with how many agents are connected.
<!-- notes: docs/pm-log.md lines 12,16 (Workers Paid $5/mo); apps/gateway/wrangler.toml (containers, workflows); no cost measurement in repo -->

**12. What does WCP standardize, what's Weft-specific, and what's next?** [slides 2, 4]
WCP is the wire protocol: the event format, the conflict rules, the arbitration rules and auth
scopes, so any agent and any coordinator can interoperate. Weft is one implementation on
Cloudflare, plus the analyzer, adapters, web UI and land pipeline. We proposed the hook layer to
the Agentic AI Foundation as a discussion item; it's a draft, not a standard. Next is a second
implementation that isn't on Cloudflare, and working with tools like Beads that already track
agent tasks: Beads decides what each agent works on, Weft checks the edits as they happen. There's
no Beads integration yet.
<!-- notes: docs/protocol/wcp-v0.md (§3 auth, §6 validation, §7 arbitration); docs/proposal-aaif.md (discussion proposal, Agent Hooks Core v0.1, docs/protocol/hooks-core-v0.md); ROADMAP.md (second implementation, WCP v1 multi-repo); no Beads/BDP code or doc in repo; interest is conversational only -->

## How does Weft affect token consumption?

Measured, but only on the small collision demo, not on real workloads. In the four recorded M1
runs (demo/evidence/m1-report.md), the text Weft injects into an agent costs roughly 136-291
tokens for the agent that changes the function and 272-1,248 for the agent that gets the squiggle,
of which the refusal itself is about 520-673. Against that agent's whole run that is 0.07-0.31%
of its input tokens. These are chars/4 estimates of Weft's own text, not provider billing. The
hypothesis we haven't measured is the savings side: a refusal at edit time should cost far fewer
tokens than rerunning or reworking a branch after a broken merge, like the baseline run where both
branches passed alone and main broke. Next step is to measure that end to end, with and without
Weft, using AI Gateway request metadata.

## Can it show merge order, "blocked by" and "depends on" between agents' changes?

Not yet; it's on the roadmap (an outside contributor asked for it). Today Weft refuses an edit
that relies on a change another agent just made, and lands changes on main one at a time through
a queue (rebase, presubmit, then main advances only if nothing moved). What isn't built is a board
that plans the merge order up front and shows which change is blocked by or depends on which.

## Rev 6 talk claims, in case a judge pushes

- **"Coordination, not Orchestration": isn't the coordinator an orchestrator?** No. It doesn't
  assign or split work; it's an ordered log plus rules that check each edit. Agents pick their
  own work (from a board, a person, or another tool) and decide how to react to a squiggle.
  Arbitration is between peers: one rule decides which side adapts. When two tasks turn out to be
  one, escalation merges them; still no agent above the others.
- **"It runs on a laptop": really without Cloudflare?** The coordinator runs locally under
  `wrangler dev` (the open-source Workers runtime) with no Cloudflare account, token or model
  key (`docs/try-it.md`). Locally there's no landing queue, forks or evidence; you post land
  events yourself. A second, non-Cloudflare implementation of WCP is roadmap.
- **"Review agent fails closed": what does that mean?** If the reviewer says pass but any
  acceptance criterion is unmet or unknown, it's recorded as fail or needs-a-human, never pass.
  It's a text review today; screenshots are diffed, but no vision model reads them yet.
- **"Weft reverts it": in production?** On the preview stack, live: a planted bug landed, errors
  started in 6 s, the revert started 16 s after the land, and trunk was reverted and redeployed
  43 s after it (`demo/evidence/b13-auto-revert-live`). The detector blames the latest landing for
  any spike in the window; there's no per-route baseline yet.
- **"A preview" for every candidate?** Static sites, served straight from Artifacts at that exact
  commit. Server-rendered apps would need a Worker Loader variant, not built.

## The Otto run (slide 8), in case a judge asks

Source: `demo/evidence/otto-report.md`, `demo/evidence/otto/run-4/run.json` (card t_83def502).
The clip is cut from a 26:54 screen recording of Otto by `demo/otto/video/cut.py`: trims, crops and
captions, no re-staging. Full recording and 8 stills: the phone page, "Otto demo".

- **What ran:** 7 kanban cards (t1-t7) on board weft-demo-site, all running at once, each a
  BestOfN task with 2-3 candidates on different harnesses: 16 candidates, Claude Code 5, Codex 4,
  Gemini CLI 3, OpenCode 2, Hermes 2. Each card's worker only talks to Weft; no planner agent.
  All 7 landed. Winners: Codex t1 and t3, OpenCode t2 and t7, Hermes t4, Claude Code t5 and t6.
- **Squiggles:** 6 `stale_assumption`, all rerouted (3.8 s to 554 s). **Negotiation:** t3's
  agents proposed an overload of `createSession`; t1's agent accepted both (#662, #663); the
  overload is on trunk. **Mergiraf:** t5 landed through a structural merge. **Evidence:** the t6
  menu change had a preview, 2 screenshots, a 9,301 px pixel diff, risk low, review pass.
- **Approvals:** 3 (t1, t3, t6), each a click on Otto's Approve button on John's account. The
  recording script sent the clicks; I didn't click by hand. Say "an Approve click in Otto".
- **Revert:** a planted bug (t8) landed; production errors 5 s later; Weft reverted it (#780)
  32.5 s after the landing and reopened the task. Trunk afterwards: tsc and 22/22 tests green.
- **What went wrong (say it if asked, not on slides):** Gemini CLI hit its free-tier daily quota
  (HTTP 429) on t2 and made no changes on t5; its t7 candidate was valid but lost to OpenCode's.
  The t3 and t6 lanes died once on a network `fetch failed` while polling and were reattached to
  the same workflow. Trunk deploys came from `wrangler` (a follow script), not Workers Builds.
  Cursor wasn't in the run (not logged in). Rehearsal run 1 failed the negotiation beat (proposals,
  no accept); runs 2 and 4 passed every beat; run 3 was aborted (cards on the wrong board).

## Origin story (moved out of the talk in rev 6)

Say it only if asked how it was built, or how fast.

- I read Cloudflare's post on Saturday night, October 3rd, and started asking questions. The
  first commit landed about 80 minutes later.
- 64 hours later I submitted: 231 files, 38,593 lines. Every commit was written by an agent; I
  asked the questions and made the decisions. My loop: explore, decide, delegate, verify, repeat.
- Weft coordinated its own build from about its third hour. In the first 11.3 hours its log recorded
  627 events and 460 edits, and 59 times it told one agent to wait for another. To Oct 19: 918
  events, 679 edits, 60 waits, 27 landings, 5 edits refused. Event 834 was refused because event
  813 changed a type it used; the next try was accepted.
<!-- notes: qa.md (first commit Oct 3 22:00 -03, submitted Oct 6 13:40 -03, 231 files, 38,593 lines); demo/video/dogfood-stats.json (627/460/59, first 11.3 h); log-stats-2026-10-19.json (918/679/60/27/5, refused seqs incl. 834); pitch-story-v1.md slide 13 (834 <- 813) -->

## Traction

In two weeks: 39 GitHub stars (repo created Oct 4); one outside user filed 22 issues and pull
requests (12 issues, 10 PRs, Oct 8-13); the Beads team asked how to integrate. No Beads
integration exists: say "asked", not "partnership". It's a prototype: TypeScript and JavaScript
analysis only, not in production anywhere.
<!-- notes: gh api repos/celador/weft (Oct 20); issues/PRs all from barnessomer -->

## What's next

- A Time Machine for agent work: every revision already has its own preview; the timeline to
  scrub through them is not built.
- With the credits: a free hosted coordinator, and a public benchmark of the rework Weft saves,
  measured with and without Weft through AI Gateway metadata.
- Merge-order planning on the board (blocked by / depends on): roadmap, see above.
