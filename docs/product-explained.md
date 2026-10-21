Weft in three pages: [Protocol](protocol/wcp-explained.md) (the rules) · [Platform](platform-explained.md) (the referee) · **Product** (the window)

# The Weft product explained (one page)

The product is the window: what a person opens to see what their agents are doing to the code, and to step in. This page covers what exists today, then what is **not decided** about selling it.

## The problem, in user terms

You run several coding agents at once on one repo. Each works in its own copy and none knows what the others are doing. You find out at merge time: two agents changed the same function, one called a function the other just renamed, the build breaks, and you spend the afternoon untangling it. Or you stop running agents in parallel.

Weft moves that discovery to the moment of the edit: the agent about to break something gets a compiler-style error and corrects itself. You don't read every diff. You watch one feed and act only when Weft asks (Approve) or something looks wrong (Undo, Pause, Message).

**Who it's for:** developers and small teams who already run more than one coding agent at a time and want the speed without the merge cleanup. Today that is John's own setup: Weft's own build, and the Hermes agents across his repos.

## What exists today

All of these read the repo's ordered event log, so they always agree.

### 1. Web UI (`apps/web`)

- **Public demo, [weft.elier.ai](https://weft.elier.ai).** Read-only, no login: the real logs of the dogfood repo and demo runs, secrets scrubbed.
- **Operator UI** (`weft-web-preview.elier.ai`, sign-in with an operator key; Cloudflare Access login is coded but not configured). Views:
  - **Live:** every edit, squiggle, negotiation, landing and revert as it happens, each squiggle linked to its cause; **Replay** of a run at up to 64×.
  - **Board:** tasks in columns Queued / Working / Squiggled / Review / Landed / Reverted.
  - **Task:** competing candidates side by side with tests, previews, screenshots, pixel diff, review and risk, and **Approve**.
  - **Ops:** every landing and revert, with **Undo**.
  - **Policy** and **Analytics:** try a landing policy on sample evidence; see outcome counts for the repo.
  - Buttons: Approve and Undo. The Worker's API also passes pause, resume and message, but the page has no buttons for them yet. The browser never holds a Weft token; the Worker acts for you and adds your email to the log entry.

### 2. Weft in Otto (`~/code/hermes-ios`)

Otto, John's native Hermes app (iPhone, iPad, Mac), has a **Changes** view: one live feed of Weft events across every repo, with filters and a diff per event. The dashboard's **Weft strip** shows each agent edit and "Editing now" per running card. From an event you can **Approve**, **Undo**, **Pause**/**Resume** or **Message**. Otto gets the gateway address and a human token from the connected Hermes host, so there is nothing to type. With a read-only token, actions are refused with "This token can only read." The recorded Connect demo used Otto's Approve.

### 3. Any other observer client

The gateway's observer API (spec §9) lists repos, pages events, serves a combined feed and a WebSocket stream, and with a `human` token accepts actions. **Merging two tasks** is one of them, but no app has a button for it yet.

### What a human can do, by surface

| Action | Public web | Operator web | Otto | API |
|---|---|---|---|---|
| Watch the live feed | yes | yes | yes | yes |
| Approve a landing | no | yes | yes | yes |
| Undo (revert) a landing | no | yes | yes | yes |
| Pause / resume an agent | no | no button (its API allows it) | yes | yes |
| Message an agent | no | no button (its API allows it) | yes | yes |
| Merge two tasks | no | no | no | yes |

## Not decided yet: the commercial product

There is no business model, price, or paying customer today. The one stated direction, marked "unverified / not decided" in the Connect Q&A ([qa.md](launch/connect-2026/qa.md) #14): the protocol stays open, and the natural product is a **hosted coordinator and evidence platform for teams running many agents**, like GitHub hosting around open Git, priced only after learning from the first outside teams (#20: offer it to them free at first). [ROADMAP.md](../ROADMAP.md) targets the first outside organization in production in Q1 2027.

Open questions:

- **Who pays?** Individual developers, teams, or the companies whose agents run on it (harness vendors)?
- **Hosted or self-hosted?** A Weft-run service, a deploy-to-your-own-Cloudflare kit (the stack already deploys per account), or both?
- **What is the paid part?** Coordination itself, or the layer around it: evidence, best-of-N selection, landing queue, auto-revert, policies, history?
- **Pricing unit?** Per seat, per repo, per agent, per landed change, or usage (sandbox minutes, model calls)?
- **What stays open source?** Today everything is MIT: specs, coordinator, adapters, analyzer, web UI, Cloudflare apps. Does it all stay that way, and if not, where is the line?
- **Where does Otto fit?** Part of the product, or a separate app that happens to be a good Weft client?
- **First customers?** None yet; onboarding outside teams by hand is the stated next step (qa.md #13).
