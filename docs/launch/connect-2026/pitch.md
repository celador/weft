# Weft at Cloudflare Connect 2026: the criteria-led version (rev 6)

Rev 6 (card t_3435fdd7, Oct 20 2026): John's decision: the talk is built on the judging criteria,
not the origin story. Slide 1 is the website headline, verbatim. The spine is Dina's three
criteria, in her order, and criterion 3 is answered through the four questions from Cloudflare's
competition post (blog.cloudflare.com/next-git-platform-on-cloudflare), one slide each:

1. What I built: slides 1-2 (0:00-0:43)
2. Why it's new: slides 3-4 (0:43-1:51), including John's line "Coordinates, doesn't orchestrate."
3. How it solves many agents changing code at once: slides 5-10 (1:51-4:50)
   - Q1 How do agents know what other agents are working on? (slide 5)
   - Q2 What happens when they make conflicting changes? (slides 6-8: without-Weft clip,
     with-Weft clip, how Weft resolves it)
   - Q3 How do you review everything they produce? (slide 9)
   - Q4 How do you keep track of why? (slide 10)
4. Why Artifacts and Cloudflare (slide 11, 4:50-5:17), then the close (slide 12, 5:17-5:33)

Dropped as the frame: "I didn't write the code. I directed the agents that did." and the
Oct 3 origin arc. The origin numbers (64 hours, 231 files, 38,593 lines, 627 events) now live in
`review/deep-qa.md` under "Origin story" for Q&A. One proof line stays on slide 2: Weft
coordinated the agents that built Weft (918 events, 27 landings).
Rev 5 is kept as `*-visual-v5` (pitch, build script, slides html/pdf/pptx, cue card, deep-qa).

Format: 7 minutes per finalist, demo included, hard cap; then 3 minutes Q&A. Wed Oct 21, 1:35 PM PT.
Timing: see the bottom. Only text in quotation marks is spoken.
Slides: open `slides.html` from disk (no network), press `F` for full screen, right arrow or tap
to advance. The two clips (slides 6 and 7) are inside the file and play muted when you land on
them; you narrate over them, so the laptop's audio never matters. `M` unmutes a clip if you ever
need the recorded voice track (the 47 s clip has one; the 22 s clip is silent).
Backups: `slides.pdf`, `slides.pptx` (clips embedded), `slides-visual-v5.html` (rev 5).
Rebuild: `python3 docs/launch/connect-2026/build_slides.py`; timing: `... build_slides.py --count`.

Sources for every claim (nothing unbuilt is presented as built):
- Headline and lede: `site/public/index.html` (h1 and .lede), verbatim.
- Protocol + platform: WCP draft v0.1, `docs/protocol/wcp-v0.md`; platform `apps/*/wrangler.toml`
  (Workers, Durable Objects, Artifacts, Workflows, Queues, Containers).
- 918 events, 27 landings: `log-stats-2026-10-19.json` (Weft's own log, to Oct 19).
- Squiggles carry the other agent's code: `docs/design.md` B4 update (the adapter fetches the
  causing event and quotes its hunks); positioned `stale_assumption` text in `docs/try-it.md` §4a.
- Edit time vs landing time: the check runs in the harness's pre-tool hook (Claude Code
  PreToolUse deny; Codex; OpenCode `tool.execute.before`), so a stale edit is refused before it
  applies. Do not name other finalists.
- Coordinates, doesn't orchestrate: there is no planner agent in the coordination path; the
  coordinator is a log plus validation rules, and arbitration is between peers (`design.md` §2.6,
  §4). Escalation can merge two tasks (B11), still without a lead agent splitting work.
- Harnesses: live-verified Claude Code, Codex, OpenCode (`demo/evidence/m1-report.md`,
  `m2-report.md`, `b12*`) and Hermes (dogfood, `design.md` B16). Cursor CLI: adapter written to
  its documented hooks, not live-verified. Gemini CLI: fixture-only. File watcher
  (`@weft/adapter-watcher`, level L0) reports edits from any editor, a person's included; it
  cannot refuse them, so say "joins", not "is checked". Say "Cursor and Gemini adapters are
  written", never "run live".
- Runs without Cloudflare: `docs/try-it.md` (local gateway via `wrangler dev`, no Cloudflare
  account, no API token, no model key; tests need no network services).
