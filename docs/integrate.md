# Integrating Weft into an existing agent setup

Weft sits beside your harness: an adapter in each agent's checkout turns the harness's tool
hooks into WCP requests to a gateway, and turns the gateway's verdicts back into text the model
sees (or a denied tool call). Your orchestrator, task board and models stay as they are. Run
[try-it.md](try-it.md) first; it ends with two coordinated Claude Code worktrees on your laptop.

## The pieces you wire

| Piece | Who | What it needs |
|---|---|---|
| Gateway | one per team (local: `pnpm dev:local`; hosted: `weft-gateway`) | an admin token |
| Repo | one per repository you coordinate | `POST /v1/admin/repos {"repo": NAME}` |
| Agent token | one per agent | scopes `agent` + `observe`, bound to the repo and the agent id |
| Adapter install | one per agent checkout (clone or `git worktree`) | URL, repo, agent id, task id, the agent token |
| System token | whatever merges code (your merge queue, CI job, or you) | scopes `system` + `observe` |

`node scripts/local-quickstart.mjs <checkout>...` does the middle three rows for Claude Code.
For another harness, mint tokens the same way (`try-it.md` 4d) and run that adapter's `install`.

Rules that matter:

- **One checkout per agent.** The adapter keeps per-session state in `<checkout>/.weft/`, and
  each agent must see only its own edits on disk. Use `git worktree add` for parallel agents.
- **One task per install.** `--task` (and the generated Change-Id) identify the unit of work.
  Re-run `install --task NEW` when the agent starts a different task; the Change-Id follows.
- **Coordination is per repository.** Agents are only checked against agents with the same
  `--repo`. In a monorepo where an agent's checkout is a subdirectory, pass `--prefix sub/dir/` so
  its keys match the repository paths the others use.
- **Priority** (`--priority N`, default 0) decides who yields when two changes collide on the
  same symbol: higher priority, then the change that started first.

## Capability levels

Every adapter declares what its harness lets it do (spec §8.1). Weft relies on nothing more.

| Level | The adapter can | What you get |
|---|---|---|
| L0 observe | report edits after the fact | other agents are checked against this one; its own conflicts reach humans (event log, web UI) only |
| L1 inject | add model-visible text after a tool call | the agent is told about conflicts and other agents' relevant changes |
| L2 block | deny an edit before it runs, with a reason | conflicting edits never land on disk; the model gets a diagnostic instead |
| L3 gate | refuse "I'm done" and intercept `git commit` | an agent cannot finish or commit with open errors |

## Adapters

All live in `packages/adapters/`. `npx @celador/weft` ships them all and installs the right ones per
checkout. From a clone, `install` points the harness
at the bundle in your Weft clone (`pnpm --filter <package> build` first).

| Harness | Package | Level | Status |
|---|---|---|---|
| Claude Code | `@weft/adapter-claude-code` (`dist/weft-claude.mjs`) | L3 | verified with real runs |
| OpenCode | `@weft/adapter-opencode` (generated plugin) | L3 | verified with real runs |
| Hermes Agent | `@weft/adapter-hermes` (Python plugin) | L3 | used on Weft's own build |
| Codex CLI | `@weft/adapter-codex` (`apply_patch` hooks) | L2 | L0 verified, rest documented |
| Cursor CLI | `@weft/adapter-cursor` | L3 (documented) | fixture-tested |
| Gemini CLI | `@weft/adapter-gemini` | L3 (documented) | fixture-tested only |
| GitHub Copilot (CLI, VS Code agent mode, cloud agent) | `@weft/adapter-copilot` (`.github/hooks/weft.json`) | L3 | CLI and VS Code verified with real runs; cloud agent not yet (needs a paid plan) |
| Any MCP harness without hooks (Zed, Warp, JetBrains, Trae, Xcode, Continue, Copilot cloud MCP) | `@weft/mcp` (`packages/mcp`, `dist/weft-mcp.mjs`: MCP server + embedded watcher) | L0 (+ delayed L1 through tool results) | verified with a real hookless run (Claude Code with only the MCP server; `demo/evidence/mcp/`) |
| Google Antigravity (2.0, CLI `agy`, IDE) | `@weft/adapter-antigravity` (`.agents/hooks.json`) | L3, delayed inject | L3 verified live on agy 1.4.5 (`demo/evidence/antigravity/`) |
| Anything else, humans | `@weft/adapter-watcher` (file watcher + git pre-commit) | L0 | verified |

