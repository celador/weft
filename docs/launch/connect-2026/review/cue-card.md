# Cue card · Weft · 12 slides · talk + clips 6:23 · hard cap 7:00

Judges score, in order: (1) what you built, (2) why it's novel, (3) many agents at once.

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
writing it."** Before a commit or PR exists → fixed in seconds, no redone work · open protocol, any harness

**1:56 · (3) MANY AGENTS AT ONCE** (slides 5-6)
Every edit → one checkpoint per repo (**Durable Object**, one shared history) → not "which came
first" but **which change breaks which** (second adopts the new signature, then lands) → squiggle
back → fix, retry · Workers · DO · Artifacts · Workflows + Queues · **WCP v0.1** runs anywhere ·
hooks: Claude Code, Codex, OpenCode · **18 agents**, one checkpoint

**3:23 · WITHOUT WEFT, CLIP 22 s, real run** (slide 7)
Same two agents, Weft off · each branch green alone · git merges clean · **build breaks on main** → work sent back

**3:45 · WITH WEFT, CLIP 47 s, NARRATE** (slide 8)
createSession changed → Codex **refused** → reads, adapts → accepted · ~½ s per check ·
"No human. No merge conflict. Caught before a commit existed." · **pause until it ends**

**4:32 · BUILT WITH ITSELF** (slide 9)
918 events · 679 edits · 27 landings · 60 waits · 5 refused · event #834 ← #813
Explore · decide · delegate · verify · repeat

**5:01 · WHY IT MATTERS** (slide 10)
1 agent = tool, 10 = team · merge time, like the first clip · edit time = cheap ·
**2 weeks: 39 stars · a stranger filed 22 issues/PRs · Beads team *asked* how to integrate** ·
prototype, TS/JS, not in prod · **Next: Time Machine** (previews per revision exist, timeline NOT built) ·
credits: free hosted coordinator + public benchmark

**6:02 · THESIS** (slide 11): "Red squiggles, for teams of coding agents."

**6:07 · CLOSE** (slide 12): "If the code editor disappears, agents still need squiggles."
weft.elier.ai QR · next builder role · Thank you.

Running long: drop the credits line (slide 10), then the Workers/DO/Artifacts list (slide 6, it's on screen).
