# Weft at Cloudflare Connect 2026: the criteria-led version (rev 7.1)

Rev 7.1 (card t_d28190c3, Oct 20 2026): rev 7 plus two Archify diagrams built from the source
(`diagrams/architecture.json`, `diagrams/conflict.json` -> checked HTML + PNG). No spoken words
changed (750 words, 6:25 with clips). Slide 2: the architecture diagram left of the live feed.
Slide 9: the five steps on the left, the conflict sequence diagram on the right. Each slide has an
interactive link (new tab, presentation view on the highlighted path) for Q&A. Rev 7 is kept as `*-v7`.


Rev 7 (card t_a16b130a, Oct 20 2026): rev 6 plus the 58 s Otto clip from the run-4 team demo
(card t_83def502, `demo/evidence/otto-report.md`): 7 kanban cards running at once on one board in
Otto, candidates on 5 harnesses, no orchestrator. It is its own slide (8), right after the with-Weft
clip under Q2, narrated muted. Both earlier clips stay: total is under 6:30 because the
"how it resolves" (9) and Q3 (10) narration got shorter (the clip just showed both). Otto stills: the
board + "Editing now" on Q1 (slide 5), the revert sheet on Q3 (slide 10). Gemini CLI moves to "live"
on slide 4: in run-4 its Weft hooks ran live (`demo/evidence/otto/run-4/lanes/t7/agents/gemini-t7-r4/`,
every edit checked and accepted, a candidate pushed and reviewed). Its quota failure is in
`review/deep-qa.md`, not on slides. Rev 6 is kept as `*-v6` (pitch, build script, slides html/pdf/pptx).

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

(The outline above is rev 6. Rev 7 numbering and times are in the section headings below: Q2 is
slides 6-9, Q3 slide 10, Q4 slide 11, Artifacts slide 12, close slide 13.)

Dropped as the frame: "I didn't write the code. I directed the agents that did." and the
Oct 3 origin arc. The origin numbers (64 hours, 231 files, 38,593 lines, 627 events) now live in
`review/deep-qa.md` under "Origin story" for Q&A. One proof line stays on slide 2: Weft
coordinated the agents that built Weft (918 events, 27 landings).
Rev 5 is kept as `*-visual-v5` (pitch, build script, slides html/pdf/pptx, cue card, deep-qa).

