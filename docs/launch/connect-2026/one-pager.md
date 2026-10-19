# Weft: red squiggles for teams of coding agents

*John Aaron Nelson · Cloudflare GitHub Competition finalist · Cloudflare Connect, Oct 21 2026*
*(Talk format: 7 minutes per finalist, per the organizers' Oct 16 email. Q&A format not
announced.)*

**The problem.** Git coordinates people at merge time. Agents edit code in seconds and collide
constantly, so by the time a pull request exists, one agent has already built on code another
agent changed. Merge time is too late.

**What Weft does.** It hooks each agent's edits (Edit, Write, apply_patch) and puts them in one
ordered log per repository, with the functions and types each edit reads and writes. Every edit
is checked against what other agents changed since that agent started. On a conflict, the agent
gets a compiler-style error inside its own run, with the other agent's change quoted, and
exactly one side is told to adapt. No file locks, and conflicts are settled before a commit
exists.

**Built on Cloudflare.**
- Durable Objects: one per repo, a tiny server with its own SQLite that Cloudflare runs exactly
  once, so it can hand out the order of edits.
- Workers: the API agents talk to, and the web UI.
- Artifacts: Git hosting for each repo's main branch plus a fork per agent.
- Queues + Workflows: the retryable job pipeline that rebases, tests, picks a winner and lands.
- Containers: throwaway Linux boxes for git and tests, with no secrets inside.
- D1 (SQL index), R2 (logs and screenshots), Workers AI (review).

**Evidence.**
- Built under itself: 627 events in 11.3 hours, 460 edits by 3 agent profiles across 25 tasks,
  18 landings, 59 "wait for the other agent" warnings.
- 18 live agents (Claude Code, Codex, OpenCode) on one coordinator: every coordination beat
  passed in all 4 valid runs.
- Pre-edit check: median 558 ms against the deployed gateway.

**Open.** MIT licensed. The protocol (WCP) works with any agent: adapters for Claude Code,
Codex, OpenCode and Hermes; Cursor CLI and Gemini CLI translators. Agent Hooks Core, the hook
rules underneath, is a v0 draft with a conformance suite, proposed to the Agentic AI Foundation
for discussion.

**Links.**
- Site: <https://weft-site.elier.ai>
- Live log (read-only): <https://weft.elier.ai>
- Code: <https://github.com/celador/weft>
- 3-minute video: <https://weft-media.elier.ai/weft-demo-short.mp4>
- Talk to John: <https://calendly.com/john-johnaaronnelson/chat> · john@elier.ai

| Weft site | Book a chat with John |
|---|---|
| ![QR code: weft-site.elier.ai](qr-weft-site.png) | ![QR code: calendly.com/john-johnaaronnelson/chat](qr-calendly.png) |

Sources for the numbers: `demo/video/dogfood-stats.json`, `demo/evidence/m2-report.md`,
`demo/evidence/m1-report.md` (full table at the bottom of `pitch.md`).
