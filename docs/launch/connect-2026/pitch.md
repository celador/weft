# Weft at Cloudflare Connect 2026: the visual version (rev 2)

Rev 2 (card t_91a7dc7d, Oct 20 2026): new opener line, ordering reframed as "which change breaks
which", a real without-Weft clip before the squiggle clip, traction + Time Machine on slide 8,
roadmap and token answers in `review/deep-qa.md`. Rev 1 kept as `*-visual-v1`.

Visual version (card t_3c900064, Oct 19 2026). 10 slides, modeled on the strongest Cold Start
pitch: big visual first, numbers early, product, how it works, the clip, how it was built, why it
matters, thesis, takeaway. The previous story version is kept as `pitch-story-v1.md` /
`slides-story-v1.html` (18 slides) and is still a valid fallback.

Format: 7 minutes per finalist, demo included. Wed Oct 21, 1:35 PM PT.
Timing: see the word count at the bottom. Only text in quotation marks is spoken.
Slides: open `slides.html` from disk (no network), press `F` for full screen, right arrow or tap
to advance. The two clips on slide 6a/6b are inside the file, muted, and play when you land on them.
Backups: `slides.pdf`, `slides.pptx` (clip embedded), `slides-story-v1.html`.
Rebuild: `python3 docs/launch/connect-2026/build_slides.py`.

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
- Without-Weft clip (slide 6a): a real run, `demo/m1-baseline.mjs`, evidence in
  `demo/evidence/m1-baseline/` (each branch green alone, clean git merge, main tsc TS2554 + 1 test
  failing). Both agents ran on Codex in that run; say "the same two agents", not "Claude Code".
- Ordering (slides 4-5): what Weft checks is a stale assumption (an edit that reads something
  another agent changed since its base), not arrival time. `packages/sequencer/src/coordinator.ts`
  (stale_assumption); landing is a queue, final rebase + presubmit, compare-and-swap advance of
  main (`apps/workflows`). Merge-order planning from a board (blocked-by/depends-on) is NOT built:
  roadmap only.
- Time Machine: previews per revision exist; the scrub timeline does not. Say "next".

---

## 0:00-0:26 · Slide 1: "I didn't write the code. I directed the agents that did."

"I'm John Nelson. This red line is a squiggle. It's what your editor shows you when your code is
wrong.
Here's the honest part, up front: I didn't write the code. I directed the agents that did. I
asked the questions and I made the decisions."

## 0:26-0:58 · Slide 2: the numbers

"On October 3rd, a Saturday night, I read Cloudflare's post about the next Git platform, and I
started asking questions. Eighty minutes later, the first commit landed.
Sixty-four hours after that, I submitted. 231 files. 38,593 lines. Every commit was written by an
agent.
And in the first eleven hours alone, Weft's log recorded 627 events and 460 edits. 59 times, Weft
told one agent to wait for another."

## 0:58-1:47 · Slide 3: the product

"This is Weft. It's a live feed of every edit every agent makes to a repo, in order, as it
happens. Not after the merge. While they type.
Every row is one event: which agent, which file, what it was doing, and which task on the board
it was for.
On the right are the squiggles: the edits that would have broken someone else's work. Each one
names the function, the file, and the event that caused it. And it tells the agent what to do
next: read the new version, and update your call.
It's public and read-only. You can watch it from your seat."

## 1:47-3:35 · Slides 4-5: how it works

"Here's how it works. Every time an agent edits a file, that edit goes through a checkpoint for
the repo. Cloudflare runs exactly one copy of it, a Durable Object, so every agent sees the same
history.
The real question isn't which edit came first. It's which change breaks which. If one agent
changes a function and another still calls the old version, the healthy order is: the second agent
adopts the new signature, then it lands. So an edit that relies on something another agent just
changed doesn't land. The agent gets a squiggle back, inside its own run: this function changed,
here is the change. It fixes its code and tries again. And main moves one checked landing at a
time.

Under the hood: Workers serve the API and the site. A Durable Object per repo keeps the order.
Artifacts stores the git. Workflows and Queues land the work on main.
And the rules are an open protocol, WCP. It's a draft, version 0.1, and it can run anywhere.
Weft plugs in where the agents already are. Claude Code, Codex and OpenCode can all run a hook
on every tool call, and that's where the check happens. In our test runs, eighteen agents across
those three tools worked on one repo at the same time, through one checkpoint. A typical check
takes just over half a second, so the agent barely notices."

## 3:35-3:57 · Slide 6a: without Weft (22 seconds, muted, a real recorded run, narrate over it)

"First, the same two agents with Weft switched off. One changes createSession. The other keeps
calling the old version. Each branch passes its own tests. Git merges both, no conflict. Then the
build breaks on main, and someone has to send the work back."

## 3:57-4:44 · Slide 6b: with Weft (47 seconds, muted, narrate over it)

"Now with Weft. Claude Code on the left, Codex on the right.
Claude Code changes a function called createSession.
Now Codex tries to edit code that calls it. Refused. There's the squiggle.
Codex reads the error, it's told exactly what changed. It adapts its code.
It tries again, and it's accepted.
No human stepped in. No merge conflict. Nobody found out at review time."
(Pause until the clip ends.)

## 4:44-5:15 · Slide 7: how it was built

"That's not only a demo. Weft coordinated the agents building Weft. By Monday its log had 918
events, 679 edits and 27 landings on main. Sixty waits. Five edits refused before they could land.
Event 834 is a real one: refused because event 813 changed a type it used. The next try was
accepted.
And this is how I work with agents: explore, decide, delegate, verify, repeat."

## 5:15-6:22 · Slide 8: why it matters

"Why does this matter? One agent is a tool. Ten agents on one repo is a team, and teams step on
each other. Today they find out at merge time, like the first clip. Weft moves that moment to edit
time, where the fix is cheap: the agent is still holding the task.
In two weeks: 39 stars, a stranger filed 22 issues and pull requests, and the Beads team asked how
to integrate.
It's a prototype. It understands TypeScript and JavaScript today. Nobody runs it in production yet.
Next: a Time Machine for agent work. Weft already renders a preview of every revision. The
timeline to scrub through them and jump to the one that broke it isn't built yet.
With the credits, I'd run a free hosted coordinator for outside teams, and a public benchmark with
and without Weft, measuring the rework it saves."

## 6:22-6:27 · Slide 9: thesis

"So that's Weft. Red squiggles, for teams of coding agents."

## 6:27-6:44 · Slide 10: takeaway

"We have to assume the code editor disappears. If it does, agents still need squiggles.
It's live right now at weft.elier.ai. Scan it, watch the agents.
And I'm looking for my next builder role. Thank you."

---

Word count (spoken text only, counted by `build_slides.py --count`, Oct 20): 833 words = 6:24 at
130 wpm. The two muted clips run longer than their narration (6a 22.4 s vs ~20 s spoken, 6b 47 s
vs ~30 s), so about 6:44 total, inside the 6:50 hard limit and 16 s under 7:00. Section times
above are cumulative at 130 wpm.
If you run long, cut the twelve steps list on slide 7 to "explore, decide, delegate, verify,
repeat" (-20 s), then the "Picture it" lines on slide 8 (-20 s).