Format: 7 minutes per finalist, demo included, hard cap; then 3 minutes Q&A. Wed Oct 21, 1:35 PM PT.
Timing: see the bottom. Only text in quotation marks is spoken.
Slides: open `slides.html` from disk (no network), press `F` for full screen, right arrow or tap
to advance. The three clips (slides 6, 7 and 8) are inside the file and play muted when you land on
them; you narrate over them, so the laptop's audio never matters. `M` unmutes a clip if you ever
need the recorded voice track (the 47 s clip has one; the 22 s and 58 s clips are silent).
Backups: `slides.pdf`, `slides.pptx` (clips embedded), `slides-v6.html` (rev 6).
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
  `m2-report.md`, `b12*`), Hermes (dogfood, `design.md` B16) and Gemini CLI (Otto run-4: hooks
  fired on every edit, checks accepted, candidate pushed; `demo/evidence/otto/run-4/lanes/t7/agents/
  gemini-t7-r4/hooks.jsonl`, `adapter.log`; no Gemini edit was refused in that run). Cursor CLI:
  adapter written to its documented hooks, not live-verified. File watcher
  (`@weft/adapter-watcher`, level L0) reports edits from any editor, a person's included; it
  cannot refuse them, so say "joins", not "is checked". Say "a Cursor adapter is written", never
  "runs live".
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
- Otto clip (slide 8) and Otto stills (slides 5, 10): run-4 of `demo/otto` (card t_83def502),
  `demo/evidence/otto-report.md` + `demo/evidence/otto/run-4/run.json`, cut by
  `demo/otto/video/cut.py` (trim/crop/captions only, no re-staging). On-screen numbers: 7 cards
  (t1-t7) running at once on board weft-demo-site; 16 candidates on 5 harnesses (Claude Code 5,
  Codex 4, Gemini CLI 3, OpenCode 2, Hermes 2); winners came from 4 (Codex t1/t3, OpenCode t2/t7,
  Hermes t4, Claude Code t5/t6); 6 `stale_assumption` squiggles, all rerouted; t3's overload
  proposals (#655, #659) accepted by t1's agent (#662, #663), overload on trunk; Mergiraf landing
  on t5; t6 (menu) evidence: preview, 2 screenshots, pixel diff, risk, review; 3 approvals (t1, t3,
  t6) by clicking Otto's Approve button, approved_by=john (the clicks were sent by the recording
  script on John's machine, not by hand); planted bug t8 landed, reverted 32.5 s later (#780), Weft
  task reopened; trunk tsc + 22/22 tests green; all 7 cards landed. Do not say "I approved".
  Say "no agent in charge": no planner in the run; each card's lane only talks to Weft.

---

## 0:00-0:15 · Slide 1: "Red squiggles for teams of coding agents."

"I'm John Nelson, and this is Weft. Red squiggles for teams of coding agents.
Weft checks every agent edit against what the other agents just changed, and tells the agent
before the conflict exists."

## 0:15-0:43 · Slide 2: 1, what I built

Left: the architecture diagram (protocol + platform). Right: the live feed.

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
Any harness works with any other in one codebase. Claude Code, Codex, OpenCode, Hermes and Gemini
run live today; a Cursor adapter is written. A file watcher lets anything else join, people
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

## 3:29-4:27 · Slide 8: Q2, a whole team in Otto (58 seconds, muted, a real run, narrate over it)

"Now a whole team: a real run, on one board in Otto. Seven cards running at once, with candidates
on five harnesses: Claude Code, Codex, OpenCode, Gemini and Hermes. No agent is in charge.
A squiggle stops a stale edit mid-flight, and the agent reroutes. Six squiggles in this run; all
six rerouted.
An Approve click in Otto lets this candidate land.
This one changed the menu, so it comes with a preview, screenshots and a pixel diff.
Here an agent proposed an overload, and the agent that changed createSession accepted it.
All seven cards landed.
Then a planted bug. It lands, production errors spike, and Weft reverts it thirty-two seconds later."
(Pause until the clip ends.)

## 4:27-4:53 · Slide 9: Q2, how Weft resolves it

Left: the five steps. Right: the conflict sequence diagram, the same five beats in order.

"Under the hood: a stale edit is refused. The agent reroutes, or negotiates, like that overload.
When two agents want the same code, priority decides who adapts, every time, so they never
deadlock. Adjacent edits get a structural merge with Mergiraf. And landing is a compare-and-swap on
trunk: main only moves if nothing moved under it."

## 4:53-5:20 · Slide 10: Q3: how do you review everything they produce?

"How do you review everything they produce? You just saw it: every candidate gets tests, a preview,
screenshots with a pixel diff, a risk tier, and a review agent that checks the task's acceptance
criteria and fails closed. Low risk lands on its own; higher risk waits for a human. And if
production errors spike, Weft reverts the landing."

## 5:20-5:42 · Slide 11: Q4: how do you keep track of why?

"How do you keep track of why? Every commit carries a Change-Id, a Task-Id and an Agent-Id. Every
squiggle cites the event that caused it. The log replays byte for byte, each run's model
transcript is stored, and a revert names the operation it undoes, and why."

## 5:42-6:09 · Slide 12: why Artifacts and Cloudflare

"Why Cloudflare? Honestly, Weft doesn't need Artifacts to work. Artifacts is what lets it scale:
one call forks the repo and mints a scoped token for each agent, it's built for millions of
repos, every push arrives as an event in a Queue, and landing is an atomic push. And Durable
Objects give each repo exactly one authoritative log."

## 6:09-6:21 · Slide 13: close

"So that's Weft. Red squiggles for teams of coding agents. It coordinates; it doesn't
orchestrate.
It's live at weft.elier.ai. Scan it and watch the agents. Thank you."

---

Timing (Oct 21, t_dadae7a9): the closing "next builder role" sentence was dropped (contact line on
slide 13 instead): 742 spoken words, about 6:21 with clips; close 6:09-6:21.
Timing (Oct 20, rev 7): 750 spoken words at 130 wpm, computed by `build_slides.py --count`. Section
times above are cumulative and use the clip length when a clip runs longer than its narration
(slide 6: 22.4 s clip vs 15 s spoken; slide 7: 47.0 s clip vs 21 s spoken; slide 8: 58.1 s clip vs
52 s spoken). Total: about 6:25, 5 s under the 6:30 target and 35 s under the 7:00 hard cap
(rev 6: 5:33). The Otto clip added 58 s; shorter narration on slides 9 and 10 (the clip had just
shown negotiation, approval, evidence and the revert) took back 6 s, so both earlier clips stay.
By criterion: (1) what I built 0:00-0:43; (2) why it's new 0:43-1:51; (3) many agents at once, the
four questions 1:51-5:42 (Q1 0:28, Q2 2:34 incl. three clips, Q3 0:27, Q4 0:22); why Artifacts +
Cloudflare 5:42-6:09; close 6:09-6:25.
Slide 8 narration is cued to the clip's captions: board (0-8 s), squiggle (8-15), reroute + Approve
(15-23), menu evidence (23-30), negotiated overload (30-37), landings (37-43), planted bug +
revert (43-58). If you fall behind the clip, skip "Six squiggles in this run; all six rerouted."
Moved to Q&A (`review/deep-qa.md`, "Origin story"): Oct 3 start, 80 minutes to first commit,
64 hours, 231 files, 38,593 lines, 627 events / 460 edits / 59 waits, event 834 refused because of
813 (still visible on slide 11 as the cause example), the explore/decide/delegate/verify loop,
traction (39 stars, 22 issues/PRs from one outside user, Beads asked), Time Machine (next, not
built), credits plan, prototype status. Otto run details and honest failures: `review/deep-qa.md`,
"The Otto run".
If you run long: on slide 4, drop "a Cursor adapter is written" (-2 s); on slide 12, drop "every
push arrives as an event in a Queue" (-4 s); on slide 2, drop the 918/27 line (-5 s); on slide 10,
drop "You just saw it:" (-1 s). Worst case, skip slide 9 (-26 s): the Otto clip already showed the
reroute, the negotiation and the landings.