- Q1: one Durable Object per repo (`apps/gateway/src/index.ts`, `idFromName(repo)`); event kinds
  intent, claim, edit, checkpoint, land, revert, negotiate.* (`design.md` §3, spec §4); validation
  against writes since the agent's base at symbol granularity (`design.md` §4, spec §6).
- Q2: PreToolUse deny with a positioned `stale_assumption` quoting the other side's hunk (B4,
  M1); negotiation `propose|counter|accept|reject|escalate` (B11, `demo/evidence/b11`, 5/5 valid
  runs); seniority = task priority then first event, wound-wait default, wait-die per repo (spec
  §7.1-7.2): one side adapts, so no deadlock; claim arbitration is advice by default. Mergiraf
  structural merge in rebase (B7/B8); landing = fast-forward-only `--force-with-lease` push, a lost
  race is `stale_trunk` (B6/B8): a compare-and-swap on trunk.
- Q3: ProcessRevision evidence stages (B10): tests, preview of the rebased revision (served from
  Artifacts, not a deploy, so say "a preview"), Browser Rendering screenshots with pixel diff,
  risk tier (heuristic floor + classifier), review agent against the task's acceptance criteria
  that fails closed. BestOfN auto-lands low risk; medium/high waits for a human approve.
  Auto-revert on a production error spike: B13, live on preview (`demo/evidence/b13-auto-revert-live`).
- Q4: `Change-Id` / `Task-Id` / `Agent-Id` trailers (`design.md` §2.2, commit-msg hook);
  diagnostics carry `caused_by_seq` (§3); input journal replays the DO byte for byte (B2); model
  transcripts per sandbox run shipped to R2 (`apps/sandbox/src/runner.ts`, agent.stdout.log);
  revert = one commit with a `Weft-Reverts-Op:` trailer and a `revert {reverts_op_id, reason}`
  event (B8).
- Why Artifacts: the gateway's candidates endpoint forks trunk and mints a repo-scoped write token
  per candidate in one call (B6); "millions of repositories" is Cloudflare's own description of
  Artifacts (the competition post); `pushed` events go to Queue `weft-artifacts-events` (B6);
  landing is an atomic lease push (`--force-with-lease`). Durable Objects: one authoritative
  log per repo.
- Without-Weft clip (slide 6): a real run, `demo/m1-baseline.mjs`, evidence in
  `demo/evidence/m1-baseline/` (each branch green alone, clean git merge, main tsc TS2554 + 1 test
  failing). Both agents ran on Codex in that run; say "two agents", not "Claude Code".
- "About half a second": `demo/evidence/m1-report.md`, pre-edit checks n=18, p50 558 ms.

---

## 0:00-0:15 · Slide 1: "Red squiggles for teams of coding agents."

"I'm John Nelson, and this is Weft. Red squiggles for teams of coding agents.
Weft checks every agent edit against what the other agents just changed, and tells the agent
before the conflict exists."

## 0:15-0:43 · Slide 2: 1, what I built

"One: what I built. Weft is two things. An open protocol, WCP, for agents that share one
codebase. And a reference platform for it on Cloudflare.
This is the live feed, public at weft.elier.ai: every edit every agent makes, in order, as they
work. On the right, the squiggles.
Weft coordinated the agents that built Weft: 918 events, 27 landings."

## 0:43-1:14 · Slide 3: 2, why it's new: agents message each other in squiggles

"Two: why it's new. Agents send each other messages as diagnostics: the same red squiggle your
editor shows you, delivered into the agent's own run, mid-edit. And it carries the other agent's
code: this function changed, here's the diff, update your call.
Other systems check a change when it lands. Weft checks every edit while the agent is still
writing it, so no finished work gets thrown away."

## 1:14-1:51 · Slide 4: Coordinates, doesn't orchestrate.

"Weft coordinates; it doesn't orchestrate. There's no agent on top splitting up the work. Agents
are peers, and each one hears only about what touches its own edit.
Any harness works with any other in one codebase. Claude Code, Codex, OpenCode and Hermes run live
today; Cursor and Gemini adapters are written. A file watcher lets anything else join, people
included.
And the protocol doesn't need Cloudflare: it runs on a laptop, no account. Cloudflare is how it
scales."

## 1:51-2:19 · Slide 5: 3, Q1: how do agents know what other agents are working on?

