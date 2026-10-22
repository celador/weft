# @weft/adapter-copilot — WCP adapter for GitHub Copilot (CLI, VS Code agent mode, cloud agent)

Connects a checkout to a Weft coordinator (WCP v0.1) through GitHub Copilot's command hooks
(`.github/hooks/*.json`, [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)).
One hooks file serves every Copilot surface that reads it: Copilot CLI, VS Code agent mode (the
Local harness and Copilot sessions on the Agent Host), and the Copilot cloud agent. The hook
command translates Copilot's payloads onto the shared WCP core
(`packages/adapters/claude-code/src`, via `host.ts`), so the diagnostics are the same as the
Claude Code, Codex and Cursor adapters'.

```sh
npm i -g @github/copilot && copilot login      # Copilot CLI (any Copilot plan, Free included)
WEFT_TOKEN=... node dist/weft-copilot.mjs install \
  --url http://localhost:8787 --repo my-repo \
  --agent copilot-b --task T-2 --title "..." [--priority 0] [--mode enforce|advise]
copilot                                        # interactive: answer "trust this folder" once
copilot -p "..." --trust-folder --allow-all-tools   # headless
```

`install` writes `.weft/copilot.json` + `.weft/token` (0600), merges our entries into
`.github/hooks/weft.json` (foreign entries kept; the file is listed in `.git/info/exclude`
because the command holds absolute paths), the git `commit-msg`/`pre-commit` hooks and
`.weft/bin/weft`.

**Folder trust matters.** Copilot CLI loads repository hooks only in a trusted folder. In prompt
mode (`-p`) an untrusted folder runs with no hooks and no warning. Trust it once interactively,
pass `--trust-folder` (new sessions only; it cannot be combined with `--resume`), or set
`COPILOT_ALLOW_ALL=true` (which also counts as trusted). VS Code applies Workspace Trust.

## Hook mapping

| Copilot hook (camelCase file) | core event | output | level |
|---|---|---|---|
| `sessionStart` | SessionStart (`hello`) | `additionalContext` | L1 |
| `userPromptSubmitted` | UserPromptSubmit (drain) | Copilot drops command-hook output: carried to the next injectable hook | |
| `preToolUse` (edit-shaped call) | PreToolUse check | `permissionDecision:"deny"` + `permissionDecisionReason` (the Weft diagnostic) | L2 |
| `preToolUse` `bash` with `git commit` | PreToolUse Bash | deny while errors are open | commit_gate |
| `postToolUse` / `postToolUseFailure` | PostToolUse commit / drain | `additionalContext` (appended to the tool result) | L1 |
| `agentStop` | Stop | `decision:"block"` + `reason` (becomes the next prompt; the core lets go after 5, Copilot after 8) | L3 |
| `sessionEnd` | SessionEnd (`bye`) | — | |

Each entry runs `node …/weft-copilot.mjs hook <event>`: camelCase payloads carry no event name.
Without the argument the event is inferred from the payload's fields.

### Payloads, as observed live (Copilot CLI 1.0.102)

- **Edits arrive as `apply_patch` with the raw Codex patch as a STRING `toolArgs`** (default
  model). `edit` `{path, old_str, new_str}` and `create` `{path, file_text}` also occur. Edits are
  detected by argument shape, not tool name: a patch is parsed (the Codex adapter's parser) into
  one core call per file with the proposed text, so a multi-file patch is checked file by file and
  one conflicting file denies the whole call.
- **No tool call id** in either payload format. The adapter derives one from session + tool +
  arguments (a call's pre and post carry identical arguments).
- PascalCase hook files get the "VS Code compatible" snake_case payload, with Claude tool names
  (`Edit` for `apply_patch`, still with the patch string as `tool_input`).
- VS Code's Local harness maps our camelCase file onto its own PascalCase events and sends
  `hook_event_name`, `tool_use_id` and VS Code tool names (`apply_patch {input}`,
  `replace_string_in_file`, `multi_replace_string_in_file`, `create_file`, `run_in_terminal`,
  `read_file`, `get_errors`). For PascalCase payloads the adapter answers with both the flat
  fields and Claude's `hookSpecificOutput`, which is what the Local harness reads.
- A `preToolUse` command hook that exits non-zero DENIES the call (Copilot fails closed), so the
  hook always exits 0 and fails open with `{}`. Timeouts fail open.

### Claude Code hooks in the same checkout

Copilot CLI also runs `.claude/settings.json` / `.claude/settings.local.json` hooks (verified live:
every event fired twice with both adapters installed). The Claude Code adapter's hook therefore
does nothing under Copilot CLI (`COPILOT_CLI=1`) when `.weft/copilot.json` exists. VS Code's Local
harness reads Claude-format files only with `chat.useClaudeHooks` (off by default).

Declared capabilities: `{level: 3, observe: sync, inject: immediate, deny_edit, refuse_stop, commit_gate: tool_interception}`.

## Verification status

| Surface | Result | Evidence |
|---|---|---|
| Copilot CLI 1.0.102 (Copilot Free, model `gpt-6-luna`) | **L3 live**: stale `apply_patch` denied with the `stale_assumption` squiggle, `agentStop` refused while the error was open, then the adapted edit accepted; the merged result type-checks | [demo/evidence/copilot](../../../demo/evidence/copilot/README.md) `stop-gate/`, `reroute/` |
| VS Code 1.135 agent mode, Local harness (Copilot Chat 0.63) | **L3 live**: reads `.github/hooks/weft.json`. Run 1: the stale edit was "blocked by hook", the model adapted to the diagnostic and the next edit was accepted. Run 2: the edit raced the other agent's change, was REJECTED at commit (injected via `PostToolUse`), and the stop was refused ("Blocked by Stop hook") until the model fixed the call | `vscode/`, `vscode-stop-gate/` |
| Copilot cloud agent | **not verified**: creating a job returns `403 Forbidden` on Copilot Free (the cloud agent needs a paid plan). Probe repo ready | `README.md` § cloud |
| Conformance (`wcp-hook-conformance --dialect copilot`) | L3, honest | [docs/standardization/reports/copilot.md](../../../docs/standardization/reports/copilot.md) |

The cloud agent runs hooks inside its sandbox from `.github/hooks/*.json` on the default branch;
by default its firewall only allows GitHub/Copilot hosts, and hook commands are not exempt (MCP
servers are). Expect L2 there at best once a gateway host is allow-listed and a token is
provided through `copilot-setup-steps`.

Live run: `node demo/copilot-live.mjs [reroute|stop-gate]` against `pnpm dev:local` (see the
script header).
