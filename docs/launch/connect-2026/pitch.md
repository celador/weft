# Weft at Cloudflare Connect 2026: the visual version (rev 5)

Rev 5 (card t_bc6aed38, Oct 20 2026): John's decision: the talk follows Dina's three criteria in
her order, with set time per criterion: (1) what I built, slides 1-3, 0:00-1:30; (2) why it's
new, slide 4, 1:30-2:21 (51 s); (3) many agents changing code at once, slides 5-9, 2:21-5:11: the without-Weft clip,
then the with-Weft clip, then how Weft resolves it, then built with itself; then a short close,
slides 10-12, 5:11-6:08. The two clips moved ahead of the "how it works" slides (problem, then fix, then
mechanism). Slide 4 grew from 26 s to 51 s; slides 9-10 went from 92 s to 55 s by
cutting phrasing, not ideas. Rev 4 is kept as `*-visual-v4`.

Rev 4 (card t_45974a00, Oct 20 2026): aligned with Dina Kozlov's brief (email Oct 19, 23:24 ET):
7 minutes to present, hard cap, then 3 minutes of Q&A, judged on (1) what you built, (2) why it's
novel, (3) how it solves the problems of many agents changing code at once. Changes: a new slide 4,
"Why it's new", says the novelty out loud; slides 3, 4 and 5 carry the three criteria as their
titles; words trimmed (no ideas cut) to bring talk + clips to about 6:23; slides renumbered 1-12 to
match the on-screen counter; small text made bigger for the back of an 80-seat room.
Rev 2 kept as `*-visual-v2`, rev 1 as `*-visual-v1`.

Rev 2 (card t_91a7dc7d): new opener line, ordering reframed as "which change breaks which", a real
without-Weft clip before the squiggle clip, traction + Time Machine, roadmap and token answers in
`review/deep-qa.md`.

Visual version (card t_3c900064, Oct 19 2026), modeled on the strongest Cold Start pitch: big
visual first, numbers early, product, how it works, the clip, how it was built, why it matters,
thesis, takeaway. The story version is kept as `pitch-story-v1.md` / `slides-story-v1.html` (18
slides) and is still a valid fallback.

Format: 7 minutes per finalist, demo included, hard cap; then 3 minutes Q&A. Wed Oct 21, 1:35 PM PT.
Timing: see the bottom. Only text in quotation marks is spoken.
Slides: open `slides.html` from disk (no network), press `F` for full screen, right arrow or tap
to advance. The two clips (slides 5 and 6) are inside the file and play muted when you land on
them; you narrate over them, so the laptop's audio never matters. `M` unmutes a clip if you ever
need the recorded voice track (the 47 s clip has one; the 22 s clip is silent).
Backups: `slides.pdf`, `slides.pptx` (clips embedded), `slides-story-v1.html`.
Rebuild: `python3 docs/launch/connect-2026/build_slides.py`; timing: `... build_slides.py --count`.

Sources for every number (do not mix windows):
- 64 hours, 231 files, 38,593 lines: `qa.md` (first commit Oct 3 22:00 -03, submitted Oct 6
  13:40 -03; every commit authored by agents).
- 627 events, 460 edits, 59 waits: `demo/video/dogfood-stats.json`, first 11.3 hours of the build.
- 918 events, 679 edits, 60 waits, 5 refused, 27 landings: `log-stats-2026-10-19.json` (to Oct 19).
- Event 834 refused because of event 813: Weft's own log (see story version, slide 13).
- Platform: `apps/*/wrangler.toml` (Durable Objects, Artifacts, Workflows, Queues).
- AAIF: `docs/proposal-aaif.md` and aaif/project-proposals#53, an open discussion proposal.
  WCP is a draft, v0.1. Not a standard.
- Hooks, 18 agents, three harnesses: `demo/evidence/m2-report.md` (18 live agents, 6 tasks x
  Claude Code, Codex, OpenCode, one coordinator; four valid runs passed, run 1 aborted).
