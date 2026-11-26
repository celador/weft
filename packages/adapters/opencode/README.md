# @weft/adapter-opencode — WCP adapter for OpenCode (L3)

Connects an [OpenCode](https://opencode.ai) checkout to a Weft coordinator (WCP v0.1). OpenCode
has no command hooks; it loads JS plugins into its own process. `install` writes a small
generated plugin (`.opencode/plugin/weft.js`) that forwards OpenCode's plugin hooks to this
package's Node bundle, which runs the same WCP core as the Claude Code adapter
(`packages/adapters/claude-code/src`, via `host.ts`). Diagnostics are therefore byte-identical
to Claude Code's and Codex's.

```sh
WEFT_TOKEN=... node dist/weft-opencode.mjs install \
  --url http://localhost:8787 --repo my-repo \
  --agent opencode-c --task T-3 --title "Session refresh" [--priority 0] [--mode enforce|advise]
```

| file | content |
|---|---|
| `.weft/opencode.json`, `.weft/token` (0600) | coordinator, repo, agent, task, `change` (Change-Id); the token never enters config, logs or git |
| `.opencode/plugin/weft.js` | generated bridge (absolute node + bundle paths; excluded from git) |
| git `commit-msg` / `pre-commit` | Change-Id/Task-Id/Agent-Id trailers; refuse commits while the session has open errors |
| `.weft/bin/weft` | the agent's `negotiate` / `inbox` command |

## Delegated work (`install --by-path`)

OpenCode subagents run in child sessions of the same OpenCode instance. The plugin is instance-wide and gets the instance `directory`, so its hooks see child sessions' tool calls under each child's `sessionID` (OpenCode's plugin model; not yet run live with a child session). By default the hook finds the session's checkout from the
session's directory, so an edit inside another joined worktree is reported as the session's agent,
or not coordinated at all. Opt in with `install --by-path`. The hook command then becomes
`weft-opencode.mjs hook --by-path --url U --repo R --mode M`, pinned to the coordinator this checkout
joined. A call whose file lies in another checkout joined with the same url, repo and mode acts as
that checkout's agent, using that checkout's own token. Anything else is handled exactly as
without the flag. The rule is shared with the other adapters (`routeTargets` in
`claude-code/src/config.ts`). With `--by-path` the generated plugin passes these flags to every `hook` call, and each file of an `apply_patch` is routed and stashed on its own. The stop gate (`session.idle`) and session end stay with the session's checkout. Per-harness detail:
[harness-coverage.md §1a](../../../docs/harness-coverage.md#1a-delegated-work-subagents-child-sessions-background-agents-issue-11).

## Hook mapping

| OpenCode plugin hook | core event | WCP | level |
|---|---|---|---|
| `experimental.chat.system.transform` | SessionStart | `hello`; welcome + inbox pushed into the system prompt (full text on the first request, the one-line notice after) | L1 |
| `tool.execute.before` edit / write / multiedit | PreToolUse | analyze the proposed text, `submit check`; reject → **`throw new Error(reason)`**: OpenCode fails the tool call and the model reads the reason | L2 |
| `tool.execute.before` bash `git commit …` | PreToolUse Bash | `gate commit` → throw while errors are open | commit_gate |
| `tool.execute.after` | PostToolUse | `submit commit` with the real diff; verdict + inbox **appended to the tool output** | L1 |
| `event` `session.idle` | Stop | `gate stop` → `client.session.prompt(reason)` starts another turn (max 5 refusals for the same errors) | L3 |
| `event` `session.deleted` | SessionEnd | `bye` (kept open while errors are open) | |

Tool arguments map 1:1 (`filePath`→`file_path`, `oldString`/`newString`/`replaceAll`, `content`,
`edits[]`, `command`). `apply_patch`/`patch` (`patchText`, used by GPT-family models) is
**not checked before it runs**: it is accounted after the fact (one `commit` per file, diffed
against the before-text stashed at `tool.execute.before`). OpenCode's `edit` also applies
fuzzy (whitespace-tolerant) matches; when `oldString` does not match exactly, the proposed text
cannot be derived and the edit is only accounted after the fact.

Declared capabilities: `{level: 3, observe: sync, inject: immediate, deny_edit, refuse_stop, commit_gate: tool_interception}`.

## Verification status (OpenCode 1.18.31, model `opencode/big-pickle`)

Verified live against the preview gateway (`demo/b12-harnesses.mjs`, evidence `demo/evidence/b12/`):

- **L2**: a stale `write` of `src/auth/refresh.ts` was denied (`stale_assumption` caused by
  claude-a's signature change); the model read the reason, rewrote the call with the new
  signature, and the next write was accepted.
- **L1**: the welcome reached the model through the system prompt (it used `.weft/bin/weft inbox`
  unprompted); verdict text appended to tool output is what the model sees.
- **L3**: with the model told to give up, `session.idle` refusals arrived as new user turns,
  5 times, then the runaway guard let it stop (the open errors stay in the feed).

**Headless caveat:** a one-shot `opencode run` exits on `session.idle`, before the continuation
prompt runs, so the stop gate is only effective when the plugin lives in a long-lived process:
the TUI, or `opencode serve` with turns sent by `opencode run --attach <url>` (what the demo
does). In one-shot `run` the adapter still denies edits (L2) and injects context (L1); the
git pre-commit gate still holds.

Also: OpenCode resolves its project from `$PWD`, not the process cwd. Drivers must set `PWD`
(or pass `--dir`) or OpenCode works in the parent shell's directory.

## Development

```sh
pnpm --filter @weft/adapter-opencode test   # builds dist/weft-opencode.mjs; loads the generated plugin in Node against a local coordinator
```
