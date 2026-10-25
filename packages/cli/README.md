# @celador/weft

Red squiggles for teams of coding agents.

```sh
npx @celador/weft
```

Run it in any git repository. It needs no login and no account:

1. It creates a **free hosted space** for you on Weft's Cloudflare gateway (Workers + Durable
   Objects). The space's key stays on your machine (`~/.config/weft`, and `.weft/` in the repo,
   which git ignores).
2. It finds the coding agents you have installed (Claude Code, Codex, Copilot CLI, Cursor CLI,
   OpenCode, Gemini CLI, Antigravity) and adds Weft's hooks to every checkout of the repo. If the repo has only one
   checkout, it offers to add a second `git worktree` so two agents can work side by side.
   With none installed, it sets up a file watcher instead.
3. It prints your **live feed** link and opens it. The feed is private: the link carries a
   read-only key after the `#`.

Then start one agent per checkout. Codex, Cursor, Copilot and Gemini ask once whether to trust
the folder or its hooks: say yes, or the hooks do not run (the setup prints this for the agents
it found). When one agent changes code another agent depends on, the
second agent gets a diagnostic (a red squiggle, with the other agent's diff) before it writes a
conflicting edit, instead of a merge conflict later.

The npm name is `@celador/weft` because `weft` is taken on npm.

Website: <https://weft.mx> · Source: <https://github.com/celador/weft>

## Commands

| Command | What it does |
|---|---|
| `npx @celador/weft` | set up this repo (space, hooks, feed link); safe to run again |
| `npx @celador/weft add [name]` | one more worktree for another parallel agent |
| `npx @celador/weft status` | gateway, space, checkouts, recent events, feed link |
| `npx @celador/weft feed` | the live feed in your terminal |
| `npx @celador/weft open` | open the live feed in your browser |
| `npx @celador/weft watch` | report edits from tools without hooks (file watcher) |
| `npx @celador/weft mcp` | MCP server for this checkout, for agents with MCP but no hooks (Zed, Warp, JetBrains, Xcode): `{"command":"npx","args":["-y","@celador/weft","mcp","--dir","/path/to/checkout"]}` |
| `npx @celador/weft uninstall [--space]` | remove Weft from this repo; `--space` also deletes the space |
| `npx @celador/weft --local` | run the gateway on this machine (offline; nothing hosted) |
| `npx @celador/weft deploy [--domain HOST]` | run your own gateway in your Cloudflare account |
| `npx @celador/weft use hosted\|local\|URL` | choose the default gateway |

Options for the setup: `--agents N` (checkouts to coordinate), `--harness claude-code,codex`
(only these), `--yes` (no questions), `--no-open`.

## Where things go

- `~/.config/weft/cli.json` (mode 600): per gateway, your space id and its keys.
- `~/.config/weft/runtime/<version>/`: the adapters the hooks run (copied out of npx's cache so
  hooks keep working after it is cleared).
- In each checkout: `.weft/` (agent key, config, logs) and the harness's local hook file, for
  example `.claude/settings.local.json`. Both are added to `.git/info/exclude`, so nothing is
  committed.

## Hosted, local, or your own

- **Hosted (default):** free, on Weft's Cloudflare account. Each space sees only its own repos.
  Limits per space: 20 repos, 200 keys, 600 requests a minute. See
  [docs/hosted.md](https://github.com/celador/weft/blob/main/docs/hosted.md).
- **Local (`--local`):** the same gateway runs on your machine with `wrangler dev` (installed
  once into `~/.config/weft/tools`). Nothing leaves the machine.
- **Your Cloudflare (`deploy`):** logs in with wrangler (browser OAuth) and deploys the gateway
  Worker with two Durable Objects to your account. Only you can create spaces on it.

Requires Node.js 22 or newer and git. MIT licensed.
Source and docs: https://github.com/celador/weft
