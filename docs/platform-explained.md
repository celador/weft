Weft in three pages: [Protocol](protocol/wcp-explained.md) (the rules) · **Platform** (the referee) · [Product](product-explained.md) (the window)

# The Weft platform explained (one page)

The protocol is the rules. The platform is the referee that enforces them: Cloudflare Workers that keep each repo's log, check every edit, then take finished work through tests, evidence, selection, landing and, if production breaks, revert. Details: [design.md](design.md) §6 and its dated updates, [platform-runbook.md](platform-runbook.md). Everything below runs on the **preview** stack (`*-preview.elier.ai`); the production Worker names are configured but not deployed.

## The pieces

1. **Gateway** (`apps/gateway`). The front door, like an API server in front of a database. It checks the token and forwards to the right repo. Tokens live in a `Registry` Durable Object with scopes: `agent` (submit edits), `observe` (read), `human` (approve, undo, pause, message, merge), `system` (workflows, scripts).
2. **Sequencer** (`packages/sequencer`, the `RepoCoordinator` Durable Object). This *is* the protocol's coordinator: one instance per repo, with its own SQLite database, running one request at a time, so it numbers events without races. Tests require it to match the in-memory reference exactly, and replaying its input journal rebuilds the log byte for byte. It also holds the **submit queue** (the landing line) and the live stream.
3. **Adapters** (`packages/adapters`). One plugin per agent tool: check before an edit, commit after, gate on stop and `git commit`. Live: Claude Code, Codex, OpenCode, Hermes. Cursor and Gemini: tested against documented formats only. A file watcher covers tools without hooks. If the gateway is down or slow (5 s), adapters fail open: the edit runs and the agent is told.
4. **Artifacts** (`packages/artifacts`). Cloudflare's hosted Git. Each repo has a trunk; each candidate gets its own **fork** with a write token for that fork only. Every push is queued and logged as a `checkpoint`.
5. **Workflows** (`apps/workflows`). Crash-proof multi-step jobs: `ProcessRevision`, `BestOfN`, `LandChange`, `RevertOperation`.
6. **Sandbox** (`apps/sandbox`). One container per job with git, Node, Mergiraf, Claude Code and Codex. It holds **no secrets**: no direct internet, and every request leaves through a Worker that adds the token for that path only.
7. **Previews** (`apps/previews`) serves one exact commit's static site straight from Artifacts. **Production signal** (`apps/production-signal`) is a Tail Worker on the deployed app that counts exceptions and triggers a revert on a spike.
8. **Web Worker extras** (`apps/web`): a **policy** check run as separate isolated code via Workers for Platforms (built-in fallback if unset), **email intake** (an email becomes a task intent and gets a reply), and **Analytics Engine** counters. Coded and in the runbook; whether the Email Routing rule and dispatch namespace exist in the account was not checked.

## The pipeline (design §6): built vs designed

| Step | Status |
|---|---|
| 1. Intake: predict which symbols a task touches | **Designed, partly coded.** `apps/gateway/src/planner.ts` has tests, but no route calls it and no Vectorize index is bound. Tasks come from scripts (demo drivers) or email. |
| 2. Dispatch: fork per candidate, scoped token, agent + adapter | **Built.** `POST .../tasks/{task}/candidates` forks and mints the token. Demo agents ran on John's Mac in clones of their forks; the sandbox can run agents but the demos didn't use that. |
| 3. On every push: rebase (git → Mergiraf → resolver model → back to agent), tests, preview, screenshots, review | **Built** (`ProcessRevision`). Static-site previews only; the review reads text, not screenshots. |
| 4. Selection: rank, auto-land low risk, else wait for a human | **Built** (`BestOfN`): tests first, then merge difficulty, size, cost, review score. |
| 5. Landing: submit queue, final rebase + tests, compare-and-swap push | **Built** (`LandChange`): the push fails if trunk moved, then retries; `land` is logged, claims released. |
| 6. Post-land: deploy, watch errors, auto-revert, reopen task | **Built.** Workers Builds deployed the first demo target from Artifacts; the later demo site was deployed by a local wrangler script (Builds needed a dashboard step). The detector blames any spike on the latest land. |

## One task, end to end

A script creates "free shipping over $50" with three candidates; the gateway forks trunk three times. Claude Code, Codex and OpenCode each work in a fork; the sequencer checks every edit and squiggles anyone building on a stale function. On each push, `ProcessRevision` rebases onto trunk in a sandbox, runs tests, screenshots a preview, and has a model review and risk-score it. `BestOfN` ranks the three; low risk, so no human. `LandChange` waits its turn, rebases once more, pushes trunk, logs `land`. The site redeploys. If 5+ exceptions follow within 10 minutes, `RevertOperation` reverts it, reopens the task with the stack trace, and tells the agent.

## Local mode

`pnpm dev:local` in `apps/gateway` runs gateway, sequencer and token registry on a laptop with no Cloudflare account ([try-it.md](try-it.md)). That is the whole protocol: checks, squiggles, claims, negotiation, gates, log and stream. Not local: forks, queues, workflows, sandboxes, previews, evidence, landing queue, auto-revert. You merge yourself and post `land` with `scripts/local-quickstart.mjs land`.

## Cloudflare services, in plain terms

| Service | Plain role |
|---|---|
| Durable Object + SQLite | Single-writer database for one repo's log, claims and landing line |
| Workers | Stateless API servers (gateway, web, previews, policy) |
| Artifacts | Hosted Git: trunk plus a fork per candidate |
| Queues | Mailbox between "someone pushed" and "process it" |
| Workflows | Crash-proof jobs: process, select, land, revert |
| Containers | Throwaway Linux box for git and tests, no keys inside |
| D1 / R2 | Index of tasks and evidence / file store for screenshots and logs |
| Browser Rendering | Headless browser for preview screenshots |
| Workers AI, AI Gateway | Risk, review and merge-resolver models, traffic tagged per task |
| Tail Workers, Analytics Engine | Error tap on the live app; time-series counters |
| Workers for Platforms | Runs each policy as isolated code |
| Email Routing / Access | Task by email / web login (coded; preview uses an operator key) |
