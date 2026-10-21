# Cue card · Weft · rev 7.1 · 14 slides · talk + clips 6:43 · hard cap 7:00

Judges score, in order: (1) what you built, (2) why it's novel, (3) many agents at once.
Criterion 3 = Cloudflare's four questions, one slide each.
Budget: (1) 0:00-1:12 · (2) 1:12-2:13 · (3) Q1-Q4 2:13-6:04 · Cloudflare 6:04-6:28 · close 6:28-6:43.

**0:00 · HEADLINE** (slide 1)
**"Red squiggles for teams of coding agents."** Checks every agent edit against what the others
just changed · tells the agent **before the conflict exists**

**0:15 · (1) THE PROBLEM: MERGE TIME IS TOO LATE** (slide 2)
"One: the problem, and what I built." Agents in parallel worktrees break each other's assumptions
every few minutes · by the PR, an hour built on a **signature that no longer exists** ·
(slide only, not spoken: 627 events · 460 edits · 18 landings, 0 reverts · 59 waits, first 11 h)

**0:37 · (1) ONE ORDERED LOG PER REPO: HOOK · SEQUENCE · ANSWER** (slide 3)
Open protocol **WCP** + platform on Cloudflare · **Hook**: adapter catches each edit before disk ·
**Sequence**: one Durable Object per repo orders + checks vs what landed since your base ·
**Answer**: allow / advise / deny, compiler-style diagnostic in the tool result ·
"We're **proposing** Agent Hooks Core and WCP to the **AAIF**, in collaboration with members of
**Gas Town**."

**1:12 · (2) WHY IT'S NEW: SQUIGGLES** (slide 4)
Agents message each other **in squiggles**, mid-edit, with the other agent's diff · **real Codex
tool result** · "The agent reads the diagnostic. **You don't have to.**" · others check **when it
lands**, Weft **while it's being written**

**1:41 · "COORDINATION, NOT ORCHESTRATION"** (slide 5)
No agent on top · **peers** · **live:** Claude Code, Codex,
OpenCode, Hermes, Gemini · **written:** Cursor · file watcher: anything else *joins*, people too ·
runs on a laptop, no account · **Cloudflare is how it scales**

**2:13 · (3) Q1 · WHO'S WORKING ON WHAT** (slide 6)
"Cloudflare's post asked four questions." One ordered log per repo, **one Durable Object** ·
intent · claim · edit · checkpoint = events · each edit vs functions/types others just changed ·
(still: Otto board, 7 running, who's editing what)

**2:42 · Q2 · CONFLICTS · WITHOUT WEFT, CLIP 22 s, real run** (slide 7)
createSession changed, other keeps old call · each branch green · git merges clean · **main breaks**

**3:04 · Q2 · WITH WEFT, CLIP 47 s** (slide 8)
Codex edit **refused before it's written** · squiggle quotes Claude's change · adapts → accepted ·
~½ s · no human · **pause until it ends**

**3:51 · Q2 · A WHOLE TEAM IN OTTO, CLIP 58 s, real run** (slide 9)
One board in Otto · **7 cards at once** · candidates on **5 harnesses** (Claude Code, Codex, OpenCode,
Gemini, Hermes) · **no agent in charge** · squiggle → reroute (6 squiggles, all rerouted) · Approve
click in Otto · menu change: preview + screenshots + pixel diff · overload proposed → accepted ·
**all 7 landed** · planted bug → errors → **reverted 32 s later** · **pause until it ends**

**4:49 · Q2 · HOW IT RESOLVES** (slide 10)
Stale edit refused · reroute or **negotiate** ("like that overload") · **priority decides who
adapts**, no deadlocks · **Mergiraf** for adjacent edits · land = **compare-and-swap** on trunk ·
(right: the conflict sequence diagram; same words)

**5:15 · Q3 · REVIEW** (slide 11)
(slide: "Humans get a feed, not a merge queue.") "You just saw it." Tests · preview · screenshots + pixel diff · risk tier · review agent vs
acceptance criteria, **fails closed** · low risk lands itself, higher waits for a human ·
prod error spike → **Weft reverts** (still: the Otto revert sheet)

**5:42 · Q4 · WHY** (slide 12)
Change-Id · Task-Id · Agent-Id on every commit · squiggle cites its cause event · log replays byte
for byte · transcript per run · revert names the op + reason

**6:04 · WHY ARTIFACTS + CLOUDFLARE** (slide 13)
"Honestly, Weft doesn't need Artifacts to work." Artifacts = scale: trunk + isolated fork per
candidate · DO = one ordered log per repo · Queues + Workflows land and revert · Containers =
sandboxed builds/tests · D1 + R2 = evidence

**6:28 · CLOSE** (slide 14): "Red squiggles for teams of coding agents. It coordinates; it doesn't
orchestrate." "**Two agents, one repo, five minutes**, no Cloudflare account needed. Scan it to try
it." QR → **weft-site.elier.ai** · Thank you.

Never say: "Cursor runs live", "I approved" (the Otto clicks were scripted on my account), "file
watcher blocks edits", "preview deploy" (it's a preview served from Artifacts), any competitor's name.
Never say: "adopted", "a standard" or "AAIF-backed" (both specs are v0 drafts, proposed).
Running long: drop "a Cursor adapter is written" (slide 5), "Queues and Workflows land and revert"
(slide 13), "This is a real Codex tool result" (slide 4), the "I built an open protocol..." opener
(slide 3); worst case skip slide 10 (-26 s).
Q&A: origin numbers, traction, Time Machine, tokens, merge order, the Otto run: `review/deep-qa.md`.
