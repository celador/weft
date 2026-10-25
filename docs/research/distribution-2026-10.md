# Distribution, October 2026: where developers can install Weft

Card t_1c428bb7, branch `wt/distribution`. Goal: put Weft where developers already look for
tools. Every row below says what is live, how it was tested, and what is still pending.
Verified facts carry the command or URL that proved them. Assumptions are marked as such.

## Listings

| Where | What | State (2026-10-24) | Live URL | Install test |
|---|---|---|---|---|
| Claude Code plugin marketplace (this repo) | `weft` plugin: hooks + `/weft:setup`, `/weft:status` | works from GitHub now (branch ref). `celador/weft` with no ref works once the PM lands `wt/distribution` on main | `https://github.com/celador/weft/tree/wt/distribution/.claude-plugin` (main after landing) | PASS: real Claude Code 2.1.310 sessions, see §1 |
| GitHub Copilot CLI plugin (same marketplace) | the same plugin folder, Copilot hooks | works from GitHub now (branch ref) | same | PASS: real Copilot CLI 1.0.103 sessions, see §2 |
| awesome-copilot (the marketplace Copilot CLI ships with) | external plugin entry for `plugins/weft` @ tag `plugin-v0.1.2` | submitted (issue #5489); their intake passed every gate and labelled it `ready-for-review`; a maintainer approves before it lists | https://github.com/github/awesome-copilot/issues/5489 | their CI: "Install smoke test succeeded" |
| GitHub release (VS Code + every fork) | `weft-0.1.1.vsix` | live | https://github.com/celador/weft/releases/tag/vscode-v0.1.1 | PASS: VS Code 1.143 and Cursor 3.27, clean profiles, see §3 |
| Visual Studio Marketplace | `celador.weft` 0.1.1 | not published: needs a `celador` publisher (Azure DevOps sign-in by John) | (will be) https://marketplace.visualstudio.com/items?itemName=celador.weft | ready: `pnpm --filter @weft/vscode release` |
| Open VSX (Cursor, Windsurf, VSCodium, Kiro, Antigravity) | `celador.weft` 0.1.1 | not published: needs an Eclipse account + Publisher Agreement + token (John) | (will be) https://open-vsx.org/extension/celador/weft | ready: same command |
| Official MCP registry | `io.github.celador/weft` → `npx -y @celador/weft mcp` | not published: the registry requires `"mcpName": "io.github.celador/weft"` in the npm package; `@celador/weft@0.2.0` (published tonight by t_76bd463a) lacks it | (will be) https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.celador/weft | server works: §4. Publish: `node packages/cli/scripts/mcp-registry.mjs` |
| Anthropic plugin directory (claude.ai/directory) | the `weft` plugin bundle | prepared, not submitted: submission is from a paid claude.ai account in the developer portal, and the plugin must be on the tracked branch (main) | https://claude.ai/directory/manage | `claude plugin validate ./plugins/weft`: passed, nothing to report |

## 1. Claude Code plugin

Layout: `.claude-plugin/marketplace.json` (marketplace `weft`, one plugin, source
`./plugins/weft`), `plugins/weft/.claude-plugin/plugin.json` (hooks `./hooks/claude.json`),
`plugins/weft/commands/{setup,status}.md`, `plugins/weft/scripts/weft-hook.mjs` (no
dependencies). The hooks run the adapter that `npx @celador/weft` installs in
`~/.config/weft/runtime/<v>/`. In a repo without `.weft/claude.json` they do nothing. When the
checkout's own `.claude/settings*.json` already runs the adapter, the plugin steps aside so each
hook runs once. `/weft:setup` runs the CLI and then `weft-hook.mjs adopt`, which moves the CLI's
hook entries out of `.claude/settings.local.json` so the plugin (loaded at session start) owns
them: Weft works in the running session with no restart.

Install lines (after landing on main):

```text
/plugin install weft --marketplace celador/weft          # one step, Claude Code >= 2.1.275
/plugin marketplace add celador/weft && /plugin install weft@weft
```

Real test, from GitHub, clean Claude config dir (`CLAUDE_CONFIG_DIR` = a new temp dir), fresh
`git init` repo with `src/pricing.ts`:

1. `claude plugin install weft --marketplace "celador/weft#wt/distribution"` → `Successfully
   installed plugin: weft@weft`, version 0.1.2.
2. `claude -p "/weft:setup"`: 13 s. Output: "Weft is on in this checkout, and its hooks now run
   from the plugin, so you don't need to restart this session", the private feed link, and the
   second worktree `gh3-2`. `weft-hook.mjs where claude-code` → `"hooksFrom": "plugin"`.
3. Agent A (main checkout) changes `calcTotal(items)` to require `opts: { taxRate }`.
4. Agent B (`gh3-2`) is asked to write `cartTotal` calling `calcTotal(items)`. Its hook log:
   `PreToolUse Write deny` (1570 chars of Weft diagnostics) at 46 s after step 2 started, then
   `Stop block` until the session ended. The feed shows
   `#6 gh3-2 edit (check) REJECTED: Blocked: gh3-2 added cartTotal in src/cart.ts — 1 error(s)`.
   An earlier run (`gh`, plugin 0.1.1) ended with the agent offering `weft negotiate propose
   overload …`, waiting for the other change, or editing pricing.ts too.

Found and fixed while testing:

- The commands' `allowed-tools: Bash(npx -y @celador/weft:*)` did not match
  `npx -y @celador/weft@latest …` (the prefix match needs the exact text up to `:*`), so
  `/weft:setup` asked for approval and failed in `-p` mode. Now it names the exact pinned
  command.
- An installed plugin only updates when `version` changes (`claude plugin update` said "already
  at the latest version" after a content change). Bump `version` in all three manifests
  (`.claude-plugin/marketplace.json`, `plugins/weft/.claude-plugin/plugin.json`,
  `plugins/weft/plugin.json`) on every plugin change. `packages/cli/test/plugin-hook.test.ts`
  checks they agree.
- The Anthropic directory blocks unpinned launchers (`npx pkg@latest`), so the commands pin
  `@celador/weft@<packages/cli version>`. The same test fails when the CLI version moves and
  the pin doesn't: bump both together (t_76bd463a's 0.2.0 will trip it when landed; change the
  three `0.1.0` pins in `plugins/weft/commands/*.md` and `plugins/weft/README.md` to `0.2.0`
  and bump the plugin to 0.1.3).
- In a linked git worktree Claude Code also loads the main checkout's
  `.claude/settings.local.json` (verified on 2.1.310), so a worktree whose main checkout still
  has the CLI's hooks already runs Weft; the plugin now detects that and stays out (it used to
  run the hooks a second time). Covered by the test.