- "Just over half a second": `demo/evidence/m1-report.md`, pre-edit checks n=18, p50 558 ms.
- Credits plan (hosted coordinator, public benchmark): same ask as the story version; a plan only.
- Beads: the Beads team asked how to integrate. No integration exists. Say "asked", not
  "partnership".
- Traction (gh api repos/celador/weft, Oct 20): 39 stars, repo created Oct 4; 22 issues/PRs
  (12 issues, 10 PRs, Oct 8-13), all from one outside user (barnessomer).
- Without-Weft clip (slide 5): a real run, `demo/m1-baseline.mjs`, evidence in
  `demo/evidence/m1-baseline/` (each branch green alone, clean git merge, main tsc TS2554 + 1 test
  failing). Both agents ran on Codex in that run; say "two agents", not "Claude Code".
- Ordering (slides 7-8): what Weft checks is a stale assumption (an edit that reads something
  another agent changed since its base), not arrival time. `packages/sequencer/src/coordinator.ts`
  (stale_assumption); landing is a queue, final rebase + presubmit, compare-and-swap advance of
  main (`apps/workflows`). Merge-order planning from a board (blocked-by/depends-on) is NOT built:
  roadmap only.
- Time Machine: previews per revision exist; the scrub timeline does not. Say "next".
- Novelty (slide 4): Weft's check runs in the harness's pre-tool hook (Claude Code PreToolUse deny,
  Codex, OpenCode), so a stale edit is refused before it applies, before any commit or PR. That is
  edit time, not landing time. Systems that validate at landing (merge queues, CI, read-set checks
  when a change lands) send finished work back to be redone. "Open protocol": WCP draft v0.1
  (`docs/protocol/wcp-v0.md`), adapters per harness (`packages/adapters/*`) plus a file watcher
  (`@weft/adapter-watcher`, level L0: it reports a person's plain-editor edits; it cannot refuse
  them, so say "joins", not "is checked"). Cloudflare is the reference platform: the coordinator
  runs on Workers + Durable Objects; the protocol does not depend on it. Do not name other
  finalists on stage.