Each package's README has its install command and hook mapping. For a harness that is not
listed: if it has pre/post tool hooks with a deny + reason, copy the Claude Code adapter's
`host.ts` translator pattern (the Cursor, OpenCode, Gemini and Antigravity adapters are 200-300 lines of
translation onto the same core); if it has none but speaks MCP, configure `npx -y @celador/weft mcp` (`@weft/mcp`; its README has
copy-paste configs for Zed, Claude Code, Codex, Cursor, VS Code, JetBrains and Warp); otherwise run
the watcher in its checkout.
Every known harness, its hook surface and Weft's plan for it: [harness-coverage.md](harness-coverage.md).

## Advise vs enforce

`install --mode enforce|advise` (or `WEFT_MODE` at run time):

- **enforce** (Claude Code default): the full level — conflicting edits are denied, `Stop` and
  `git commit` are refused while errors are open.
- **advise**: never blocks. Edits are still checked and logged; a conflicting edit runs, with the
  diagnostic passed to the model as context ("this edit would be blocked: ..."), and the
  stop/commit gates are off. Use it to
  roll Weft out on a team, or on repositories where a false positive would cost more than a late
  warning. The Hermes adapter defaults to advise for every repository except those you list.

## Failure behaviour: fail open

The gateway is never on the critical path for getting work done. Every adapter call has a short
timeout (Claude Code: 5 s); on a transport error, timeout or 5xx the tool call runs, the model is
told the edit was not coordinated, and the adapter logs it (`<checkout>/.weft/log/adapter.log`).
The Hermes adapter adds a circuit breaker, so a dead gateway costs at most one timeout per five
minutes. The L3 stop gate also gives up after five refusals for the same errors, so a confused
agent cannot loop forever; the errors stay visible in the event log. `git commit --no-verify`
bypasses the git hook (an agent's Bash `git commit` is still intercepted by the L3 adapters).

## Land events

Edits are *in flight* until they are merged. A **land** event tells the coordinator that a
change is now on trunk: `{"kind":"land","change":"<Change-Id>","payload":{"sha":"<merged sha>","op_id":"..."}}`,
appended with a `system`-scope token. It

- makes the landed symbols *committed*: other agents whose base predates it get
  `stale_overwrite` if they edit those symbols, until their checkout contains the land sha
  (`git merge-base --is-ancestor`), i.e. until they rebase or merge trunk;
- pushes a `trunk_advanced` notice (`requires_rebase`) to every live change that reads, writes
  or claims what landed;
- releases the landed change's claims.

**Who posts it:** whatever merges. On the hosted stack the landing workflow (rebase, presubmit,
fast-forward trunk) posts it. In your setup that is your merge queue, a CI job on push to the
main branch, or `node scripts/local-quickstart.mjs land --repo R --change C --sha S` by hand. The
Change-Id is the `Change-Id:` trailer the adapters' `commit-msg` hook adds to every commit, so a
post-merge job can read it from `git log`. If you never post lands, edit-time checks between
in-flight changes (`stale_assumption`, contract changes) still work; only `stale_overwrite`
against merged code does not.

## Watching it

- `GET /v1/repos/{repo}/events` (an `observe` token): the ordered log, one record per edit,
  check, land, message; `GET /v1/feed` for all repos a token can see.
- `.weft/bin/weft status | inbox | negotiate ...`, run inside the checkout: the agent's own view, also used by
  the model to negotiate with other agents (see the Claude Code adapter README).
- The web UI (`apps/web`) renders the same log; the public demo is at
  [weft.elier.ai](https://weft.elier.ai).

The full message formats are in [WCP v0.1](protocol/wcp-v0.md).
