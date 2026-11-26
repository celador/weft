# @weft/adapter-cursor — WCP adapter for Cursor CLI (`cursor-agent`) hooks (L3, documented)

Connects a Cursor checkout to a Weft coordinator (WCP v0.1) through Cursor's command hooks
(`.cursor/hooks.json`, https://cursor.com/docs/hooks). The hook command translates Cursor's
payloads onto the shared WCP core (`packages/adapters/claude-code/src`, via `host.ts`), so the
diagnostics are identical to the Claude Code and Codex adapters'.

```sh
WEFT_TOKEN=... node dist/weft-cursor.mjs install \
  --url http://localhost:8787 --repo my-repo \
  --agent cursor-d --task T-5 --title "..." [--priority 0] [--mode enforce|advise]
cursor-agent -p --trust --force "..."     # project hooks only run in a trusted workspace
```

`install` writes `.weft/cursor.json` + `.weft/token` (0600), merges our entries into
`.cursor/hooks.json` (foreign hooks kept; excluded from git because the paths are absolute),
the git `commit-msg`/`pre-commit` hooks and `.weft/bin/weft`.

## Delegated work (`install --by-path`)

Cursor subagents (Task tool, foreground or `is_background`) work in the parent's workspace, and `.cursor/agents/*.md` carries no hooks, so the session's `.cursor/hooks.json` is the only hook layer. By default the hook finds the session's checkout from the
session's directory, so an edit inside another joined worktree is reported as the session's agent,
or not coordinated at all. Opt in with `install --by-path`. The hook command then becomes
`weft-cursor.mjs hook --by-path --url U --repo R --mode M`, pinned to the coordinator this checkout
joined. A call whose file lies in another checkout joined with the same url, repo and mode acts as
that checkout's agent, using that checkout's own token. Anything else is handled exactly as
without the flag. The rule is shared with the other adapters (`routeTargets` in
`claude-code/src/config.ts`). The stop gate and session end stay with the session's checkout. An *isolated* subagent's Cursor-created worktree is never joined, so it stays uncoordinated. Cloud agents and cloud subagents are unsupported: the cloud clone has no Weft hook, because this `hooks.json` is machine-specific and git-excluded. Per-harness detail:
[harness-coverage.md §1a](../../../docs/harness-coverage.md#1a-delegated-work-subagents-child-sessions-background-agents-issue-11).

## Hook mapping

| Cursor hook | core event | output | level |
|---|---|---|---|
| `sessionStart` | SessionStart (`hello`) | `additional_context` | L1 |
| `preToolUse` (edit-shaped tool) | PreToolUse check | `permission:"deny"` + `agent_message` (model) + `user_message`; always a valid `permission` (Cursor blocks on invalid output) | L2 |
| `preToolUse` `Shell` with `git commit` | PreToolUse Bash | deny while errors are open | commit_gate |
| `postToolUse` | PostToolUse commit / drain | `additional_context` (+ warnings an allowed pre-check produced) | L1 |
| `afterFileEdit` | PostToolUse, only for edits pre/postToolUse did not account for | (carried to the next injectable hook) | L0 |
| `stop` (`status:"completed"`) | Stop | `followup_message` → Cursor submits it as the next user message; `loop_limit: 5` | L3 |
| `sessionEnd` | SessionEnd (`bye`) | — | |

Cursor documents neither its built-in edit tools' names nor their argument schemas (the
generic payload is `tool_name` + `tool_input`). Edits are therefore detected by argument shape
(`old_string`/`new_string` → Edit, `edits[]` → MultiEdit, `content|contents|file_text` → Write,
any path + write-ish name → accounted after the fact). `afterFileEdit` is the safety net: it
fires for every agent edit, is deduplicated against what `postToolUse` already committed (hash
of the resulting text), and reconstructs the exact before-text by reverse-applying its edit
records.

Declared capabilities: `{level: 3, observe: sync, inject: immediate, deny_edit, refuse_stop, commit_gate: tool_interception}`.

## Verification status — documented, NOT live-verified

The adapter is covered by fixture tests built from the documented payloads (unit translation +
the real bundle against a local coordinator, `test/cursor.test.ts`). A live `cursor-agent` run
was attempted on 2026-10-04 with cursor-agent 2026.04.17 and failed before any hook fired:
the CLI's login had expired (`cursor-agent status` → "Not logged in"; `-p` → "Authentication
required"), and re-login needs a browser OAuth approval by the account owner. Until a live run
confirms that the CLI routes its edit tool through `preToolUse` with a derivable `tool_input`,
treat L2 as documented-only; `afterFileEdit` + the git pre-commit gate are the fallback.

To verify: `cursor-agent login`, then `node demo/b12-harnesses.mjs` with Cursor added as an
agent (or the probe recipe in `docs/research/hooks.md`).
