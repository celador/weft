# Onboarding cold run, 2026-10 (`npx @celador/weft` as a stranger)

Card t_76bd463a, branch `wt/onboard-cold-run`. Goal: someone who runs `npx @celador/weft`
gets a real Weft squiggle within 5 minutes, in every harness they have. Machine: John's
MacBook Pro, macOS 27, Node 24. Runs on 2026-10-24 (America/Montevideo).

## Summary (plain language)

- **It works.** From an empty directory, `npx @celador/weft demo` (new in 0.2.0) or
  `npx @celador/weft` in a fresh repo, then two agents, gave the second agent a real
  `stale_assumption` squiggle 34–67 s after the `npx` command started. That held for Claude Code,
  Codex (TypeScript, Python, Go), OpenCode and Copilot CLI, all against the public hosted
  gateway. Setup itself takes 3–9 s once npx has the package (about 23 s on a cold npx cache).
  The live feed showed both agents' edits and the refusal (checked in a browser for the demo run).
- **Fixed and published as @celador/weft 0.2.0** (`latest`, verified with
  `npx -y @celador/weft@0.2.0 --help` and `@latest --version` in a fresh dir):
  0.1.0 did not detect Antigravity, had no MCP command, said nothing about the trust prompts
  that silently disable hooks in Codex, Copilot, Cursor and Gemini, crashed on `weft negotiate`
  in checkouts that also had Codex hooks, could not analyze Go or Rust (grammars missing from
  the bundle), had no way to try it without a repo, and refused every Weft command to a
  headless Claude Code agent.
- **Nothing found should hold the launch posts.** One open rough edge: when the other agent
  has already exited, a second agent that negotiates waits up to 4 minutes per attempt for a
  reply that cannot come (B finished 5–9 min after the squiggle instead of ~40 s: Claude Code, OpenCode and Copilot all did this). Squiggle timing is
  unaffected. Follow-up card t_27fa4374.
- **Not tested end to end, for account reasons, not Weft's:** Cursor CLI (not logged in on
  this Mac), Gemini CLI (Google ended the free Code Assist tier for this client:
  `IneligibleTierError`), Antigravity (agy's account quota is used up for ~110 h; Weft's hooks
  were installed and both sessions joined the space at L3).
- **Site:** `site/public/index.html` copy is fixed on the branch (it still said `npx weft` in the
  static HTML and listed five harnesses). It needs a `wrangler deploy` from `site/` after the
  PM lands the branch.

## How the runs were done

Scripts in [onboarding-cold-run/](onboarding-cold-run/): `run-harness.sh <harness>` (same shape as the try-it
calcTotal demo):

1. `git init` a new repo under `/tmp/weft-cold/w/` with `src/pricing.ts` (`calcTotal(items)`)
   and `src/cart.ts`, one commit. Python and Go variants (`LANGX=py|go`) use
   `src/pricing.py` / `calc_total` and `src/pricing.go` / `CalcTotal`.
2. `HOME=/tmp/weft-cold/home npx -y @celador/weft@latest --no-open --yes` (clean HOME: empty
   `~/.config/weft`, no `.weft/` anywhere). The harnesses themselves ran with the real HOME so
   their own logins work, but with no Weft config outside the repo.
3. Agent A in the first checkout: "make calcTotal take a second parameter
   `opts: { taxRate: number }` … only edit src/pricing.ts".
4. Agent B in the second checkout, after A exits: "add `cartTotal(items)` that returns
   `calcTotal(items)` … toFixed(2)".
5. `npx @celador/weft status` (recent events + feed link), both diffs, B's adapter log.

"First squiggle" is the time from the start of the `npx` command to the coordinator's
`reject (stale_assumption)` in B's adapter log. Agents ran headless (`claude -p`,
`codex exec`, `opencode run`, `copilot -p`, `agy -p`, `cursor-agent -p`, `gemini -p`) with the
flags in docs/try-it.md.

`weft demo` runs (`run-demo.sh`) are the same, except step 1–2 is just
`npx @celador/weft demo --yes --no-open` in an empty directory and the prompts are the two the
command prints.

## Per-harness results

