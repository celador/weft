# Deep-dive judge questions

For the Git-competition panel (Wed). Judges at the Cold Start panel dug into how things work.
These are the 12 deepest questions we expect. Answers are short and true: say them, then stop.
Where something is not built, the answer says so. Each answer has a hidden notes line
(`<!-- notes: ... -->`) with the files it was checked against, as of commit 391683d (Oct 19).

Cloudflare terms in plain words: a **Worker** is a stateless web service. A **Durable
Object (DO)** is one single-threaded server with its own small SQLite database; there is exactly
one per name. **Queues** is a message queue, **Workflows** is a job runner with retries,
**Containers** are short-lived Linux boxes, and **Artifacts** is hosted Git repos.

---

**1. How does conflict detection work, exactly?**
When an agent starts a change, it gets the log position it started from, its "base". Every edit
it sends says what it changed and which functions and types it relied on, its read set. The
coordinator looks only at what other changes wrote after that base. If one of them landed a write
to the same function, the edit is rejected as a stale overwrite. If one changed the signature of
something you read, or deleted it, the edit is rejected too. A body-only change to something you
read is just a warning. It's the same idea as optimistic concurrency in a database: check against
what changed since you read, don't lock.
<!-- notes: docs/protocol/wcp-v0.md §6.1-6.2 (W = records with seq > base, rules R1 stale_overwrite, R2 stale_assumption/stale_read, R3 claims); packages/sequencer/src/coordinator.ts (validate); packages/analyzer/src/index.ts (reads/writes, keys path#qualified.name) -->

**2. And when two agents are editing the same thing at the same time, before either lands?**
Agents can claim a function for a short time, like a lease. If two claims collide, the more senior
change wins: higher task priority first, then whoever started first. The default rule is
wound-wait: a senior agent proceeds and the junior one is told to back off; the alternative is
wait-die. Exactly one side is told to adapt, and the ordering never changes, so they can't deadlock
or keep backing off from each other. By default this is advice, a warning; a repo can switch to
"block" so the losing edit is refused.
<!-- notes: docs/protocol/wcp-v0.md §7.1 seniority (priority, birth seq, change id), §7.2 wound-wait default / wait-die, enforcement advise|block (default advise); claim TTLs expired by the DO alarm, packages/sequencer/src/do.ts:4,210-218 -->

**3. The sequencer is one Durable Object per repo. Isn't that a bottleneck, and what if it goes down?**
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

**8. How do agents hook in? Which ones work today?**
Each coding agent has hooks that run before and after a tool call. Our adapter is a small program
those hooks call: before an edit it asks the coordinator, and if the answer is reject, the agent
sees the reason and adjusts. Live today: Claude Code, Codex, OpenCode and Hermes. Cursor CLI and
Gemini CLI adapters are tested against their documented formats only, and there's a file-watcher
for tools with no hooks.
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

**12. What does WCP standardize, what's Weft-specific, and what's next?**
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