- Twice tonight `npx -y @celador/weft@…` failed with `.bin/weft: Permission denied`: an
  existing `~/.npm/_npx/<hash>/node_modules` had been recreated with `dist/weft.mjs` at mode
  644 by something else on this Mac. A clean npm cache and a `node_modules` wipe both give 755,
  so a stranger is unlikely to hit it. The tarball itself has `-rw-r--r--`; t_76bd463a was asked
  to chmod it in the build so +x doesn't depend on npm's bin-link step.

## 2. GitHub Copilot CLI plugin

The same folder is a Copilot CLI plugin: `plugins/weft/plugin.json` (hooks
`./hooks/copilot.json`, `${PLUGIN_ROOT}`), and Copilot CLI reads `.claude-plugin/marketplace.json`
as a marketplace.

```sh
copilot plugin marketplace add celador/weft
copilot plugin install weft@weft
npx @celador/weft --harness copilot      # in the repo
```

Real test (Copilot CLI 1.0.103, John's own Copilot login):
`copilot plugin marketplace add "https://github.com/celador/weft.git#wt/distribution"` →
`weft@weft (v0.1.1)` installed. `npx @celador/weft --harness copilot` in a fresh repo, then
`weft-hook.mjs adopt copilot` in both checkouts ("moved Weft's hooks out of
.github/hooks/weft.json: the plugin runs them now"). Agent A changed `calcTotal`'s signature;
agent B's write of `src/cart.ts` came back `Denied by preToolUse hook: [weft] Edit to
src/cart.ts blocked: it conflicts with another agent's change … stale_assumption
src/cart.ts:4:10: You use src/pricing.ts#calcTotal …` with A's diff quoted, and B then proposed
`weft negotiate propose overload …` on its own.

John's `~/.copilot` now has the `weft` marketplace pointing at the GitHub branch. After landing,
`copilot plugin marketplace remove weft && copilot plugin marketplace add celador/weft` moves it
to main.

awesome-copilot (shipped as Copilot CLI's default marketplace) takes external plugins through
an issue form on github/awesome-copilot (GitHub login only, needs an immutable tag). Submitted as
issue #5489 with tag `plugin-v0.1.2` (commit 2e3a3ea). Their intake CI ran `vally lint` (pass),
an install smoke test with Copilot CLI (pass) and a version match (pass). Its ref/SHA gate first
failed with `git fetch failed … shallow file has changed` (their runner raced two intake runs
because the issue was edited right after it was opened). `/rerun-intake` didn't re-run it;
editing the issue body did, and every gate passed: label `ready-for-review`. Note: an issue
created with `gh issue create` gets no template labels, so the body must start with
`<!-- external-plugin-submission -->` for the intake to pick it up.
Their spec check warns, non-blocking, that `hooks` isn't an Agent Plugins v1.0.0 manifest
field. A maintainer approves before listing.

## 3. VS Code extension (`apps/vscode`, `celador.weft` 0.1.1)

README has the install lines, two real screenshots (`docs/squiggle.png`: the calcTotal squiggle
with its cause; `docs/cause-diff.png`: "Open causing event" in the diff editor), categories
`AI, Linters, SCM Providers, Other`, keywords, `homepage` weft.mx, repository, bugs, icon,
gallery banner. CHANGELOG has 0.1.1. A fresh install needs no settings: the extension reads the
gateway, repo and token from the `.weft/` that `npx @celador/weft` wrote.

Real test: `node apps/vscode/test/install/run.mjs --app vscode|cursor --vsix <file>` installs
the file into a clean `--user-data-dir`/`--extensions-dir`, opens a checkout set up by
`npx @celador/weft`, and checks through the extension's API that it is live. With the `.vsix`
downloaded from the GitHub release (`curl -LO …/vscode-v0.1.1/weft-0.1.1.vsix`, 200, 74602
bytes, sha256 equal to the built file): VS Code `pass: true`, Cursor `pass: true`, both
`"status": "live"` on `https://weft-hosted.elier.ai`, the space's repo found, `canAct: true`,
feed view opened.

Publishing to the two marketplaces is ready (`apps/vscode/scripts/publish.mjs`: publishes the
built `.vsix` with `vsce` and `ovsx`, creates the Open VSX namespace on first publish, then polls
each listing until it serves the version). Tokens come from `VSCE_PAT`/`OVSX_PAT` or the macOS
keychain items `weft-vsce-pat`/`weft-ovsx-pat`, never printed. Neither exists on this Mac, the
1Password CLI has no account signed in, and both need John:

- Visual Studio Marketplace: the publisher must be created by a signed-in Microsoft account
  (https://marketplace.visualstudio.com/manage/createpublisher, ID `celador`), and the token is
  an Azure DevOps PAT with scope Marketplace → Manage.
- Open VSX: sign in with GitHub at https://open-vsx.org, link an Eclipse account and sign the
  Publisher Agreement at https://open-vsx.org/user-settings/profile, then create a token at
  https://open-vsx.org/user-settings/tokens. The agreement is a legal contract in John's name, so
  an agent doesn't sign it.

## 4. MCP registry

`packages/cli/server.json` (validated: `mcp-publisher validate` → "server.json is valid"):
name `io.github.celador/weft`, npm package `@celador/weft`, positional argument `mcp`, stdio,
optional `WEFT_ROOT`. The MCP server ships inside `@celador/weft` (`npx @celador/weft mcp`,
t_76bd463a's design) and fills `--url/--repo/--agent/--task` from the checkout's
`.weft/space.json`, so a registry client needs no settings.

Real test of the server as a registry client starts it (`npx -y @celador/weft@0.2.0 mcp`, cwd =
a checkout `npx @celador/weft` set up, no flags, no env): connected in 4.1 s, tools
`weft_check, weft_claim, weft_status, weft_inbox, weft_feed, weft_negotiate, weft_gate`,
`weft_status` answered for agent `gh3-2`, and `weft_feed` showed the space's log including the
other agent's calcTotal edit and the REJECTED check
(probe: `~/.hermes/cache/scratch/weft-dist/mcp-probe.mjs`). Two small things for the CLI owner:
the server reports `serverInfo.version` 0.1.0 inside 0.2.0, and `weft_status` said "no edits by
other agents in the last 30 minutes" although `weft_feed` showed gh3's edit 3 minutes earlier
(gh3's session had ended).

Login works without John: `mcp-publisher login github --token "$(gh auth token)"` → "Successfully
logged in" (the gh account is `celador`, so `io.github.celador/*` is its personal namespace; the
registry's device flow can't grant org namespaces, a PAT can). Publishing waits for an npm
version whose `package.json` has `"mcpName": "io.github.celador/weft"`: the registry downloads
the tarball and refuses otherwise. Asked t_76bd463a to add it to `packages/cli/package.json` in
the next CLI release. Then: `node packages/cli/scripts/mcp-registry.mjs` (sets server.json's
version from package.json, checks npm, logs in with `gh auth token`, publishes, polls the
registry API).

Other MCP directories, not done: PulseMCP and the GitHub MCP registry ingest the official
registry (assumption, from their docs); Glama indexes public GitHub repos with an MCP server on
its own; Smithery and mcp.so want a form or a hosted server. The official entry comes first.

## 5. Anthropic plugin directory

Checked 2026-10-24 (https://claude.com/docs/directory/publish, /docs/plugins/submit,
/docs/plugins/pre-submission-checklist): anyone on a paid claude.ai plan submits in the
developer portal (https://claude.ai/directory/manage → Submit new → Plugin bundle). The portal
reads the repo from GitHub through the submitter's connected GitHub account, follows a branch
(default: the default branch) and re-scans each new commit. Every listing is reviewed by a person
first, under the Anthropic Software Directory Terms and Policy.

Prepared for it: `plugins/weft/README.md` (over 40 words, says what the plugin runs, sends and
fetches), `license` in plugin.json, pinned `npx` in the commands, every file the hooks run inside
the plugin folder, no `.npmrc`, no binaries except PNGs. `claude plugin validate ./plugins/weft`
→ "These checks found nothing to report … ✔ Validation passed". Expect two reviewer holds, which
are not rejections: "Runs a pinned npx or uvx package" (`/weft:setup` runs `@celador/weft`) and
"Scripts the validator couldn't follow" (the hooks run a `.mjs` file from a plugin in a repo
subfolder).

Form answers: Repository `celador/weft`, plugin path `plugins/weft`, branch `main`. Data
handling: no personal data read or stored; it sends edit diffs, file paths and symbol names to
the Weft gateway the user's checkout is set up with (by default the free hosted space on
weft-hosted.elier.ai, or the user's own gateway); hosted spaces keep the event log for the
space's lifetime; not intended for under-18s. Contact: john@elier.ai.

## What John has to do (each takes a few minutes)

1. Create the Marketplace publisher `celador`: https://marketplace.visualstudio.com/manage/createpublisher
2. Create an Azure DevOps PAT (Organization: All accessible, scope Marketplace → Manage): https://dev.azure.com/ → User settings → Personal access tokens. Store it: `security add-generic-password -U -a celador -s weft-vsce-pat -w`
3. Open VSX: sign in with GitHub at https://open-vsx.org, sign the Publisher Agreement at https://open-vsx.org/user-settings/profile, create a token at https://open-vsx.org/user-settings/tokens. Store it: `security add-generic-password -U -a celador -s weft-ovsx-pat -w`
4. Then (any agent): `cd apps/vscode && pnpm release` publishes both and checks both listings.
5. Anthropic directory, after the PM lands this branch: https://claude.ai/directory/manage → Submit new → Plugin bundle → `celador/weft`, path `plugins/weft`, answers in §5.
