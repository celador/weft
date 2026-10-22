# @weft/mcp — Weft for any harness that speaks MCP

For coding agents that have MCP but no hooks: Zed's agent panel, Warp, Trae, Xcode, JetBrains
Junie and AI Assistant, the Continue extension, the Copilot cloud agent. One stdio MCP server
per checkout. It does two things:

- **Reports every edit, whatever the model does.** It embeds the Weft file watcher
  (`@weft/adapter-watcher`): each file that changes in the checkout is submitted to Weft as a
  `commit` edit, so the other agents' edits are checked against this one (L0, guaranteed).
- **Gives the model Weft tools.** The server instructions tell the model to call `weft_check`
  before it edits shared code and `weft_gate` before it says it is done. Every tool result ends
  with whatever is waiting for this agent (squiggles, proposals, messages): that is how
  diagnostics reach a hookless model (delayed L1, when the model calls a tool).

| Tool | What it does |
| --- | --- |
| `weft_check {path, new_content \| patch}` | WCP `submit mode:"check"`: accept/reject plus the rendered squiggles, with the other agent's diff quoted. Writes nothing. `patch` is a unified diff against the current file. |
| `weft_claim {keys[], firm?, ttl_ms?}` | Claim `path#symbol` keys (WCP §7.5). |
| `weft_status` | Open errors, negotiations owed, and what the other agents are editing (last 30 min). |
| `weft_inbox` | Drain and acknowledge the inbox; open errors and what is owed. |
| `weft_feed {repo?, limit?}` | The newest log records, one line each. |
| `weft_negotiate {action, …}` | `propose` / `accept` / `reject` / `counter` / `escalate` (WCP §7.4, §7.6). |
| `weft_gate {gate: "stop" \| "commit"}` | May I finish / commit? Lists what still holds you. |

Declared capabilities (Hooks Core §3.3 — only what is guaranteed):
`{level: 0, observe: "async", inject: "delayed", deny_edit: false, refuse_stop: false, commit_gate: "native"}`.
An MCP server cannot stop the harness's own edit tool or its stop, so it never claims to; git's
own `pre-commit` hook (installed in the checkout) refuses commits while this agent has open
errors (`--no-verify` bypasses it).

## Configure

Every harness below starts the server the same way:

```sh
npx -y @weft/mcp --dir /path/to/checkout --url https://weft.example --repo myrepo --agent zed-a --task T-12 --title "Session expiry"
```

- **Checkout**: `--dir`, else `WEFT_ROOT`, else the server's working directory, else the first
  git root the client reports through MCP roots.
- **Settings**: flags, else `WEFT_URL`, `WEFT_REPO`, `WEFT_AGENT`, `WEFT_TASK`, `WEFT_TITLE`,
  `WEFT_PRIORITY`, `WEFT_PREFIX`, else the checkout's `.weft/mcp.json`. On first start (or when a
  flag changes) the server writes `.weft/mcp.json`, the git `commit-msg`/`pre-commit` hooks and
  `.weft/bin/weft`, exactly like `weft-mcp install` and every other adapter. `.weft/` is
  git-excluded. The change id stays the same across restarts for the same task.
- **Token** (an agent token bound to `--agent`, scopes `agent` + `observe`): `WEFT_TOKEN`, else
  the checkout's `.weft/token`, else `~/.config/weft/<repo>.token`, else `~/.config/weft/token`
  (the files `npx weft` writes). Never put the token itself in a committed config file.
- `--channels` (or `WEFT_MCP_CHANNELS=1`): Claude Code only, research preview. Background
  diagnostics are pushed into the session as `<channel source="weft">` events instead of waiting
  for the next tool call. Needs `claude --dangerously-load-development-channels server:weft`.

Once installed in a checkout, `npx -y @weft/mcp` with no flags is enough (the config is read
from `.weft/mcp.json`).

### Zed (`settings.json`, `context_servers`)

```json
{
  "context_servers": {
    "weft": {
      "command": "npx",
      "args": ["-y", "@weft/mcp", "--dir", "/path/to/checkout", "--url", "https://weft.example", "--repo", "myrepo", "--agent", "zed-a", "--task", "T-12"],
      "env": {}
    }
  }
}
```

Zed's agent sees the server in the agent panel's tool list; enable the `weft` tools in your
profile.

### Claude Code (`.mcp.json` in the checkout)

```json
{
  "mcpServers": {
    "weft": { "command": "npx", "args": ["-y", "@weft/mcp", "--agent", "claude-mcp", "--repo", "myrepo", "--url", "https://weft.example", "--task", "T-12"] }
  }
}
```

Claude Code has hooks: prefer `@weft/adapter-claude-code` (L3). Use the MCP server there only as
an extra, or where hooks are disabled by policy.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.weft]
command = "npx"
args = ["-y", "@weft/mcp", "--dir", "/path/to/checkout", "--url", "https://weft.example", "--repo", "myrepo", "--agent", "codex-mcp", "--task", "T-12"]
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "weft": { "command": "npx", "args": ["-y", "@weft/mcp", "--url", "https://weft.example", "--repo", "myrepo", "--agent", "cursor-mcp", "--task", "T-12"] }
  }
}
```

### VS Code / Copilot agent mode (`.vscode/mcp.json`)

```json
{
  "servers": {
    "weft": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@weft/mcp", "--dir", "${workspaceFolder}", "--url", "https://weft.example", "--repo", "myrepo", "--agent", "copilot-mcp", "--task", "T-12"]
    }
  }
}
```

### JetBrains (Junie / AI Assistant: Settings → Tools → AI Assistant → Model Context Protocol → Add → "As JSON")

```json
{
  "mcpServers": {
    "weft": { "command": "npx", "args": ["-y", "@weft/mcp", "--dir", "/path/to/checkout", "--url", "https://weft.example", "--repo", "myrepo", "--agent", "junie-a", "--task", "T-12"] }
  }
}
```

### Warp (`.warp/.mcp.json` in the checkout, or Settings → Agents → MCP servers → + Add)

```json
{
  "mcpServers": {
    "weft": {
      "command": "npx",
      "args": ["-y", "@weft/mcp", "--url", "https://weft.example", "--repo", "myrepo", "--agent", "warp-a", "--task", "T-12"],
      "working_directory": "/path/to/checkout"
    }
  }
}
```

## Other commands

```sh
weft-mcp install --url U --repo R --agent A --task T [--title …]   # configure a checkout ahead of time
weft-mcp status | inbox | negotiate … | pre-commit | commit-msg FILE
```

## What it cannot do

- It cannot block an edit before it is written: the harness's own edit tool runs regardless. The
  watcher reports the edit afterwards; a conflicting edit becomes an open error that the model
  sees on its next `weft_*` call, and that `weft_gate` and the git pre-commit hook enforce.
- The model may never call a tool. Then nothing reaches it, and Weft knows only what the watcher
  reports. That is why the declared level is 0.
- Diagnostics produced in the background (the watcher's verdicts) count as delivered when they
  are produced, not when the model reads them; they are shown on the next tool call.

## Verified

`demo/mcp-hookless.mjs` runs Claude Code with no Weft hooks and only this server configured,
next to a hooked Claude Code agent, against a local gateway (`pnpm dev:local`). Evidence:
`demo/evidence/mcp/`.
