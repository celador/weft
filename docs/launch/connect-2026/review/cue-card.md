# Cue card · Weft · 12 slides · talk + clips 6:08 · hard cap 7:00

Judges score, in order: (1) what you built, (2) why it's novel, (3) many agents at once.
Budget: (1) 0:00-1:30 · (2) 1:30-2:21 · (3) 2:21-5:11 · close 5:11-6:08.

**0:00 · SQUIGGLE, HONEST UP FRONT** (slide 1)
**"I didn't write the code. I directed the agents that did."** I asked, decided.

**0:19 · NUMBERS** (slide 2)
Oct 3, Saturday night, Cloudflare blog post · first commit in 80 min ·
**64 h · 231 files · 38,593 lines** · first 11 h: 627 events · 460 edits · 59 waits

**0:49 · (1) WHAT I BUILT** (slide 3)
Live feed of every edit, while they type · row = agent, file, task · **squiggles** name the
function, the cause, what to do · public, read-only

**1:30 · (2) WHY IT'S NEW** (slide 4)
**"Other systems check a change when it lands. Weft checks every edit while the agent is still
writing it."** Timing is the whole difference · landing check = finished work thrown away, redone ·
before a commit/PR → **nothing thrown away, agent reroutes mid-edit**, keeps going ·
**open protocol WCP**, draft v0.1 · any harness, or a person (plain editor via file watcher) ·
Cloudflare = reference platform, protocol runs anywhere

**2:21 · (3) MANY AGENTS AT ONCE · WITHOUT WEFT, CLIP 22 s, real run** (slide 5)
"Three: many agents changing code at once." Two agents, Weft off · each branch green alone ·
git merges clean · **build breaks on main** → work sent back

**2:44 · WITH WEFT, CLIP 47 s, NARRATE** (slide 6)
createSession changed → Codex **refused** → reads, adapts → accepted · ~½ s per check ·
"No human. No merge conflict. Caught before a commit existed." · **pause until it ends**

**3:31 · HOW WEFT RESOLVES IT** (slides 7-8)
Every edit → one checkpoint per repo (**Durable Object**, one shared history) → not "which came
first" but **which change breaks which** (second adopts the new signature, then lands) → squiggle
back → fix, retry · Workers · DO · Artifacts · Workflows + Queues · rules = WCP, so harness
doesn't matter · hooks: Claude Code, Codex, OpenCode · **18 agents**, one checkpoint

**4:52 · BUILT WITH ITSELF** (slide 9)
918 events · 27 landings · 5 refused · event #834 ← #813, next try accepted
Explore · decide · delegate · verify · repeat

**5:11 · WHY IT MATTERS** (slide 10)
1 agent = tool, 10 = team, teams collide · **2 weeks: 39 stars · a stranger filed 22 issues/PRs ·
Beads team *asked* how to integrate** · prototype, TS/JS, not in prod · **Next: Time Machine**
(previews per revision exist, timeline NOT built) · credits: free hosted coordinator + public benchmark

**5:47 · THESIS** (slide 11): "Red squiggles, for teams of coding agents."

**5:52 · CLOSE** (slide 12): "If the code editor disappears, agents still need squiggles."
weft.elier.ai QR · next builder role · Thank you.

Running long: drop the credits line (slide 10), then the Workers/DO/Artifacts list (slide 8, it's on screen).