| Harness (version) | Installed? | First squiggle | Result | Issue found | Fix |
|---|---|---|---|---|---|
| Claude Code (2.1.310) | yes | 67 s (TS, 0.2.0 pre-release); 65 s and 49 s (`weft demo`, pre-release and npm 0.2.0) | pass | (1) B could not run `.weft/bin/weft inbox/negotiate` headless: "requires approval" for every Weft command. (2) Not logged in on the first attempt (before the Mac's reboot), so nothing ran; logged in afterwards. | (1) `cf5f698`: the adapter adds `Bash(.weft/bin/weft:*)` allow rules; uninstall removes them. Rerun: B ran `weft inbox` and `negotiate` without a prompt. |
| Codex (codex-cli 0.154.0) | yes | 44 s (TS, npm 0.2.0); 46 s (Python, npm 0.2.0); 46 s (Go, 0.2.0 pre-release) | pass | (1) `codex exec` skips untrusted project hooks without a word: first run had zero Weft events. (2) `weft negotiate` crashed: `coordinator unavailable (Cannot read properties of undefined (reading 'replace'))` when Codex and Claude hooks shared a checkout. (3) Go: 0.1.0's runtime has no tree-sitter-go grammar, edits were recorded as `*`, no squiggle. | (1) `51efe36`: "First run" notes under Next + docs table; headless `--dangerously-bypass-hook-trust`. (2) `51efe36`: Codex and the Claude core share `.weft/state`. (3) 0.2.0 bundles Go and Rust grammars (built from current main); Go rerun passes. |
| OpenCode (1.18.31) | yes | 34 s (npm 0.2.0); 0.1.0 also passed (69 s total) | pass | Default model (DeepSeek via OpenRouter) failed: OpenRouter credits exhausted on John's account. Not a Weft issue; reran with `-m opencode/big-pickle`. | none needed |
| GitHub Copilot CLI (1.0.103) | yes | 39 s (npm 0.2.0); 0.1.0 also passed (`preToolUse` deny with the other agent's diff) | pass | 0.1.0 detected it but printed no note that Copilot asks once to trust the folder (hooks don't run until then). | `51efe36` / `4467535`: trust note + docs. |
| Antigravity (agy 1.4.7) | yes | not reached | partial | 0.1.0 did not detect `agy` at all (no hooks installed). 0.2.0: hooks installed, both sessions joined at L3; the model calls failed: "Individual quota reached … resets in 110h". | `51efe36`: detection + `.agents/hooks.json` install. Live collision: earlier L3 evidence in `demo/evidence/antigravity/`. |
| Cursor CLI (2026.04.17) | yes | not run | not tested | `cursor-agent` is not logged in on this Mac ("Authentication required. Please run 'agent login'"). Hooks install fine. | trust note added (`51efe36`); login needs John |
| Gemini CLI (0.62.0) | yes | not run | not tested | (1) Untrusted folders ignore project hooks; `-p` alone overrides YOLO to default. (2) Then `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals`. | (1) `4467535`: trust note (`--skip-trust` headless). (2) Google account/tier; fixture tests only, as before. |
| MCP (hookless harnesses) | n/a | n/a | pass (smoke) | 0.1.0 had no way to start the MCP server from the npm package (`@weft/mcp` is not published). | `51efe36` / `4467535`: `npx -y @celador/weft mcp --dir <checkout>` fills url/repo/agent from the setup. Smoke test against the hosted space: initialize in 1.2 s, 7 tools listed, `weft_status` answers. |
| VS Code extension | n/a | n/a | not in scope | Not installed by npx; separate install (apps/vscode). | none |

No harness was installed for this card.

## Rough edges fixed

| What a stranger hit | Fix | Commit | Test |
|---|---|---|---|
| Antigravity on PATH (`agy`) not detected, no hooks | detection + install of `.agents/hooks.json`, `agy` in Next | `51efe36` | `cli.test.ts` "finds every harness on PATH, Antigravity's agy included", "installs all seven hook adapters" |
| Codex/Copilot/Cursor/Gemini hooks silently off until the folder/hooks are trusted | "First run:" notes printed for the harnesses found; table in docs/try-it.md | `51efe36`, `4467535` | `cli.test.ts` "says what each asks on first run" |
| `weft negotiate` crash with Codex + Claude hooks in one checkout | shared `.weft/state` between Codex and the Claude core | `51efe36` | `codex/src/shared-state.test.ts`, `claude-code/test/shared-state.test.ts` |
| No MCP path from the published package; docs pointed at unpublished `@weft/mcp` | `weft mcp` (forwards server flags, fills them from `.weft/space.json`); MCP README uses `@celador/weft mcp` | `51efe36`, `4467535` | `cli.test.ts` mcpArgs + live smoke |
| Go/Rust repos: no symbol analysis in 0.1.0 | 0.2.0 bundles current grammars | 0.2.0 publish | Go collision rerun (pass) |
| No repo with a function to collide on; try-it prompts assume `src/pricing.ts` | `weft demo [dir]`: two-file repo, one commit (works with no git identity), second checkout, prints the two prompts | `cf5f698` | `cli.test.ts` "demo makes a two-file sample repo without a git identity…" + two live runs |
| Headless Claude Code refused every `.weft/bin/weft` command | `permissions.allow` rules for the agent's Weft command; pruned on uninstall | `cf5f698` | `claude-code/test/adapter.test.ts` mergeSettings allow; `cli.test.ts` pruneHooks + install check |
| Site/README/docs: `npx weft` in the static HTML, five harnesses listed | copy lists all hook harnesses + MCP; `npx @celador/weft` | `4467535` | n/a (copy) |

## Still open (none block the launch)

1. Negotiating with an agent whose session has ended waits the full `--wait` (240 s) per try.
   Card t_27fa4374: fixed on wt/t_27fa4374. The verdict now carries a `counterpart_away`
   warning ("… is not in a session (left at #N) …") and `--wait` / `weft_negotiate` return at once.
2. Cursor, Gemini and Antigravity collisions were not run end to end today (logins/quota on
   this Mac). Their adapters are installed by npx and covered by fixture tests; Antigravity has
   an earlier live L3 run.
3. Site copy fix needs a deploy after landing (`cd site && wrangler deploy`).
4. `npx` itself prints npm's "New major version of npm available" notice after Weft's output on
   npm 11; harmless, outside Weft's control.

## Verification

- Gate on `cf5f698`: `pnpm -r --no-bail typecheck && pnpm -r --no-bail test` → `GATE_EXIT 0`
  (25 packages, all passed). The watcher and MCP fs.watch tests that failed in the first attempt
  were the Mac's stuck `fseventsd` (a bare `fs.watch` probe saw 0 events); after the reboot the
  same probe sees events and both tests pass.
- npm: `npm view @celador/weft dist-tags` → `{ latest: '0.2.0' }`;
  `npx -y @celador/weft@0.2.0 --help` in a fresh `git init` dir prints the 0.2.0 help with `demo`.
- Registry runs (npm 0.2.0, clean HOME): see the table rows marked "npm 0.2.0".
