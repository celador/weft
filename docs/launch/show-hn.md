# Show HN — Wed 2026-10-07, 12:00 Montevideo (08:00 PT)

Submit at https://news.ycombinator.com/submit (from John's own account).

Title:
Show HN: Weft – Red squiggles for teams of coding agents

URL:
https://github.com/celador/weft

First comment (post immediately after submitting):

Hi HN, I'm John. Weft is my entry to Cloudflare's "build the next Git platform" competition.

The idea: GitHub coordinates people at merge time, but agents collide constantly, so merge time is too late. Weft hooks each agent's tool calls (Edit, Write, apply_patch) and puts every edit into one ordered log per repo, along with the symbols it reads and writes. It checks each edit against what other agents changed since. If you're about to call a function another agent just changed, you get a compiler-style diagnostic inside your run, and exactly one side is told to adapt. Conflicts get resolved before a commit exists.

It runs on Cloudflare Workers, with one Durable Object per repo acting as the sequencer, and uses Artifacts for repos and forks. There are adapters for Claude Code, Codex, OpenCode and Hermes. The protocol (WCP) is open, and I've written it up as a proposal for a shared hook standard.

Honest notes: most of the code was written by agents, and those agents were coordinated by Weft while building it (627 events and 59 "wait for the other agent" warnings in the first 11 hours). It's a two-week prototype. The analysis is TypeScript only, the Cursor and Gemini adapters are only tested offline, and the full multi-agent demo needs a lot of Cloudflare setup. The protocol tests and local gateway run with no account.

Live read-only log: https://demo.weft.mx
Video (7 min): https://weft-media.elier.ai/weft-demo.mp4
Longer write-up: https://johnaaronnelson.com/blog/weft-built-under-weft

I'd especially like pushback on the protocol design and on whether edit-time coordination beats just splitting up the work.
