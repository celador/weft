# Weft Coordination Protocol (WCP)

Weft coordinates coding agents while they edit—not only when they open a pull request. Agents submit tool-call edits to a per-repository sequencer. The sequencer validates each edit against accepted changes since the agent's base and returns actionable diagnostics to the agent through its native hooks. Humans see the same event stream and can approve, pause, message, undo, or inspect evidence.

The goal is to make concurrent agent work safer without file locks or requiring agents to stop and wait for a human merge. WCP is the harness-neutral wire protocol; Weft is its Cloudflare-backed implementation and set of adapters.

Live demo: [demo.weft.mx](https://demo.weft.mx) — the web UI over the real event logs of the dogfood repo and the demo runs, public and read-only (no login).

Status: research/demo implementation; WCP v0.1 is a draft, not a published standard. See [the design](docs/design.md), [protocol specification](docs/protocol/wcp-v0.md), and [try it yourself](docs/try-it.md).

Plain-language one-pagers: [Protocol](docs/protocol/wcp-explained.md) · [Platform](docs/platform-explained.md) · [Product](docs/product-explained.md).

## Architecture

```mermaid
flowchart LR
  subgraph agents[Agent workspaces]
    H[Claude Code / Codex / OpenCode / Hermes] --> A[Harness adapter + analyzer]
  end
  A -->|check / edit / events| G[Gateway]
  G --> C[Repo coordinator\nDurable Object + SQLite\nordered WCP log]
  C -->|verdicts / diagnostics / inbox| A
  C --> Q[Queues]
  Q --> W[Workflows\nprocess / select / land / revert]
  W --> S[Sandbox containers\nmerge / tests / agent]
  W --> R[Artifacts + evidence]
  G --> D[D1 index]
  HN[Human web / iOS clients] <-->|observe / human actions| G
```

Adapters translate harness hooks into WCP requests; the protocol and coordinator do not depend on any one coding agent. Artifacts hosts repos and candidate forks. A single Durable Object per repo assigns event order and validates edits. Workflows orchestrate revision processing, candidate selection, landing, and revert. Sandboxes perform git and test operations without exposing credentials to the agent container. D1 indexes tasks, changes, revisions, and evidence; R2 stores run artifacts. The live demo and preview environment are described in [the runbook](docs/runbook.md).

## Why Cloudflare

- **Workers** provide the gateway, UI, preview service, and product integrations close to the coordination API.
- **Durable Objects with SQLite** give each repository one authoritative ordered log, state machine, and submit queue.
- **Artifacts** supplies the trunk and isolated candidate forks.
- **Queues and Workflows** make push processing, tests, selection, landing, and recovery durable and retryable.
- **Containers / Sandbox SDK** isolate git, builds, tests, and optional agent runs; credentials are mediated outside the container.
- **D1** indexes cross-repo tasks and evidence; **R2** retains logs, transcripts, and screenshots.
- **Workers AI, AI Gateway, and Browser Rendering** support risk/review assistance, attributable model traffic, and visual evidence. They are supporting services, not required to understand the core WCP event model.

The implementation is evolving; the [design](docs/design.md) distinguishes core, strong, and optional product integrations. No production deployment is implied by this repository.

## Try it

In any git repository, with Node.js 22+:

```sh
npx @celador/weft
```

No login and no account. It runs locally by default: it starts a Weft gateway on your machine
(`127.0.0.1`), so your code and diffs never leave it. It adds Weft's hooks for the coding agents
you have (Claude Code, Codex, Cursor, Copilot CLI, OpenCode, Gemini, Antigravity) to every
checkout, offers a second worktree so two agents can work side by side, and opens your live feed.
Agents with MCP but no hooks (Zed, Warp, JetBrains, Xcode) use `npx @celador/weft mcp` (tools
`weft_check`, `weft_claim`, `weft_status`, `weft_inbox`, `weft_feed`, `weft_history`,
`weft_negotiate`, `weft_gate`; `weft_history` says why earlier changes to a symbol were reverted
or refused). Local is
free for personal use; using it at work needs a [commercial license](docs/commercial-license.md)
or Pro. The source is open (AGPL-3.0; the protocol and plugins are MIT). A hosted team space on Weft's Cloudflare gateway is an option
(`--hosted`; 5,000 agent events a month free, Weft Pro per user for teams); `deploy` puts the gateway in your own Cloudflare
account. The npm package is [`@celador/weft`](https://www.npmjs.com/package/@celador/weft)
(the name `weft` is taken on npm). No repo handy? `npx @celador/weft demo` makes a two-file
sample repo and prints the two prompts that make your agents collide. Details:
[docs/try-it.md](docs/try-it.md) and [docs/hosted.md](docs/hosted.md).

Install it where you already work:

| Where | Install |
|---|---|
| Claude Code (plugin) | `/plugin install weft --marketplace celador/weft`, then `/weft:setup` in your repo |
| GitHub Copilot CLI (plugin) | `copilot plugin marketplace add celador/weft` and `copilot plugin install weft@weft` |
| VS Code, Cursor, Windsurf, Kiro, Antigravity, VSCodium | the `.vsix` from the [VS Code release](https://github.com/celador/weft/releases/tag/vscode-v0.1.1): `code --install-extension weft-0.1.1.vsix` (Marketplace and Open VSX listings to follow) |
| Any MCP client without hooks (Zed, Warp, JetBrains, Xcode, ...) | `{"command": "npx", "args": ["-y", "@celador/weft", "mcp"]}`, started in the checkout |

Status of each listing: [docs/research/distribution-2026-10.md](docs/research/distribution-2026-10.md).

From a clone, without any network service ([docs/try-it.md, Advanced](docs/try-it.md#advanced-from-a-clone)):

```sh
pnpm install --frozen-lockfile
cd apps/gateway && echo "WEFT_ADMIN_TOKEN=$(openssl rand -hex 16)" > .dev.vars.test && pnpm dev:local   # terminal 1
node scripts/local-quickstart.mjs --demo                                                                  # terminal 2, repo root
```

To wire Weft into an agent setup you already run (any harness), read [docs/integrate.md](docs/integrate.md).

## Standardization

Every coding-agent runtime has hooks; none are interoperable. We propose the hook semantics Weft
runs on as a small open standard, separate from Weft itself:

- [One-pager](docs/standardization/one-pager.md) ([PDF](docs/standardization/one-pager.pdf)): problem, proposal, evidence, ask.
- [Agent Hooks Core v0.1](docs/protocol/hooks-core-v0.md): capability levels L0–L3, normalized lifecycle events, the allow/advise/deny decision envelope, diagnostics, failure policy, host mappings. [WCP](docs/protocol/wcp-v0.md) is its coordination extension.
- [Conformance suite](packages/conformance/README.md) (`wcp-hook-conformance`): runs any hook command through the core fixtures and reports the level it verifies. See the [reports for the Weft adapters](docs/standardization/reports/README.md).
- [3-minute video](https://weft-media.elier.ai/weft-demo-short.mp4) for meetings.

Discussions are open: [github.com/celador/weft/discussions](https://github.com/celador/weft/discussions).

## Repository map

- `packages/protocol` — WCP types, schema, validator, reference coordinator, and conformance fixtures.
- `packages/conformance` — standalone hook conformance runner for Agent Hooks Core (`wcp-hook-conformance`).
- `packages/analyzer` — TypeScript diff-to-symbol read/write analysis.
- `packages/adapters` — harness-specific hook translators.
- `apps/gateway`, `apps/workflows`, `apps/sandbox`, `apps/web` — coordination API, durable jobs, isolated execution, and human UI.
- `demo/` — scenarios, drivers, and recorded evidence.
- `scripts/local-quickstart.mjs` — local gateway setup: repo, tokens, adapter installs, `--demo`, `land`.
- `docs/` — design, protocol, runbooks, and [AAIF proposal](docs/proposal-aaif.md).

## License

Weft is licensed in parts; [LICENSE](LICENSE) has the exact list.

- **AGPL-3.0-only:** the product: gateway, sequencer, analyzer, adapters, CLI, MCP server, feed,
  web UI and VS Code extension.
- **MIT:** the protocol specifications and JSON schema ([docs/protocol](docs/protocol),
  [packages/protocol](packages/protocol)), the conformance suite
  ([packages/conformance](packages/conformance)) and the agent plugins
  ([plugins/weft](plugins/weft), [the Hermes plugin](packages/adapters/hermes/plugin/weft)), so
  anyone can implement WCP.
- **The builds we distribute** (`@celador/weft` on npm, the VS Code extension, the hosted service)
  are free for personal use; commercial use needs a
  [commercial license](docs/commercial-license.md) or Weft Pro. Builds you make from source are
  under the AGPL only.
- Everything released up to and including 0.3.0 stays available under the MIT License
  ([licenses/LICENSE-MIT](licenses/LICENSE-MIT)).

Contributions need the [contributor license agreement](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md).
