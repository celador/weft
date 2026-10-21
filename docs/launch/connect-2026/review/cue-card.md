# Cue card · Weft · rev 7.1 · 14 slides · talk + clips 6:41 · hard cap 7:00

Judges score, in order: (1) what you built, (2) why it's novel, (3) many agents at once.
Criterion 3 = Cloudflare's four questions, one slide each.
Budget: (1) 0:00-1:02 · (2) 1:02-2:10 · (3) Q1-Q4 2:10-6:01 · Cloudflare 6:01-6:28 · close 6:28-6:41.

**0:00 · HEADLINE** (slide 1)
**"Red squiggles for teams of coding agents."** Checks every agent edit against what the others
just changed · tells the agent **before the conflict exists**

**0:15 · (1) WHAT I BUILT** (slide 2)
Two things: open protocol **WCP** + reference platform on Cloudflare (left: architecture diagram) ·
live feed, weft.elier.ai (right) ·
squiggles on the right · built with itself: **918 events · 27 landings**

**0:43 · (1) WCP, THE WEFT COORDINATION PROTOCOL** (slide 3)
In one line: a shared, **ordered log** of **who changed which function**, checked like **database
transactions**, conflicts back to each agent as **compiler-style errors** · open spec + JSON schema +
conformance tests

**1:02 · (2) WHY IT'S NEW: SQUIGGLES** (slide 4)
Agents message each other **through those errors** (squiggles), into the agent's own run,
mid-edit · carries the other agent's code (diff) · others check **when it lands**, Weft **while it's being written** ·
no finished work thrown away

**1:34 · "COORDINATION, NOT ORCHESTRATION"** (slide 5)
No agent on top · **peers** · any harness with any harness · **live:** Claude Code, Codex,
OpenCode, Hermes, Gemini · **written:** Cursor · file watcher: anything else *joins*, people too ·
runs on a laptop, no account · **Cloudflare is how it scales**

**2:10 · (3) Q1 · WHO'S WORKING ON WHAT** (slide 6)
"Cloudflare's post asked four questions." One ordered log per repo, **one Durable Object** ·
intent · claim · edit · checkpoint = events · each edit vs functions/types others just changed ·
(still: Otto board, 7 running, who's editing what)

**2:39 · Q2 · CONFLICTS · WITHOUT WEFT, CLIP 22 s, real run** (slide 7)
createSession changed, other keeps old call · each branch green · git merges clean · **main breaks**

**3:01 · Q2 · WITH WEFT, CLIP 47 s** (slide 8)
Codex edit **refused before it's written** · squiggle quotes Claude's change · adapts → accepted ·
~½ s · no human · **pause until it ends**

**3:48 · Q2 · A WHOLE TEAM IN OTTO, CLIP 58 s, real run** (slide 9)
One board in Otto · **7 cards at once** · candidates on **5 harnesses** (Claude Code, Codex, OpenCode,
Gemini, Hermes) · **no agent in charge** · squiggle → reroute (6 squiggles, all rerouted) · Approve
click in Otto · menu change: preview + screenshots + pixel diff · overload proposed → accepted ·
**all 7 landed** · planted bug → errors → **reverted 32 s later** · **pause until it ends**

**4:46 · Q2 · HOW IT RESOLVES** (slide 10)
Stale edit refused · reroute or **negotiate** ("like that overload") · **priority decides who
adapts**, no deadlocks · **Mergiraf** for adjacent edits · land = **compare-and-swap** on trunk ·
(right: the conflict sequence diagram; same words)

**5:12 · Q3 · REVIEW** (slide 11)
"You just saw it." Tests · preview · screenshots + pixel diff · risk tier · review agent vs
acceptance criteria, **fails closed** · low risk lands itself, higher waits for a human ·
prod error spike → **Weft reverts** (still: the Otto revert sheet)

**5:39 · Q4 · WHY** (slide 12)
Change-Id · Task-Id · Agent-Id on every commit · squiggle cites its cause event · log replays byte
for byte · transcript per run · revert names the op + reason

**6:01 · WHY ARTIFACTS + CLOUDFLARE** (slide 13)
"Honestly, Weft doesn't need Artifacts to work." Artifacts = scale: fork + scoped token per
agent, one call · millions of repos · push → Queue event · atomic landing · DO = one log per repo

**6:28 · CLOSE** (slide 14): "Red squiggles for teams of coding agents. It coordinates; it doesn't
orchestrate." weft.elier.ai QR · Thank you.

Never say: "Cursor runs live", "I approved" (the Otto clicks were scripted on my account), "file
watcher blocks edits", "preview deploy" (it's a preview served from Artifacts), any competitor's name.
Running long: drop "a Cursor adapter is written" (slide 5), the Queue line (slide 13), the 918/27
line (slide 2), the open-spec sentence (slide 3); worst case skip slide 10 (-26 s).
Q&A: origin numbers, traction, Time Machine, tokens, merge order, the Otto run: `review/deep-qa.md`.
