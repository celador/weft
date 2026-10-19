# Weft at Cloudflare Connect 2026: finalist talk script

> Superseded on Oct 19 2026 by the story version in `pitch.md` (John's decision, card t_eddf67e7). Kept for reference.

Format, confirmed: **7 minutes per finalist, demo included.** Source: Dina Kozlov's finalist
email of Fri Oct 16 2026 ("Each finalist gets 7 minutes to present what you built"). All three
finalists present Wed Oct 21, 1:35-2:20 PM PT, Moscone West, San Francisco.
**Not confirmed yet:** whether there is Q&A after each talk, how long it is, who the judges are,
and whether you present from your own laptop (HDMI/USB-C) or a shared machine. Dina wrote "We'll
send more details on format and setup soon"; no such email had arrived by Oct 19. Note: Dina is
the Senior Product Manager for Cloudflare Artifacts, so expect Artifacts questions (qa.md).

Files in this kit: `pitch.md` (this), `qa.md` (judge questions), `slides-feature-v1.html` (open in any
browser, works offline, arrow keys), `one-pager.md` + `qr-weft-site.png` + `qr-calendly.png`.

The script below is about 880 spoken words, demo narration included. At 145 words per minute
that is about 6:05 of talking, plus about 45 seconds of clicking in the demo: 6:50, leaving 10
seconds of slack. If you run long in rehearsal, cut Section 7 (credits) to its first sentence,
then drop demo step 5 (Ops), then shorten the product list in Section 4 to Durable Objects,
Artifacts and Workflows.

---

## Before you walk on (T-30 min)

1. Laptop on power, Do Not Disturb on, notifications off, display mirroring on, browser zoom 125%.
2. Tab 1: `docs/launch/connect-2026/slides-feature-v1.html` (open the file from disk; it needs no network).
   Press `F` for full screen.
3. Tab 2: <https://weft.elier.ai/#/r/weft/live> (public, read-only, no login). Wait until the
   header shows `live · #<number>`.
4. Backup video downloaded to the desktop, in case the venue Wi-Fi fails:
   `curl -o ~/Desktop/weft-demo-short.mp4 https://weft-media.elier.ai/weft-demo-short.mp4`
   (3:00 cut; the squiggle segment runs from 0:37 to 1:24). The live-system backup recording
   (2:55, no audio, same beats as the live demo) is
   `curl -o ~/Desktop/weft-connect-backup.mp4 https://weft-media.elier.ai/connect-2026-backup.mp4`;
   stills per beat are in `demo/video/connect-2026/stills/`. See `runbook.md`.
5. Run `scripts/connect-preflight.sh` from the repo root; it must end with "All green."

---

## 0:00-0:45 · Section 1 · The problem (slides 1-2)

**Slide 1 (title):**
"I'm John Nelson. I built Weft. It gives teams of coding agents red squiggles: it tells an agent
it's about to break another agent's work while it's still typing, not after."

**Slide 2 (merge time is too late):**
"Git and GitHub coordinate people at merge time. You work on a branch for a day, open a pull
request, and conflicts show up in review. That works for people. Agents edit code in seconds,
and if you run five or fifty of them on one repo, they collide constantly. By the time a pull
request exists, the damage is done: one agent built on a function another agent already changed.
Merge time is too late."

## 0:45-1:15 · Section 2 · The idea (slide 3)

**Slide 3 (squiggles for agents):**
"Every coding agent changes code through tool calls: Edit, Write, apply_patch. Weft hooks those
calls. Each edit goes into one ordered log per repository, with the functions it reads and the
functions it writes. Weft checks it against everything other agents changed since this agent
started. If there's a conflict, the agent gets a compiler-style error inside its own run, with
the other agent's code quoted, and exactly one side is told to adapt. No file locks."

## 1:15-3:25 · Section 3 · Live demo (slide 4, then switch to Tab 2)

**Slide 4 (live demo):**
"This is the live log of Weft's own repository. Every edit the agents made while building Weft
went through Weft."

Switch to Tab 2. Each beat: what to do, what to say.

1. **Header (15 s).** URL <https://weft.elier.ai/#/r/weft/live>. Point at the numbers at the top
   right (HEAD, SQUIGGLES, BLOCKED, LANDED).
   "Each row is one agent edit, landing or message. HEAD is how many events this repo has
   recorded. Blocked means Weft stopped an edit before it was written."
2. **Find a real collision (25 s).** Click the filter box, type `stale_assumption`. One row
   remains: **#834**, BLOCKED, agent `hermes-default`, task `t_e5801824`.
   "This is from last week. One agent was building a local mode for Weft. Days earlier, another
   agent's work on a different task had landed and changed a type this one depended on, and
   this agent was still working from the older code."
3. **Open it (40 s).** Click row #834. The detail panel opens on the right.
   "The agent tried to write host.ts using CoordinatorConfig. At event #813 the other agent's
   work landed on main and changed that type's signature, after this agent's starting point. So
   the edit was refused, and this message went straight back into the agent's tool result. Its
   next attempt, #835, was accepted. No human touched it."
4. **Follow the cause (25 s).** In the detail panel, click the blue `#813` link next to
   "caused by". The panel switches to #813: "hermes-default landed hermes-default/t_199b55fb
   (392 symbols)", ACCEPTED, Oct 9, with every symbol it wrote (SIG = signature change).
   "Every squiggle links to the event that caused it. Here's the landing that changed the type,
   and every function and type it touched. You can always see who changed what, and why you
   were told to stop."
5. **Landings and undo (20 s).** Press Escape, clear the filter, click **Ops** in the top bar
   (<https://weft.elier.ai/#/r/weft/ops>).
   "Every landing on main is an operation in this log, and undo appends a revert. History is
   never rewritten." (The public site is read-only, so the Undo button is hidden here.)
6. **Back to slides (10 s).** Switch to Tab 1, press the right arrow.

If the Wi-Fi is down or the page doesn't load in 5 seconds: say "the Wi-Fi's not with me, here's
the recording", play `~/Desktop/weft-demo-short.mp4` from 0:37 to 1:24 (Codex is denied, reads
the error, adapts, the edit is accepted), then continue with slide 5. Slide 4 also shows the same
#834 screenshot, so you can talk over the slide if nothing else works.

## 3:25-4:40 · Section 4 · Why it's built on Cloudflare (slides 5-6)

**Slide 5 (architecture):**
"The hard part of coordination is order. Someone has to say: this edit came first. On
Cloudflare that's a Durable Object. Think of it as a tiny server with its own SQLite database,
and Cloudflare guarantees exactly one copy runs per repository. So each repo gets one sequencer
that hands out order numbers and checks every edit. I didn't have to build leader election.
Cloudflare runs it."

**Slide 6 (each product, in plain words):**
"The rest of the platform maps one-to-one:
Workers are the API layer: the gateway the agents talk to and the web UI you just saw.
Artifacts is Git hosting as a service: it holds each repo's main branch, which we call trunk,
plus a fork for every agent.
Queues and Workflows are a job queue with checkpoints: when an agent pushes, Weft rebases, runs
tests, picks a winner and lands it, and every step retries if it fails.
Containers are throwaway Linux boxes for git and tests, with no secrets inside.
D1 is the SQL index of tasks and evidence, R2 is file storage for logs and screenshots, and
Workers AI does review and even narrated our demo video."

## 4:40-5:20 · Section 5 · Evidence (slide 7)

**Slide 7 (numbers):**
"This isn't a mockup. In the first eleven hours of the build, Weft's own log recorded 627
events: 460 edits from three agent profiles across 25 tasks, 18 landings, and 59 warnings that
told one agent to wait for another.
In the full end-to-end run, 18 live agents, six each of Claude Code, Codex and OpenCode, worked
six tasks against one coordinator. Every coordination beat passed in all four valid runs, and
after all the landings, main typechecked and passed its tests.
A pre-edit check takes about half a second, median 558 milliseconds, against the deployed
gateway."

## 5:20-6:05 · Section 6 · Open protocol and what's next (slide 8)

**Slide 8 (open protocol):**
"Weft is open source under MIT, and the protocol is separate from the product. WCP, the Weft
Coordination Protocol, works with any agent: there are adapters for Claude Code, Codex, OpenCode
and Hermes, and translators for Cursor and Gemini CLI. We've also written up the hook rules it
runs on, Agent Hooks Core, with a conformance test anyone can run, and proposed it to the
Agentic AI Foundation as a discussion item.
What's next is concrete: real users before more features. Run Weft on outside teams' repos,
support languages beyond TypeScript, and make the fully local mode the default way to try it."

## 6:05-6:35 · Section 7 · What $25k in credits buys (slide 9)

**Slide 9 (credits):**
"The credits turn Weft from my setup into something other teams can use. A hosted coordinator
for outside teams at no cost to them while we learn: one Durable Object per repo, containers for
merges and tests, Workers AI for review. And a public benchmark: many agents, real repos, with
and without Weft, so we can measure how much rework it actually saves instead of guessing."

## 6:35-6:50 · Close (slide 10)

**Slide 10 (QR codes):**
"Git was built for people taking turns. Agents don't take turns. Weft lets them work at the same
time without breaking each other. The live log and the code are on this QR code. Thank you."

---

## Things not to say

- Don't claim production users, revenue, a price or a cost per repo: none are measured (qa.md).
- Don't call WCP or Agent Hooks Core a standard: they are v0 drafts; the AAIF item is an open
  discussion proposal (aaif/project-proposals#53), not an accepted project.
- Don't promise local mode on main: `weft serve` is on branch `wt/local` (card t_e5801824),
  not merged as of Oct 19 (`git branch --merged main` does not list it).
- Don't say the analyzer understands Swift or Python: TypeScript/JavaScript only; other
  languages get whole-file checks.

## Sources for every number

| Number in this kit | Source file (repo-relative unless noted) |
|---|---|
| 7 minutes per finalist; Oct 21 1:35-2:20 PM; Dina's role | Finalist email from Dina Kozlov, Oct 16 2026 (John's john@elier.ai inbox); not in the repo |
| 627 events, 460 edits, 3 agent profiles, 25 tasks, 73 checkpoints, 18 landings, 59 wait warnings, 11.3 hours | `demo/video/dogfood-stats.json` (`records`, `edits`, `agents`, `tasks`, `checkpoints`, `lands`, `by_code.warning:claim_wait`, `hours`) |
| 18 live agents, 6 tasks, 6 each of Claude Code/Codex/OpenCode, all coordination beats in 4/4 valid runs, trunk typechecks and tests green | `demo/evidence/m2-report.md` (beats table, runs 2-5) |
| Auto-revert beat passed in runs 4-5 | `demo/evidence/m2-report.md` |
| Pre-edit check p50 558 ms / max 753 ms; coordinator call p50 389 ms | `demo/evidence/m1-report.md` line 115 |
| About 400 ms per coordinator call, about 0.55 s per pre-edit check | `docs/design.md` line 278 |
| Event #834 blocked by #813 (stale_assumption on CoordinatorConfig; #813 = land of t_199b55fb), #835 accepted, task t_e5801824 | Live log, <https://weft.elier.ai/#/r/weft/live>, read Oct 19 2026; screenshot embedded in `slides.html` |
| Adapters: Claude Code, Codex, OpenCode, Hermes live; Cursor and Gemini CLI fixture-tested only | `docs/standardization/one-pager.md`, `docs/standardization/reports/README.md` |
| Hook conformance ~100 ms p50 per hook | `docs/standardization/reports/README.md` (80-172 ms p50) |
| 3:00 short video; squiggle segment 0:37-1:24 | `demo/video/short.json` (segment in/out points; ffprobe 180.09 s) |
| Durable Object per repo as sequencer; product mapping | `README.md` "Why Cloudflare", `docs/design.md` §2, §7 |
| Workers AI narrated the demo video | `demo/video/submission.md` ("Workers AI also narrated our demo video") |
| MIT license | `LICENSE` |
| AAIF proposal is open | `ROADMAP.md`; GitHub issue aaif/project-proposals#53 (state `open`, read Oct 19 2026) |
| `wt/local` not merged | `git branch --merged main` on Oct 19 2026; `docs/pm-log.md` 2026-10-13 and 2026-10-18 |
