# Cue card · Weft · rev 6 · 12 slides · talk + clips 5:33 · hard cap 7:00

Judges score, in order: (1) what you built, (2) why it's novel, (3) many agents at once.
Criterion 3 = Cloudflare's four questions, one slide each.
Budget: (1) 0:00-0:43 · (2) 0:43-1:51 · (3) Q1-Q4 1:51-4:50 · Cloudflare 4:50-5:17 · close 5:17-5:33.

**0:00 · HEADLINE** (slide 1)
**"Red squiggles for teams of coding agents."** Checks every agent edit against what the others
just changed · tells the agent **before the conflict exists**

**0:15 · (1) WHAT I BUILT** (slide 2)
Two things: open protocol **WCP** + reference platform on Cloudflare · live feed, weft.elier.ai ·
squiggles on the right · built with itself: **918 events · 27 landings**

**0:43 · (2) WHY IT'S NEW: SQUIGGLES** (slide 3)
Agents message each other as **diagnostics**, into the agent's own run, mid-edit · carries the
other agent's code (diff) · others check **when it lands**, Weft **while it's being written** ·
no finished work thrown away

**1:14 · "COORDINATES, DOESN'T ORCHESTRATE."** (slide 4)
No agent on top · **peers** · any harness with any harness · **live:** Claude Code, Codex,
OpenCode, Hermes · **written:** Cursor, Gemini · file watcher: anything else *joins*, people too ·
runs on a laptop, no account · **Cloudflare is how it scales**

**1:51 · (3) Q1 · WHO'S WORKING ON WHAT** (slide 5)
"Cloudflare's post asked four questions." One ordered log per repo, **one Durable Object** ·
intent · claim · edit · checkpoint = events · each edit vs functions/types others just changed

**2:19 · Q2 · CONFLICTS · WITHOUT WEFT, CLIP 22 s, real run** (slide 6)
createSession changed, other keeps old call · each branch green · git merges clean · **main breaks**

**2:42 · Q2 · WITH WEFT, CLIP 47 s** (slide 7)
Codex edit **refused before it's written** · squiggle quotes Claude's change · adapts → accepted ·
~½ s · no human · **pause until it ends**

**3:29 · Q2 · HOW IT RESOLVES** (slide 8)
Hook refuses · reroute or **negotiate** (propose / accept / counter) · **priority decides who
adapts**, same rule, no deadlocks · **Mergiraf** structural merge · land = **compare-and-swap** on trunk

**3:59 · Q3 · REVIEW** (slide 9)
Evidence per candidate: tests · preview · screenshots + pixel diff · risk tier · review agent vs
acceptance criteria, **fails closed** · low risk lands itself, higher waits for a human ·
prod error spike → **auto-revert**

**4:28 · Q4 · WHY** (slide 10)
Change-Id · Task-Id · Agent-Id on every commit · squiggle cites its cause event · log replays byte
for byte · transcript per run · revert names the op + reason

**4:50 · WHY ARTIFACTS + CLOUDFLARE** (slide 11)
"Honestly, Weft doesn't need Artifacts to work." Artifacts = scale: fork + scoped token per
agent, one call · millions of repos · push → Queue event · atomic landing · DO = one log per repo

**5:17 · CLOSE** (slide 12): "Red squiggles for teams of coding agents. It coordinates; it doesn't
orchestrate." weft.elier.ai QR · next builder role · Thank you.

Never say: "Cursor/Gemini run live", "file watcher blocks edits", "preview deploy" (it's a
preview served from Artifacts), any competitor's name.
Running long: drop "Cursor and Gemini adapters are written" (slide 4), the Queue line (slide 11),
the 918/27 line (slide 2).
Q&A: origin numbers, traction, Time Machine, tokens, merge order: `review/deep-qa.md`.
