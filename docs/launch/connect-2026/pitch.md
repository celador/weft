# Weft at Cloudflare Connect 2026: the visual version

Visual version (card t_3c900064, Oct 19 2026). 10 slides, modeled on the strongest Cold Start
pitch: big visual first, numbers early, product, how it works, the clip, how it was built, why it
matters, thesis, takeaway. The previous story version is kept as `pitch-story-v1.md` /
`slides-story-v1.html` (18 slides) and is still a valid fallback.

Format: 7 minutes per finalist, demo included. Wed Oct 21, 1:35 PM PT.
Timing: see the word count at the bottom. Only text in quotation marks is spoken.
Slides: open `slides.html` from disk (no network), press `F` for full screen, right arrow or tap
to advance. The clip on slide 6 is inside the file, muted, and plays when you land on it.
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
- Beads: conversations with people on the Beads team. No integration exists. Say "interest", not
  "partnership".

---

## 0:00-0:40 · Slide 1: "I didn't write the code. Agents did."

"I'm John Nelson. This red line is a squiggle. It's what your editor shows you when your code is
wrong.
Here's the honest part, up front: I didn't write Weft's code. Agents did. I asked the questions, I
made the decisions, and I directed the work."

## 0:40-1:25 · Slide 2: the numbers

"On October 3rd, a Saturday night, I read Cloudflare's post about the next Git platform, and I
started asking questions. Eighty minutes later, the first commit landed.
Sixty-four hours after that, I submitted. 231 files. 38,593 lines. Every commit was written by an
agent.
And in the first eleven hours alone, Weft's log recorded 627 events and 460 edits. 59 times, Weft
told one agent to wait for another."

## 1:25-2:00 · Slide 3: the product

"This is Weft. It's a live feed of every edit every agent makes to a repo, in order, as it
happens. Not after the merge. While they type.
On the right are the squiggles: the edits that would have broken someone else's work."

## 2:00-3:05 · Slides 4-5: how it works

"Here's how it works. Every time an agent edits a file, that edit goes to one place first: a
checkpoint for the repo. Cloudflare runs exactly one copy of it, a Durable Object, so there is one
true order.
If the edit conflicts with what another agent just changed, it doesn't land. The agent gets a
squiggle back, inside its own run: this function changed, here is the change. It fixes its code
and tries again. The conflict is settled before either commit exists.

Under the hood: Workers serve the API and the site. A Durable Object per repo keeps the order.
Artifacts stores the git. Workflows and Queues land the work on main.
And the rules are an open protocol, WCP. It's a draft, version 0.1, and it can run anywhere."

## 3:05-3:55 · Slide 6: the clip (47 seconds, muted, narrate over it)

"Here are two agents on the same repo. Claude Code on the left, Codex on the right.
Claude Code changes a function called createSession.
Now Codex tries to edit code that calls it. Refused. There's the squiggle.
Codex reads the error, it's told exactly what changed. It adapts its code.
It tries again, and it's accepted.
No human stepped in. No merge conflict. Nobody found out at review time."
(Pause until the clip ends.)

## 3:55-4:50 · Slide 7: how it was built

"That's not only a demo. Weft coordinated the agents building Weft. By Monday its log had 918
events, 679 edits and 27 landings on main. Sixty waits. Five edits refused before they could land.
Event 834 is a real one: refused because event 813 changed a type it used. The next try was
accepted.
And this is how I work with agents, in twelve steps. Explore, dig in, think up solutions, discuss
alternatives, decide, reason through edge cases. Then delegate, build the system around the
agents, hand over authority but keep sign-off, verify and steer. Then use it, find the gaps, and
go back to step one."

## 4:50-5:40 · Slide 8: why it matters

"Why does this matter? One agent is a tool. Ten agents on one repo is a team, and teams step on
each other. Today they find out at merge time. That's too late, and it's expensive.
So the protocol is open. I've opened a discussion proposal with the Agentic AI Foundation, and
people on the Beads team have been talking with me about it.
It's a prototype. It understands TypeScript and JavaScript today. Nobody runs it in production yet.
That's the next step."

## 5:40-6:00 · Slide 9: thesis

"So that's Weft. Red squiggles, for teams of coding agents."

## 6:00-6:30 · Slide 10: takeaway

"We have to assume the code editor disappears. If it does, agents still need squiggles.
It's live right now at weft.elier.ai. Scan it, watch the agents.
And I'm looking for my next builder role. Thank you."

---

Word count (spoken text only, counted by `build_slides.py --count`): see the build output; target
815-875 words at 130 wpm = 6:15-6:45 with the clip narrated. If you run long, cut the twelve
steps list on slide 7 to "explore, decide, delegate, verify, repeat" (-20 s).
