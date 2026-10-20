# Cue card · Weft · 11 slides · talk + clips 6:44, limit 6:50

**0:00 · SQUIGGLE, HONEST UP FRONT** (slide 1)
**"I didn't write the code. I directed the agents that did."** I asked, decided.

**0:25 · NUMBERS** (slide 2)
Oct 3, Saturday night, Cloudflare blog post · first commit in 80 min ·
**64 h · 231 files · 38,593 lines** · first 11 h: 627 events · 460 edits · 59 waits

**0:55 · PRODUCT** (slide 3)
Live feed of every edit, while they type · row = agent, file, task · **squiggles** name the
function, the cause, what to do · public, read-only

**1:50 · HOW IT WORKS** (slides 4-5)
Every edit → one checkpoint per repo (**Durable Object**, one shared history) → not "which came first" but **which change breaks which** (B adopts A's new signature, then lands) → squiggle back →
fix, retry · Workers · DO · Artifacts · Workflows + Queues · **WCP v0.1** runs anywhere ·
hooks: Claude Code, Codex, OpenCode · **18 agents**, one checkpoint · ~½ s per check

**3:20 · WITHOUT WEFT, CLIP 22 s, real run** (slide 6a)
Same two agents, Weft off · each branch green alone · git merges clean · **build breaks on main** → work sent back

**3:40 · WITH WEFT, CLIP 47 s, NARRATE** (slide 6b)
createSession changed → Codex **refused** → reads, adapts → accepted ·
"No human. No merge conflict." · **pause until it ends**

**4:30 · BUILT WITH ITSELF** (slide 7)
918 events · 679 edits · 27 landings · 60 waits · 5 refused · event #834 ← #813
Explore · decide · delegate · verify · repeat

**5:10 · WHY IT MATTERS** (slide 8)
1 agent = tool, 10 = team · merge time, like the first clip · edit time = cheap ·
**2 weeks: 39 stars · a stranger filed 22 issues/PRs · Beads team *asked* how to integrate** ·
prototype, TS/JS, not in prod · **Next: Time Machine** (previews per revision exist, timeline NOT built) ·
credits: free hosted coordinator + public benchmark

**6:25 · THESIS** (slide 9): "Red squiggles, for teams of coding agents."

**6:30 · CLOSE** (slide 10): "If the code editor disappears, agents still need squiggles."
weft.elier.ai QR · next builder role · Thank you.
