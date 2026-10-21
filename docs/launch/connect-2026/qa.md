# Judge Q&A prep

Format: 7 minutes per finalist (Dina Kozlov's email, Oct 16). **Whether there is Q&A, and how
long, is not confirmed.** Prepare for 2-5 minutes. Answers are 2-3 sentences; say them, stop.
Items marked **[unverified]** are things the repo does not measure; say so if asked, don't
improvise a number.

Likely judges include Cloudflare product people; Dina Kozlov runs Cloudflare Artifacts, so
questions 4 and 5 are the ones to have cold.

---

**1. How is this different from git merge?**
Git finds conflicts when two branches are merged, and only when the same lines changed. Weft
checks each edit as it is made, at the level of functions and types, so it also catches "you're
calling a function whose signature just changed," which git merges cleanly and the build then
breaks on. The agent hears about it before a commit exists.

**2. Why not just use file locks?**
Locks make agents wait, and they're too coarse: two agents editing different functions in one
file is fine. Weft doesn't lock; it validates each edit against what changed since the agent
started, like optimistic concurrency in a database. When two agents do contend, exactly one is
told to adapt, by log order and priority (wait-die / wound-wait), so nobody deadlocks.

**3. How is this different from Graphite, stacked PRs or merge queues?**
Those tools order and land finished pull requests; they work after the code is written. Weft
works while it's being written, and it also has a serialized land queue on top, so it covers both
ends. A merge queue tells you at landing that your PR broke; Weft tells the agent mid-edit.

**4. Why Cloudflare and not AWS or GCP?**
The core need is one authoritative, ordered log per repository. A Durable Object gives me exactly
that: one instance per repo with its own SQLite, and Cloudflare guarantees there's only one, so I
didn't build leader election or run a database cluster. Artifacts gives Git repos and a fork per
agent as an API, and Workflows, Queues and Containers cover the rebase, test and land pipeline.
On AWS I'd be assembling DynamoDB conditional writes, SQS, Step Functions, ECS and CodeCommit
myself.

**5. What exactly do you use Artifacts for?**
Each repository's trunk (main branch) lives in Artifacts, and every agent candidate gets its own
fork with a repo-scoped token. Push events from the forks go through a Queue and become
checkpoint events in the log, which trigger rebase, tests and selection. One limit we hit: push
subscriptions are per repo, not per namespace, so Weft creates one per fork when the candidate is
made (`docs/design.md` line 240).

**6. How does it scale? What if you have a thousand agents on one repo?**
Each repository is one Durable Object, so repos scale independently; the limit is per-repo
throughput, since every edit check goes through that one object. The largest tested run was 18
live agents on one coordinator (`demo/evidence/m2-report.md`). **[unverified]** We haven't load
tested beyond that, so I can't give you a ceiling yet; that's part of what the credits fund.

**7. What's the latency? Doesn't this slow the agents down?**
A pre-edit check takes a median 558 ms, 753 ms worst case, against the deployed gateway
(`demo/evidence/m1-report.md`). Agents spend seconds per model turn, so it's a small fraction. The
warning text adds under half a percent to the receiving agent's tokens.

**8. What does it cost to run per repo?**
**[unverified]** I haven't measured cost per repo. Development ran on the Workers Paid plan,
$5 a month (`docs/pm-log.md`). The structure: an idle repo is a stored Durable Object, while the
real cost is container minutes for rebases and tests, plus model calls for review.

**9. Can an agent trick or bypass Weft?**
Every agent token is scoped to one repo, and agents only see verdicts; they can't write to the
log as another agent. Containers that run git and tests hold no secrets: credentials are added
outside the container. The honest gap: adapters fail open by default, so if the gateway is down
the agent keeps working without checks, and terminal-based edits through the Hermes adapter are
recorded after the fact, not blocked.

**10. What about a semantic conflict, two changes that are both "valid" but break behavior?**
Weft catches structural conflicts: same symbol written, or a symbol you use whose signature
changed. It does not prove behavior is preserved; that's what the tests and evidence stage
before landing are for, plus auto-revert if errors spike after a landing, which passed in the
last two full runs.

**11. Which languages does it support?**
The symbol analysis is TypeScript and JavaScript today. Other languages, Swift and Python
included, get whole-file checks: Weft still sees two agents in the same file, but can't catch a
changed signature across files. Adding languages is next on the list.

**12. Which coding agents work with it?**
Claude Code, Codex, OpenCode and Hermes run live through adapters; Cursor CLI and Gemini CLI
translators are tested against their documented formats only. There's also a file-watcher mode
for tools with no hooks. All adapters pass the conformance suite at the wire
(`docs/standardization/reports/README.md`).

**13. Who uses it? Any traction?**
Weft's own build, and my own agents across my repos: the Hermes adapter reports edits for 50
repositories and 8 agent profiles (`docs/pm-log.md`, Oct 9). The repo has 39 stars, 4 forks and
an outside contributor with merged pull requests (GitHub, read Oct 19). No outside team runs it in
production yet; getting the first ones is the next step.

**14. What's the business model?**
**[unverified / not decided]** There isn't one yet. The protocol stays open; the natural product
is a hosted coordinator and evidence platform for teams running many agents, the way GitHub is
hosting around open Git. I'd rather learn from the first outside teams before setting a price.

**15. What's open source?**
All of it, MIT: protocol spec and validator, coordinator, adapters, analyzer, web UI and the
Cloudflare apps (`LICENSE`, `README.md`). The protocol (WCP) and the hook rules (Agent Hooks Core)
are written up separately so others can implement them without Weft.

**16. Is WCP a standard?**
No, both are v0 drafts. We're proposing Agent Hooks Core and WCP to the Agentic AI Foundation in
collaboration with members of Gas Town; the Agent Hooks Core discussion item is open
(aaif/project-proposals#53). The roadmap's goal is a second, independent implementation not built
on Cloudflare. And WCP v0.1 is a draft, Weft is a research prototype, and the analyzer understands
TypeScript today.

**17. What breaks today?**
Four things: the analysis is TypeScript-only; Weft fails open when the gateway is unreachable;
the full multi-agent pipeline takes real Cloudflare setup; and the fully local mode (`weft serve`)
is built on a branch but not merged to main yet. The protocol tests and a local two-agent demo run
with no Cloudflare account (`docs/try-it.md`).

**18. Why would a team adopt this instead of splitting work so agents never overlap?**
Splitting work is the right first move, and Weft doesn't replace it. But the plan is always wrong
somewhere: a shared type or helper gets touched by two tasks. Weft catches the overlap you didn't
predict, in seconds, instead of in review.

**19. What's on the roadmap?**
This quarter: tag the v0.1 specs, short claim leases (built), and outside users. Next: a second
implementation of the hook rules, the first outside team in production, and adapters accepted
upstream by an agent harness (`ROADMAP.md`). Product priorities: more languages, local mode on
main, onboard a handful of teams by hand.

**20. What would you do with the $25k credits?**
Run a hosted coordinator for outside teams at no cost to them while we learn, and build a public
benchmark: many agents on real repos with and without Weft, measuring rework and broken builds.
That turns "it works on my repos" into numbers anyone can check.

---

## Honest answers about how it was built

Added Oct 19 for the story version of the talk (card t_eddf67e7). Same rule: say it, stop.

**Did you write the code?**
No. Agents did, coordinated by Weft. I designed it in one conversation on Oct 3 and directed the
work: the questions, the decisions, the sign-off. That's the point of the project.

**Which agents?**
Hermes agent profiles did most of the work (three profiles show up in Weft's own log: 795, 85
and 38 events). Claude Code, Codex and OpenCode were used in the collision demos.

**So what did you actually do?**
Asked what the brief meant, rejected the easy answers (worktrees, jujutsu), proposed checking each
tool call and returning a "squiggle", decided on one strictly ordered log, asked for a shared hooks
standard, then set up the board and the project-manager agent and kept final sign-off.

**Can you explain the system without the agents in the room?**
Every agent edit is a tool call. A hook sends it to one Durable Object per repo, which puts it in
order and checks it against what other agents changed since this agent started. If it conflicts,
the agent gets an error in its own run and fixes it before anything is committed.

**Was it built in 11 days?**
No. Eleven days was the time to the deadline. The entry was submitted three days in (Oct 3 → Oct 6);
work continued after.

**Who named it?**
The agent proposed "Weft" as a working name on Oct 3 and I kept it.

**Did a human review the code?** **[John: confirm before saying]**
Not line by line. Review was evidence-based: tests, a recorded demo, the repo, and Weft's own log.
I signed off on anything public. That is a real limit of how it was built; the benchmark in the
credits plan is how I'd measure it properly.

**What went wrong?**
The Hacker News post got no traction. CI broke after launch. An outside contributor's PRs needed
careful review; one was merged. In my own Mac app I could only see landed work, not each edit,
which is the part that matters. Fully local mode is in progress, not merged.

**Why should we trust a project nobody wrote by hand?**
Don't take my word for it: the log is public at weft.elier.ai, read-only, and the repo is MIT.
Event 834 is a real refused edit from Weft's own build.

Sources for this section: `pitch.md` "Sources" table; `log-stats-2026-10-19.json` (`agents`);
Hermes session `api_1791070817_1d33e733` (Oct 3-13); `docs/pm-log.md`.

## Sources

| Claim | Source |
|---|---|
| 7 minutes per finalist; Dina's role | Finalist email from Dina Kozlov, Oct 16 2026 (not in repo) |
| 18 live agents, 6 tasks, all beats in 4 valid runs, auto-revert passed runs 4-5 | `demo/evidence/m2-report.md` |
| 558 ms p50 / 753 ms max pre-edit check; token overhead under 0.5% | `demo/evidence/m1-report.md` (line 115; token table) |
| Workers Paid $5/month | `docs/pm-log.md` (2026-10-03) |
| Artifacts push subscriptions are per repo | `docs/design.md` line 240 |
| Containers hold no secrets | `docs/design.md` line 253 |
| Fail-open default | `docs/standardization/reports/README.md` (column "Backend down") |
| Terminal edits recorded after the fact (Hermes adapter); TS-only analyzer | Podcast research card t_5af07d9f findings; `docs/design.md` §4 "TypeScript only for v0" |
| Adapter list, conformance results | `docs/standardization/one-pager.md`, `docs/standardization/reports/README.md` |
| 50 repos, 8 profiles | `docs/pm-log.md` (2026-10-09) |
| 39 stars, 4 forks, outside contributor | GitHub API for celador/weft, read Oct 19 2026 (not in repo) |
| Spec status, AAIF item open | `README.md`, `ROADMAP.md`, aaif/project-proposals#53 |
| `weft serve` not on main | `git branch --merged main` (Oct 19 2026); `docs/pm-log.md` |
| Roadmap items | `ROADMAP.md` |


## The numbers behind "did a human review the code?"

- Time: 64 hours, from the first message (Sat Oct 3 2026, 22:00 -03, session api_1791070817_1d33e733) to the submission commit "R4: submitted" (Mon Oct 6, 13:40 -03).
- At submission: 231 files of code and tests (.ts/.tsx/.js/.mjs/.py/.sh/.css/.swift/.sql/.html; excluding node_modules, build output, lockfiles, fixtures, evidence and slide decks): 38,593 lines, 1,971,355 characters. All commits by agents; no outside contributors yet.
- Today (Oct 19): about 44,000 agent-written lines (git blame, code and tests), plus 1,356 lines from Omer Bar-Ness.
- Human benchmark: 10-50 delivered lines per person per day, industry average including non-coding work (McConnell, Code Complete 2nd ed., ch. 20.5); 20-125 for small projects (McConnell via Coding Horror); Capers Jones 16-38; Brooks (OS/360) about 10.
- 38,593 / 50 = 772 working days (about 3 years at 250 days/year). 38,593 / 125 = 309 working days (over a year).
- Caveat to say out loud if pushed: lines of code are not quality; the figures show scale.
