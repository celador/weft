# Cue card · Weft · rev 7.1 · 13 slides · talk + clips 6:21 · hard cap 7:00

Judges score, in order: (1) what you built, (2) why it's novel, (3) many agents at once.
Criterion 3 = Cloudflare's four questions, one slide each.
Budget: (1) 0:00-0:43 · (2) 0:43-1:51 · (3) Q1-Q4 1:51-5:42 · Cloudflare 5:42-6:09 · close 6:09-6:21.

**0:00 · HEADLINE** (slide 1)
**"Red squiggles for teams of coding agents."** Checks every agent edit against what the others
just changed · tells the agent **before the conflict exists**

**0:15 · (1) WHAT I BUILT** (slide 2)
Two things: open protocol **WCP** + reference platform on Cloudflare (left: architecture diagram) ·
live feed, weft.elier.ai (right) ·
squiggles on the right · built with itself: **918 events · 27 landings**

**0:43 · (2) WHY IT'S NEW: SQUIGGLES** (slide 3)
Agents message each other as **diagnostics**, into the agent's own run, mid-edit · carries the
other agent's code (diff) · others check **when it lands**, Weft **while it's being written** ·
no finished work thrown away

**1:14 · "COORDINATES, DOESN'T ORCHESTRATE."** (slide 4)
No agent on top · **peers** · any harness with any harness · **live:** Claude Code, Codex,
OpenCode, Hermes, Gemini · **written:** Cursor · file watcher: anything else *joins*, people too ·
runs on a laptop, no account · **Cloudflare is how it scales**

**1:51 · (3) Q1 · WHO'S WORKING ON WHAT** (slide 5)
"Cloudflare's post asked four questions." One ordered log per repo, **one Durable Object** ·
intent · claim · edit · checkpoint = events · each edit vs functions/types others just changed ·
(still: Otto board, 7 running, who's editing what)

**2:19 · Q2 · CONFLICTS · WITHOUT WEFT, CLIP 22 s, real run** (slide 6)
createSession changed, other keeps old call · each branch green · git merges clean · **main breaks**

**2:42 · Q2 · WITH WEFT, CLIP 47 s** (slide 7)
Codex edit **refused before it's written** · squiggle quotes Claude's change · adapts → accepted ·
~½ s · no human · **pause until it ends**

**3:29 · Q2 · A WHOLE TEAM IN OTTO, CLIP 58 s, real run** (slide 8)
One board in Otto · **7 cards at once** · candidates on **5 harnesses** (Claude Code, Codex, OpenCode,
Gemini, Hermes) · **no agent in charge** · squiggle → reroute (6 squiggles, all rerouted) · Approve
click in Otto · menu change: preview + screenshots + pixel diff · overload proposed → accepted ·
**all 7 landed** · planted bug → errors → **reverted 32 s later** · **pause until it ends**

**4:27 · Q2 · HOW IT RESOLVES** (slide 9)
Stale edit refused · reroute or **negotiate** ("like that overload") · **priority decides who
adapts**, no deadlocks · **Mergiraf** for adjacent edits · land = **compare-and-swap** on trunk ·
(right: the conflict sequence diagram; same words)

**4:53 · Q3 · REVIEW** (slide 10)
"You just saw it." Tests · preview · screenshots + pixel diff · risk tier · review agent vs
acceptance criteria, **fails closed** · low risk lands itself, higher waits for a human ·
prod error spike → **Weft reverts** (still: the Otto revert sheet)

**5:20 · Q4 · WHY** (slide 11)
Change-Id · Task-Id · Agent-Id on every commit · squiggle cites its cause event · log replays byte
for byte · transcript per run · revert names the op + reason

**5:42 · WHY ARTIFACTS + CLOUDFLARE** (slide 12)
"Honestly, Weft doesn't need Artifacts to work." Artifacts = scale: fork + scoped token per
agent, one call · millions of repos · push → Queue event · atomic landing · DO = one log per repo

**6:09 · CLOSE** (slide 13): "Red squiggles for teams of coding agents. It coordinates; it doesn't
orchestrate." weft.elier.ai QR · Thank you.

Never say: "Cursor runs live", "I approved" (the Otto clicks were scripted on my account), "file
watcher blocks edits", "preview deploy" (it's a preview served from Artifacts), any competitor's name.
Running long: drop "a Cursor adapter is written" (slide 4), the Queue line (slide 12), the 918/27
line (slide 2); worst case skip slide 9 (-26 s).
Q&A: origin numbers, traction, Time Machine, tokens, merge order, the Otto run: `review/deep-qa.md`.
