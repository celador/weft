# Weft at Cloudflare Connect 2026: the true origin story

Story version, John's decision (Oct 19 2026, card t_eddf67e7): "Tell them the truth." The talk is
how Weft actually came to be: I designed it in one conversation on Oct 3, and AI agents wrote the
code under my direction, coordinated by Weft itself. Nothing below says I wrote the code.
The through-line: that conversation is a worked example of how I build with agents (12 steps,
slide 17). The earlier feature-led version is kept as `pitch-feature-v1.md` / `slides-feature-v1.html`.

Format: **7 minutes per finalist, demo included** (Dina Kozlov's email, Oct 16 2026).
Q&A, judges and laptop setup were not announced as of Oct 19; see `qa.md`.

Timing (re-counted Oct 19, card t_1e7538f6): **770 spoken words**; at 130 words a minute that is
**5:55**, plus the 47-second clip on slide 12 = **6:42**. Target band 6:15-6:45; 18 seconds of slack
before 7:00. Words per beat: 74 / 279 / 156 (+ clip) / 125 / 136.
Read it slowly. Pause after every quote. If you run long, cut slide 13 (event #834) first
(-25 s), then slide 11 (-25 s). Never cut slides 2, 17 or 18.

Slides: open `slides.html` from disk (no network needed), press `F` for full screen, right arrow
to advance. The clip on slide 12 is inside the file; it starts when you land on the slide and
stops when you leave. Click the video if it doesn't start. Backup: play
<https://weft-media.elier.ai/weft-demo-short.mp4> from 0:37 to 1:24.
Why this clip and not the new live recording: the short video tells the two-agent story with a
voice and captions; the live recording (`connect-2026-backup.mp4`) is silent. Its squiggle beat,
**1:04-1:23**, shows the real refused event #834 and is the backup for slide 13 if a judge asks to
see the live system and the Wi-Fi is down.

Rebuild the deck with `python3 docs/launch/connect-2026/build_slides.py`. Checked Oct 19 with
Playwright at 1920x1080: 18 slides, no overflow, no network requests, clip plays on arrow key and
pauses on leave. Renders and the review kit are in `review/` (start with `review/MORNING.md`).

Only the text in quotation marks is spoken.

## Before you walk on (T-30 min)

1. Laptop on power, Do Not Disturb on, notifications off, display mirroring on.
2. Open `docs/launch/connect-2026/slides.html` from disk; press `F` for full screen.
3. Optional tab: <https://weft.elier.ai/#/r/weft/live> (public, read-only), in case a judge asks
   to see the live log.
4. Backups on the desktop, in case the venue Wi-Fi fails (the deck itself needs no network):
   `curl -o ~/Desktop/weft-demo-short.mp4 https://weft-media.elier.ai/weft-demo-short.mp4`
   (squiggle segment 0:37-1:24) and the live-system recording
   `curl -o ~/Desktop/weft-connect-backup.mp4 https://weft-media.elier.ai/connect-2026-backup.mp4`;
   stills are in `demo/video/connect-2026/stills/`. See `runbook.md`.
5. Run `scripts/connect-preflight.sh` from the repo root; it must end with "All green."

---

## 0:00-0:35 · Who I am, honestly (slides 1-2)

**Slide 1 (title).**
"I'm John Nelson. I'm a product engineer between jobs, living in Uruguay.
On October 3rd, a Saturday night, I read your blog post about the next Git platform.
And I started asking questions."

**Slide 2 (the honest part).**
"How this was built is the point. So here's the truth. I didn't write Weft's code. Agents did.
I asked the questions. I made the decisions. I directed the work. And from the first night,
Weft coordinated the agents building it."

## 0:35-2:45 · The conversation (slides 3-9, one quote each)

**Slide 3 · 8:45 PM. Step 1: explore.**
"My first question was about your brief. 'They want the next GitHub. What does that mean? Are they
conflating git with GitHub?' And: 'Why is git worktrees not the easy answer?'
Worktrees give every agent its own copy. But the agents only find out about each other at merge
time. That's too late."

**Slide 4 · 8:49 PM. Step 4: alternatives.**
"Then jujutsu, the newer version-control tool. 'Why is it not the obvious answer?'
It still records history after the fact. Nothing warns two agents that they're about to collide."

**Slide 5 · 9:17 PM. Step 2: specifics.**
"Then I got specific. 'An agent uses a tool, correct? These changes happen in a sequence.'
Every edit is a tool call. So you can check each one as it happens. And you send the warning back
into the agent's run. It doesn't finish until its code stops conflicting."

**Slide 6 · 9:21 PM. Step 3: solutions.**
"'Think about the little red squiggles.' 'Sort of like a pre-commit hook.'
An agent can get the same thing: an error that says another agent just changed this function,
and here's the change."

**Slide 7 · 9:32 PM. Steps 5 and 6: decide, edge cases.**
"Then a decision: 'a combined event queue that has strict ordering.' I half-remembered a word
from years ago: 'elect'? The word I wanted was consensus. Decide which edit came first, and the
order settles every argument."

**Slide 8 · 9:51 PM.**
"'Are there not tool call hooks with other harnesses? Could we propose that as a new shared
standard, like MCP!' There were hooks, and no shared standard. That became WCP, the Weft
Coordination Protocol."

**Slide 9 · 9:57-10:20 PM. Steps 7, 8, 9: delegate.**
"Then I handed it off. 'Spec this all out in a new Kanban board, set up a heartbeat agent, like a
project manager.' Then: 'Make decisions, without my intervention.'
And the core of it: 'We have to assume the code editor disappears in the future.'"

## 2:45-4:45 · What happened next (slides 10-13, includes the 47-second clip)

**Slide 10 (what the agents did).**
"The first commit landed at 10 PM, eighty minutes after my first question. The board had 25 cards,
and a project-manager agent checked it every hour. Agents worked in parallel, and their edits went
through Weft. Three days later, I watched the demo video, said 'ship it', and submitted."

**Slide 11 (Cloudflare, in plain words).**
"Three Cloudflare pieces do the core work.
A Durable Object is one tiny server with its own database, one per repo. Cloudflare runs exactly
one copy, so it keeps the order. That was my 'elect', built in.
Artifacts is the git storage. Workers is the web service: the API agents call, and the site."

**Slide 12 (the squiggle, 47-second clip).**
"Here's the squiggle. The voice is an AI voice; agents made the video too."
Play the clip. Don't talk over it. (Codex's edit is refused because Claude Code changed
`createSession`; Codex reads the error, adapts, and the retry is accepted.)
After it ends: "The conflict was settled before either commit existed."

**Slide 13 (a real one, from Weft's own build).**
"This one wasn't staged. Event 834 in Weft's own log: an agent's edit was refused because event
813 changed a type it used. Its next try was accepted. Nobody stepped in."

## 4:45-5:40 · What's honest (slides 14-16)

**Slide 14 (the numbers).**
"Weft's own log, on Monday: 918 events. 679 edits. 27 landings on main. Sixty times, Weft told
an agent to wait for another. Five edits were refused before they could land. Most edits go
straight through. The collisions are real, and they get caught."

**Slide 15 (what it isn't).**
"It's a research prototype. The code analysis understands TypeScript and JavaScript only.
WCP is a draft, version 0.1. No outside team runs it in production yet."

**Slide 16 (step 11: use it, find issues).**
"Then I used it, and found problems. My Hacker News post got no upvotes. The build broke. A
stranger sent pull requests. The agents reviewed them and asked for proof. When I put Weft in my
own Mac app, I only saw finished work. I wrote: 'I want every edit visible. That's the magical
part.'"

## 5:40-6:45 · The method and the ask (slides 17-18)

**Slide 17 (How I build with agents, all twelve steps).**
"So here's how I build with agents. Explore. Dig in. Think up solutions. Discuss alternatives.
Decide. Reason through edge cases. Delegate. Build the system around the agents. Hand over
authority, keep sign-off. Verify and steer. Then use it, find the issues, and go back to step one
for each gap. That's where I am now: getting Weft to run on a laptop, and inside my app. Neither
is finished. Preparing this talk was that loop too."

**Slide 18 (close).**
"If the code editor disappears, agents still need squiggles.
With the credits, I'd run a free hosted coordinator for outside teams. And a public benchmark:
many agents on real repos, with and without Weft, measuring the rework it saves.
Delegating breaks down when many agents work at once. Weft is how you verify and steer at that
scale. Thank you."

---

## The method, mapped to the record

All quotes are John's own words from Hermes session `api_1791070817_1d33e733` (-03), unless a
different session is named. The steps were not done strictly in order; the times show the real
sequence. Slide labels use the step that best fits each moment.

| Step | Moment | John's words |
|---|---|---|
| 1 Explore | Oct 3 20:45 | "They want 'the next GitHub'. What does that mean? Are they conflating git with GitHub…?" |
| 2 Dig into specifics | Oct 3 21:12, 21:17 | "Go further. Explain how this system would work in detail and how we could codify it."; "an agent uses a 'tool', correct? These changes happen in a sequence." |
| 3 Think up solutions | Oct 3 21:17, 21:21 | "These 'conflict alerts' could be injected mid-run into the agent message chain"; "Think about the little red squiggles"; "sort of like a pre-commit hook" |
| 4 Discuss alternatives | Oct 3 20:45, 20:49 | "Why is git worktrees not the easy answer?"; "Why is it not the obvious answer?" (jujutsu) |
| 5 Make decisions | Oct 3 21:32 | "there should be a combined event queue that has strict ordering" |
| 6 Reason through edge cases | Oct 3 21:32 | "negotiate… What's it called when there are multiple systems that can propose a change… 'elect'??"; "the combined time-ordered event queue… determines who gets a warning and why" |
| 7 Delegate | Oct 3 21:57 | "Can you spec this all out in a new Kanban board" |
| 8 Build the system around the agents | Oct 3 21:57 | "setup a heartbeat agent that regularly monitors progress on the board… Like a project manager heartbeat" (board: 25 cards, a worktree per card, hourly PM, `docs/pm-log.md` 22:40) |
| 9 Hand over authority, keep sign-off | Oct 3 22:11; Oct 4 13:16 | "Make decisions… without my intervention."; "I would like to have final sign off" |
| 10 Verify and steer | Oct 4 (four "How's it going?" check-ins); Oct 6 12:13 | "I liked the video. Ship it" |
| 11 Use it, find issues | Oct 7 17:07; Oct 7 17:12; Oct 9 00:25 and 21:49; Oct 18 02:16 and 02:32 (session `api_1792301506_7eca465a`) | "no upvotes, no other comments… just vanished into the ether"; "I see the build on github is failing"; "We got a PR on the repo"; "We need to encourage contributions, but require lots of proof"; "all I see is the landed tickets"; "I want every edit visible. that's the magical part of Weft, from my perspective" |
| 12 Iterate: back to step 1 per gap | Oct 13 14:37; Oct 18-19 | "let's focus on getting Weft working locally (without depending on Cloudflare cloud resources"; Weft in Otto; podcasts to find gaps; this talk |

## Things not to say

- Don't say "I built" or "I coded" Weft. Say "I designed it and directed it; agents wrote it."
- Don't say it was built in 11 days. Eleven days was the time left to the deadline when you
  started; the entry was submitted after three (Oct 3 → Oct 6). Work continued after that.
- Don't say the local mode is done. It is on branch `wt/local` (card LOC1), not merged to main.
- Don't call WCP a standard. It's a v0.1 draft; the AAIF item is an open discussion proposal.
- Don't claim production users, revenue or a cost per repo. None exist or are measured.
- Don't say the analysis understands Swift or Python. TypeScript/JavaScript only.
- Don't say you named it. The agent proposed "Weft" as a working name (Oct 3 22:04) and you kept it.

## Sources

| Claim | Source |
|---|---|
| All Oct 3-13 quotes and their times | `~/.hermes/state.db`, `messages` table, session `api_1791070817_1d33e733`, user messages (local to John's Mac, not in the repo) |
| "all I see is the landed tickets" (Oct 18 02:16) | same DB, session `api_1792300118_ad889641` |
| "I want every edit visible…" (Oct 18 02:32) | same DB, session `api_1792301506_7eca465a` |
| Oct 3 2026 was a Saturday | calendar; `one-pager.md` line 3 |
| "I half-remembered a word… 'elect'?" | Oct 3 21:32: "I think i remember something about this from my batch.sh days… 'elect'??" |
| "$25k credits" (slide 18 "the credits") | `qa.md` #20 |
| First commit 22:00:55 -03 Oct 3 ("docs: design v0, plan, agent rules"), 80 min after the first message at 20:40 | `git log --reverse` |
| 25 cards, hourly PM heartbeat, decisions delegated | `docs/pm-log.md`, 2026-10-03 22:40 kickoff |
| A worktree per card | assistant reply in the session, Oct 3 22:04 ("Each card has its own worktree and branch") |
| Weft coordinated its own build from the first night: log starts Oct 4 00:24 -03 (the first ~2.5 h predate it) | `log-stats-2026-10-19.json` (`first_event`, `note`) |
| Submitted Oct 6 after "ship it" | `docs/pm-log.md`, 2026-10-06 entries; submission ID 19a22dd7-554f-43be-b80a-d57ad6414c4c |
| 918 events, 679 edits, 3 agent profiles, 27 landings, 60 wait warnings, 5 refused edits (#642, 643, 760, 834, 891; only #834→#835 was checked for the retry, so the talk says "refused", not "rewritten") | `log-stats-2026-10-19.json` (`events`, `by_kind.edit`, `agents`, `by_kind.land`, `diagnostics_by_code.warning:claim_wait`, `edits_refused`), read from the public API Oct 19. The live count keeps rising. |
| Event #834 refused, caused by #813 (land changing CoordinatorConfig), #835 accepted | live log <https://weft.elier.ai/#/r/weft/live>, read Oct 19; screenshot reused from `slides-feature-v1.html` |
| Squiggle clip | <https://weft-media.elier.ai/weft-demo-short.mp4> 0:37-1:24 (`demo/video/short.json`, segment "the squiggle") |
| Video narrated by an AI voice | `demo/video/submission.md` ("Workers AI also narrated our demo video") |
| Hooks exist in other harnesses, no shared standard | assistant reply Oct 3 21:52; `docs/standardization/one-pager.md` |
| Durable Object = single sequencer per repo; Artifacts = git storage; Workers = gateway + web UI | `README.md` "Why Cloudflare", `docs/design.md` §2, §7 |
| TypeScript/JavaScript-only analysis | `docs/design.md` §4; `qa.md` #11 |
| WCP version 0.1 | `docs/protocol/wcp-v0.md` line 1 |
| No outside team in production | `qa.md` #13 |
| HN post got no traction; CI failing; outside PRs reviewed with "request changes" | session messages Oct 7 17:07, 17:12; Oct 9 00:25, 21:49, 21:57 |
| Local mode in progress, not merged | branch `wt/local`; `docs/pm-log.md` 2026-10-13 16:36 (held); `.worktrees/local/demo/evidence/README.md` (LOC1) |
| Credits plan (hosted coordinator, public benchmark) | `qa.md` #20; `ROADMAP.md` |
| 7 minutes per finalist | Dina Kozlov's finalist email, Oct 16 2026 (John's inbox) |