"Three: many agents changing code at once. Cloudflare's post asked four questions. Here are
Weft's answers.
How do agents know what the others are working on? One ordered log per repo, held by one Durable
Object. Every intent, claim, edit and checkpoint is an event in it. And every edit is checked
against the functions and types the other agents just changed."

## 2:19-2:42 · Slide 6: Q2: what happens when they make conflicting changes? Without Weft (22 seconds, muted, a real recorded run, narrate over it)

"What happens when they conflict? First, without Weft. One agent changes createSession. The other
keeps calling the old version. Each branch passes its own tests. Git merges both, no conflict.
Then main breaks."

## 2:42-3:29 · Slide 7: Q2, with Weft (47 seconds, muted, narrate over it)

"Now with Weft. Claude Code changes createSession.
Codex tries to edit a caller. Refused, before the edit is written. There's the squiggle, quoting
Claude's change.
Codex reads it, adapts its call, and tries again. Accepted. A check takes about half a second.
No human stepped in."
(Pause until the clip ends.)

## 3:29-3:59 · Slide 8: Q2, how Weft resolves it

"Under the hood: the hook refuses the stale edit. The agent can reroute, or negotiate: propose an
overload, and the other agent accepts or counters.
When two agents want the same code, priority decides who adapts, the same rule every time, so
they never deadlock.
Then a structural merge with Mergiraf. And landing is a compare-and-swap on trunk: main only
moves if nothing moved under it."

## 3:59-4:28 · Slide 9: Q3: how do you review everything they produce?

"How do you review everything they produce? Every candidate goes through an evidence pipeline:
tests, a preview, screenshots with a pixel diff, a risk tier, and a review agent that checks the
task's acceptance criteria and fails closed.
Low risk can land on its own. Higher risk waits for a human. And if production errors spike after
a landing, Weft reverts it."

## 4:28-4:50 · Slide 10: Q4: how do you keep track of why?

"How do you keep track of why? Every commit carries a Change-Id, a Task-Id and an Agent-Id. Every
squiggle cites the event that caused it. The log replays byte for byte, each run's model
transcript is stored, and a revert names the operation it undoes, and why."

## 4:50-5:17 · Slide 11: why Artifacts and Cloudflare

"Why Cloudflare? Honestly, Weft doesn't need Artifacts to work. Artifacts is what lets it scale:
one call forks the repo and mints a scoped token for each agent, it's built for millions of
repos, every push arrives as an event in a Queue, and landing is an atomic push. And Durable
Objects give each repo exactly one authoritative log."

## 5:17-5:33 · Slide 12: close

"So that's Weft. Red squiggles for teams of coding agents. It coordinates; it doesn't
orchestrate.
It's live at weft.elier.ai. Scan it and watch the agents. And I'm looking for my next builder
role. Thank you."

---

Timing (Oct 20, rev 6): 651 spoken words at 130 wpm, computed by `build_slides.py --count`. Section
times above are cumulative and use the clip length when a clip runs longer than its narration
(slide 6: 22.4 s clip vs 15 s spoken; slide 7: 47.0 s clip vs 21 s spoken). Total: about 5:33,
57 s under the 6:30 target and 1:27 under the 7:00 hard cap (rev 5: 6:08). The slack is
deliberate: a first-time stage delivery runs slower than 130 wpm, and the clips need pauses.
By criterion: (1) what I built 0:00-0:43 (headline + slide 2); (2) why it's new 0:43-1:51 (1:08);
(3) many agents at once, the four questions 1:51-4:50 (2:59: Q1 0:28, Q2 1:40 incl. both clips,
Q3 0:29, Q4 0:22); why Artifacts + Cloudflare 4:50-5:17; close 5:17-5:33.
Moved to Q&A (`review/deep-qa.md`, "Origin story"): Oct 3 start, 80 minutes to first commit,
64 hours, 231 files, 38,593 lines, 627 events / 460 edits / 59 waits, event 834 refused because of
813 (still visible on slide 10 as the cause example), the explore/decide/delegate/verify loop,
traction (39 stars, 22 issues/PRs from one outside user, Beads asked), Time Machine (next, not
built), credits plan, prototype status.
If you run long: on slide 4, drop "Cursor and Gemini adapters are written" (-3 s); on slide 11,
drop "every push arrives as an event in a Queue" (-4 s); on slide 2, drop the 918/27 line (-5 s).
