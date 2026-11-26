# @weft/adapter-gemini — WCP adapter for Gemini CLI hooks (FIXTURE-TESTED ONLY)

> No live Gemini CLI run backs this adapter. Gemini CLI's free OAuth tier was retired
> (UNSUPPORTED_CLIENT; unpaid users moved to Antigravity CLI on 2026-06-18) and no Gemini API
> key is available to the project. The mapping follows the documented reference
> (https://geminicli.com/docs/hooks/reference) and is exercised with fixture payloads only.

The hook command translates Gemini CLI payloads onto the shared WCP core
(`packages/adapters/claude-code/src`, via `host.ts`).

```sh
WEFT_TOKEN=... node dist/weft-gemini.mjs install --url … --repo … --agent gemini-e --task T-6
```

`install` merges our matcher groups into `.gemini/settings.json` (hook `name: "weft-gemini"`;
foreign groups kept; excluded from git), plus `.weft/gemini.json`, the token, git hooks and
`.weft/bin/weft`.

## Delegated work (`install --by-path`)

A Gemini subagent is a tool call in the main session (same process, same cwd), and agent definitions (`.gemini/agents/*.md`) carry no hooks. By default the hook finds the session's checkout from the
session's directory, so an edit inside another joined worktree is reported as the session's agent,
or not coordinated at all. Opt in with `install --by-path`. The hook command then becomes
`weft-gemini.mjs hook --by-path --url U --repo R --mode M`, pinned to the coordinator this checkout
joined. A call whose file lies in another checkout joined with the same url, repo and mode acts as
that checkout's agent, using that checkout's own token. Anything else is handled exactly as
without the flag. The rule is shared with the other adapters (`routeTargets` in
`claude-code/src/config.ts`). Gemini delegated work is **unsupported**: there is no scoped-hook mechanism, and the docs do not say whether `BeforeTool`/`AfterTool` run for a subagent's own tool calls. If they do, `--by-path` routes those edits too (fixture-tested only). Per-harness detail:
[harness-coverage.md §1a](../../../docs/harness-coverage.md#1a-delegated-work-subagents-child-sessions-background-agents-issue-11).

| Gemini event | core event | output (documented) | level |
|---|---|---|---|
| `SessionStart` | SessionStart | `hookSpecificOutput.additionalContext` (prepended to the prompt headless) | L1 |
| `BeforeAgent` | UserPromptSubmit | `hookSpecificOutput.additionalContext` | L1 |
| `BeforeTool` `write_file` / `replace` | PreToolUse check | `decision:"deny"` + `reason` (sent to the agent as the tool error) | L2 |
| `BeforeTool` `run_shell_command` `git commit` | PreToolUse Bash | deny while errors are open | commit_gate |
| `AfterTool` | PostToolUse | `hookSpecificOutput.additionalContext` (appended to the tool result) | L1 |
| `AfterAgent` | Stop | `decision:"deny"` + `reason` → retry turn with the reason as prompt | L3 |
| `SessionEnd` | SessionEnd | best effort (the CLI does not wait) | |

`replace` with `expected_replacements > 1` maps to a replace-all edit. Gemini tool calls carry no
call id, so Before/After are paired by a key derived from the tool input. Hooks print nothing
but the JSON answer ("silence is mandatory").

Declared capabilities (documented): `{level: 3, observe: sync, inject: immediate, deny_edit, refuse_stop, commit_gate: tool_interception}`.
