# @celador/weft

Red squiggles for teams of coding agents.

```sh
npx @celador/weft
```

Run it in any git repository. It needs no login and no account, and it runs locally: your code
and diffs never leave your machine.

1. It starts a **local space**: Weft's gateway (Workers + Durable Objects) running on your machine
   with `wrangler dev`, state in `~/.config/weft/local`. The space's key stays on your machine
   (`~/.config/weft`, and `.weft/` in the repo, which git ignores).
2. It finds the coding agents you have installed (Claude Code, Codex, Copilot CLI, Cursor CLI,
   OpenCode, Gemini CLI, Antigravity) and adds Weft's hooks to every checkout of the repo. If the repo has only one
   checkout, it offers to add a second `git worktree` so two agents can work side by side.
   With none installed, it sets up a file watcher instead.
3. It prints your **live feed** address and a **one-time pairing code**, and opens the address.
   The address has no key in it: the page asks for the code once and pairs that browser as a
   device (a session that expires after a week of not being used and can be revoked).
   Forwarding the address, or a screenshot of it, gives nobody access.

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
| `npx @celador/weft` | set up this repo (space, hooks, feed address + pairing code); safe to run again |
| `npx @celador/weft demo [dir]` | no repo handy: a two-file sample repo (`./weft-demo` + a second checkout), set up, with the two prompts that make the agents collide |
| `npx @celador/weft add [name]` | one more worktree for another parallel agent |
| `npx @celador/weft status` | gateway, space, checkouts, recent events, feed address + a pairing code |
| `npx @celador/weft pair` | a one-time code (10 minutes, single use) to pair another browser or phone with the live feed |
| `npx @celador/weft viewers` | the paired devices: label, when paired, last seen |
| `npx @celador/weft viewers revoke <id>` / `--all` | unpair one device, or all of them (takes effect at once) |
| `npx @celador/weft feed` | the live feed in your terminal |
| `npx @celador/weft open` | open the live feed in your browser (prints a pairing code) |
| `npx @celador/weft watch` | report edits from tools without hooks (file watcher) |
| `npx @celador/weft claim --keys path#sym[,…] [--firm] [--ttl MS]` | claim symbols for this checkout's agent before it changes them (WCP §7.5): others' overlapping edits are warned, or refused with `--firm`; runs the checkout's `.weft/bin/weft claim` |
| `npx @celador/weft mcp` | MCP server for this checkout, for agents with MCP but no hooks (Zed, Warp, JetBrains, Xcode): `{"command":"npx","args":["-y","@celador/weft","mcp","--dir","/path/to/checkout"]}` |
| `npx @celador/weft uninstall [--space]` | remove Weft from this repo; `--space` also erases the space on the gateway: every stored event, diff and key, for good (asks first; `--yes` skips) |
| `npx @celador/weft --hosted` | opt in to a hosted space on Weft's Cloudflare gateway instead (5,000 agent events a month free; Weft Pro, per user, has no event cap) |
| `npx @celador/weft usage` | your hosted space's plan (Free, or Weft Pro and its seats) and agent events this month |
| `npx @celador/weft upgrade [--seats N] [--year]` | Weft Pro for your hosted space, per user, monthly or yearly: prints a Stripe Checkout link (only where the gateway sells one) |
| `npx @celador/weft login` | sign in to your Weft account (free, on weft.mx) for hosted spaces; an existing hosted space joins the account |
| `npx @celador/weft logout` / `whoami` | this machine forgets its hosted key / shows which space and account it uses |
| `npx @celador/weft billing` | change seats, payment method, invoices or cancel (Stripe's customer portal) |
| `npx @celador/weft invite` | (space owner) a one-time invite code (30 minutes, single use) and the one command a teammate on another machine runs to join; `invite cancel` drops open codes |
| `npx @celador/weft --hosted --join SPACE:CODE --repo NAME` | (teammate) join that space from your own clone, with your own member key; `--as NAME` is how the owner sees you (default: git's `user.name`) |
| `npx @celador/weft members` | (space owner) who joined: handle, name and host, joined, last used |
| `npx @celador/weft members revoke <id\|handle>` / `--all` | (space owner) remove a teammate: their key and every agent key and read session it made stop working |
| `npx @celador/weft deploy [--domain HOST]` | run your own gateway in your Cloudflare account |
| `npx @celador/weft use local\|hosted\|URL` | choose the default gateway (local unless you chose otherwise; `--local` is still accepted) |

Options for the setup: `--agents N` (checkouts to coordinate), `--harness claude-code,codex`
(only these), `--yes` (no questions), `--no-open`.

## Teammates on other machines

Every checkout and worktree on one machine shares that machine's space. To add a person on another machine (a hosted
space, or your own gateway; a local gateway is not reachable from other machines):

1. You, in the repo: `npx @celador/weft invite`. It prints a one-time code and the command to send, e.g.
   `npx @celador/weft --hosted --join sp0abc1def2g:K7M2P-9XQ4T --repo shop`.
2. Your teammate runs that command in their clone. They get **their own member key**, never yours, and Weft sets up
   their hooks. Their agents are named `<checkout>.<their handle>` (`shop.alice`), so your agents and theirs are always
   checked against each other, even when both checkouts are called `shop` and both are on `main`.
3. `npx @celador/weft members` lists who joined; `members revoke alice` removes someone at once. A teammate can leave
   with `npx @celador/weft uninstall --space` (for a member that leaves the space; only the owner can erase it).

A member key reads the space and sets up checkouts for its existing repos. It cannot add repos, invite or remove
people, see or unpair devices, change billing, or erase the space. Weft Pro is per user: `invite` and `members` say
when the space has more people than seats.

## Where things go

- `~/.config/weft/cli.json` (mode 600): per gateway, your space id and its keys; under `spaces`, the spaces you joined
  as a teammate (member key and read session), kept apart so joining never replaces your own space.
- `~/.config/weft/runtime/<version>/`: the adapters the hooks run (copied out of npx's cache so
  hooks keep working after it is cleared).
- In each checkout: `.weft/` (agent key, config, logs) and the harness's local hook file, for
  example `.claude/settings.local.json`. Both are added to `.git/info/exclude`, so nothing is
  committed.

## Local, hosted, or your own

- **Local (default):** the gateway runs on your machine with `wrangler dev` (installed once into
  `~/.config/weft/tools`). Nothing leaves the machine.
- **Hosted (`--hosted`, opt-in):** a hosted space on Weft's Cloudflare account; your edits are sent
  there. Each space sees only its own repos. 5,000 agent events a month are free; Weft Pro (per user) has no cap. If you already have a
  hosted space, `npx @celador/weft` keeps using it and tells you how to switch. See
  [docs/hosted.md](https://github.com/celador/weft/blob/main/docs/hosted.md).
- **Your Cloudflare (`deploy`):** logs in with wrangler (browser OAuth) and deploys the gateway
  Worker with two Durable Objects to your account. Only you can create spaces on it.

Requires Node.js 22 or newer and git.

License: this package is free for personal use; using it at work needs a Weft commercial license or
Weft Pro (https://weft.mx/license/). The source code is AGPL-3.0-only (protocol and plugins MIT), and
builds you make from it are under the AGPL only. Versions up to 0.3.0 are MIT. See `LICENSE`.
Source and docs: https://github.com/celador/weft
