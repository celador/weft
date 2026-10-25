# Weft plugin for Claude Code and GitHub Copilot CLI

Weft gives a team of coding agents red squiggles for each other's work. When two agents edit one
repo, Weft checks every edit against what the other agents just changed (signatures, renames,
deleted symbols, claimed files) and tells the agent about the conflict before it writes it, with
the other agent's diff quoted. The agent then fixes its edit, waits, or negotiates with the other
agent. A live feed shows every edit, squiggle and negotiation.

![A Weft squiggle on calcTotal: claude-a changed its signature under claude-b](https://raw.githubusercontent.com/celador/weft/main/apps/vscode/docs/squiggle.png)

## Install

Claude Code:

```text
/plugin install weft --marketplace celador/weft
```

(or `/plugin marketplace add celador/weft`, then `/plugin install weft@weft`). Then, in your
repo, run `/weft:setup`. It creates a free hosted space (no account, no sign-up), sets up a second
git worktree for a second agent, and prints the live feed link. Weft works in the running session
without a restart. `/weft:status` shows what is connected.

GitHub Copilot CLI:

```sh
copilot plugin marketplace add celador/weft
copilot plugin install weft@weft
npx @celador/weft --harness copilot      # in your repo
```

## What it runs, sends and fetches

- `/weft:setup` runs `npx -y @celador/weft@0.1.0` (the Weft CLI from npm, pinned) in your repo.
  The CLI creates a hosted space on `weft-hosted.elier.ai` (or uses the gateway you choose with
  `--url`, including one you deploy to your own Cloudflare account with `npx @celador/weft
  deploy`), writes `.weft/` in each checkout (git-excluded), installs the Weft adapter runtime in
  `~/.config/weft/runtime/`, and saves the space's keys in `.weft/` and `~/.config/weft/`.
- The plugin's hooks (`hooks/claude.json`, `hooks/copilot.json`) run
  `scripts/weft-hook.mjs` on session start, prompt submit, before and after each edit tool, and
  on stop. In a repo without `.weft/` they do nothing and send nothing. In a checkout set up by
  the CLI they run that runtime's adapter, which sends the edit (file paths, the diff, the
  symbols it touches) to the checkout's Weft gateway and passes the gateway's squiggles back to
  the agent. Nothing else is sent anywhere.
- `scripts/weft-hook.mjs adopt` (run by `/weft:setup`) removes the CLI's own Weft hook entries
  from `.claude/settings.local.json` (or `.github/hooks/weft.json`) so each hook runs once. It
  leaves every other setting alone.

Uninstall: `npx @celador/weft uninstall` in the repo removes `.weft/` and the hooks it wrote;
`/plugin uninstall weft` removes the plugin.

Source, protocol and docs: <https://github.com/celador/weft> · <https://weft.mx>. License: MIT.