- Criteria map (Dina's brief, her order): (1) what I built = slides 1-3 (0:00-1:30); (2) why it's
  new = slide 4 (1:30-2:21); (3) how it solves many agents at once = slides 5-9 (2:21-5:11): without
  Weft (5), with Weft (6), how Weft resolves it (7-8), built with itself (9). Close = slides 10-12
  (5:11-6:08): why it matters, thesis, takeaway. On-screen kickers: "1 ·", "2 ·", "3 ·".

---

## 0:00-0:19 · Slide 1: "I didn't write the code. I directed the agents that did."

"I'm John Nelson. This red line is a squiggle: your editor's way of saying your code is wrong.
The honest part, up front: I didn't write the code. I directed the agents that did. I asked the
questions and I made the decisions."

## 0:19-0:49 · Slide 2: the numbers

"On October 3rd, a Saturday night, I read Cloudflare's post about the next Git platform and
started asking questions. Eighty minutes later, the first commit landed.
Sixty-four hours later, I submitted. 231 files. 38,593 lines. Every commit written by an agent.
In the first eleven hours, Weft's log recorded 627 events and 460 edits. 59 times, Weft told one
agent to wait for another."

## 0:49-1:30 · Slide 3: 1, what I built

"What I built: Weft. A live feed of every edit every agent makes to a repo, in order, while they
type. Not after the merge.
Each row is one event: which agent, which file, what it was doing, for which task.
On the right, the squiggles: edits that would have broken someone else's work. Each names the
function, the file, and the event that caused it, and tells the agent what to do next: read the
new version, update your call.
It's public and read-only. Watch it from your seat."

## 1:30-2:21 · Slide 4: 2, why it's new

"Two: why it's new. Other systems check a change when it lands. Weft checks every edit while the
agent is still writing it.
That timing is the whole difference. A check at landing runs on finished work, so the work gets
thrown away and redone. Weft catches the conflict before a commit or a pull request exists.
Nothing finished is thrown away: the agent reroutes mid-edit, in seconds, and keeps going.
And it's an open protocol, WCP, a draft at version 0.1. Any agent harness can speak it, and so can
a person: a plain editor joins through a file watcher. Cloudflare is the reference platform; the
protocol runs anywhere."

## 2:21-2:44 · Slide 5: 3, without Weft (22 seconds, muted, a real recorded run, narrate over it)

"Three: many agents changing code at once. First, two agents with Weft switched off. One changes
createSession. The other keeps calling the old version. Each branch passes its own tests. Git
merges both, no conflict. Then the build breaks on main, and someone has to send the work back."

## 2:44-3:31 · Slide 6: with Weft (47 seconds, muted, narrate over it)

"Now with Weft. Claude Code on the left, Codex on the right.
Claude Code changes a function called createSession.
Now Codex tries to edit code that calls it. Refused. There's the squiggle.
Codex reads the error, it's told exactly what changed. It adapts its code.
It tries again, and it's accepted. A typical check takes just over half a second.
No human stepped in. No merge conflict. Caught before a commit existed."
(Pause until the clip ends.)

## 3:31-4:52 · Slides 7-8: how Weft resolves it

"How did Weft resolve that? Every edit goes through one checkpoint per repo, a Durable Object.
Cloudflare runs exactly one copy, so every agent sees the same history.
The question isn't which edit came first. It's which change breaks which. One agent changed a
function; the other still called the old version. The healthy order is: the second adopts the new
signature, then lands. So that edit doesn't land yet. The agent gets a squiggle back, inside its
own run: this function changed, here's the change. It fixes its code and tries again. Main moves
one checked landing at a time.

Under the hood: Workers serve the API and the site. A Durable Object per repo keeps the order.
Artifacts stores the git. Workflows and Queues land work on main.
The rules are WCP, so the harness doesn't matter: Claude Code, Codex and OpenCode each run a hook
on every tool call. That's where the check happens. In our test runs, eighteen agents across
those three tools worked on one repo at once, through one checkpoint."

## 4:52-5:11 · Slide 9: built with itself

"That's not just a demo. Weft coordinated the agents building Weft: 918 events, 27 landings, five
edits refused. Event 834 was refused because 813 changed a type it used; the next try was accepted.
My loop: explore, decide, delegate, verify, repeat."

## 5:11-5:47 · Slide 10: why it matters

"One agent is a tool. Ten on one repo is a team, and teams collide.
In two weeks: 39 stars, a stranger filed 22 issues and pull requests, and the Beads team asked how
to integrate.
It's a prototype: TypeScript and JavaScript, not in production.
Next, a Time Machine: every revision already has a preview; the timeline to scrub them isn't
built.
With the credits: a free hosted coordinator, and a public benchmark of the rework it saves."

## 5:47-5:52 · Slide 11: thesis

"So that's Weft. Red squiggles, for teams of coding agents."

## 5:52-6:08 · Slide 12: takeaway

"We have to assume the code editor disappears. If it does, agents still need squiggles.
It's live right now at weft.elier.ai. Scan it, watch the agents.
And I'm looking for my next builder role. Thank you."

---

Timing (Oct 20, rev 5): 769 spoken words, 130 wpm. Section times above are cumulative and use the
clip length when a clip runs longer than its narration (slide 5: 22.4 s clip vs 22.6 s spoken;
slide 6: 47.0 s clip vs 33 s spoken). Total: about 6:08, 22 s under the 6:30 target and 52 s under
the 7:00 hard cap (rev 4: 6:23).
By criterion: (1) what I built 0:00-1:30 (1:30); (2) why it's new 1:30-2:21 (0:51); (3) many agents
at once 2:21-5:11 (2:50); close 5:11-6:08 (0:57).
What moved, nothing cut: "merge time vs edit time, the agent still holds the task" (old slide 10)
is now said on slide 4 ("thrown away and redone" / "reroutes mid-edit") and stays as the slide 10
line "Weft moves it to edit time". "WCP, a draft, version 0.1" moved from the stack slide to slide
4. 679 edits and 60 waits stay on slide 9's screen, not spoken.
If you run long: on slide 10, drop the credits sentence (-7 s), then on slide 8 the Workers /
Durable Object / Artifacts / Workflows list (the slide shows it, -11 s).
