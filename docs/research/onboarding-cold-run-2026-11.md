# Onboarding cold run, 2026-11 (published 0.3.0, weft.mx → first caught conflict → hosted → Checkout)

Card t_673b52cf, branch `wt/cold-run-2`. Previous run: [onboarding-cold-run-2026-10.md](onboarding-cold-run-2026-10.md).
Machine: John's MacBook Pro, macOS 27, Node 24.21, npm 11.19, load average 15–23 during the runs.
Harnesses: Claude Code 2.1.325 (`--model sonnet`), codex-cli 0.167.0 (ChatGPT login). Runs on 2026-11-17
(America/Montevideo), published `@celador/weft@0.3.0` (`latest`).

## Summary

- **Can a stranger reach the first caught conflict in under 5 minutes? Sometimes.** Python
  (un33k/python-slugify, Codex then Claude Code): **68 s** from the first command to Claude Code's edit
  being denied with `stale_assumption` and the other agent's diff. TypeScript (vercel/ms, Claude Code then
  Codex): **not within 5 minutes with 0.3.0.** The first two natural attempts produced no diagnostic at all,
  for two separate reasons (below). A third attempt on a different function got one, 10 min in.
- **Why the TypeScript run missed (fixed on this branch).** The TypeScript analyzer dropped every
  signature change of a function whose body contains a destructuring declaration
  (`const { value, unit } = match.groups`): the unnamed declaration took the function's own key and
  overwrote it. vercel/ms `parse` is such a function. Destructuring is common in real TypeScript, so most
  strangers on a real TS repo would hit this. A class with a computed member (`[Symbol.iterator]()`) lost
  its member changes the same way.
- **Why the second TypeScript attempt missed (follow-up card).** Codex 0.167 wrote a new file with a shell
  heredoc (`cat > src/duration.ts <<'EOF'`), not `apply_patch`. The Codex adapter only sees `apply_patch`, so
  the file never reached Weft: no check, no feed event. The Claude Code adapter already reports files a Bash
  command changed; the Codex adapter does not.
- **Setup is fast and clean:** 19–21 s on a cold HOME and npm cache (about 10–13 s of it is installing
  wrangler once), 3 human inputs. Live feed paired in a headless browser in about 5 s. Hosted space 4.2 s,
  `usage` 1.1 s, `upgrade` 2.0 s to a live Stripe Checkout page (opened, not paid). The space was erased and
  confirmed `erased` on the gateway.
- **"0 first runs" is a measurement gap, not 0 users.** Since 0.3.0 (published 2026-11-02 00:27 UTC) local is
  the default, and a local first run sends nothing to any Weft server. The funnel's "first runs" counts new
  *hosted* spaces only. Local users are invisible. Proposal below; not shipped (needs John's OK).
- **Spend:** Claude Code runs $0.47 at API prices (3 runs: $0.161, $0.130, $0.174). Codex ran on the ChatGPT
  subscription (4 runs, about 568k input tokens, 83% cached; no per-call charge). One Stripe Checkout session
  opened and not paid. Total well under the $10 cap.

## How the runs were done

A stranger following weft.mx: the hero copy block is `npx @celador/weft` ("Run in your repo"), and "See the
quickstart" links to docs/try-it.md. So the steps were: clone a real repo, run `npx @celador/weft` in it,
answer its prompts, start one agent per checkout, ask agent A to change a function's signature and agent B
(in the second checkout) to use that function the old way. That is the try-it.md recipe.

- Clean environment per repo: `HOME` and the npm cache in a scratch dir (`home/`, `home-py/`), an `open` shim
  on PATH that logs URLs instead of opening John's browser, and a minimal `~/.gitconfig` (name/email). The
  CLI ran in a real pty (`ptyrun.py`), so its prompts appeared as they would for a person and were answered
  with the default.
- The harnesses ran with the real HOME for their own logins and `WEFT_HOME` pointing at the scratch Weft
  config, so nothing read `~/.config/weft` or the Hermes adapter config. Headless: `claude -p …
  --permission-mode acceptEdits --model sonnet`, `codex exec --dangerously-bypass-hook-trust -s
  workspace-write` (the forms docs/try-it.md gives). A and B ran one after the other, as in try-it.md.
- Browser checks (feed pairing, Checkout) used a headless Chromium (Playwright). Nothing took focus.
- Repos: vercel/ms (`4ff48ce`, TypeScript, `src/index.ts`) and un33k/python-slugify (`4b6b5b4`, Python,
  `slugify/slugify.py`), shallow clones.

## Timeline

### Python (python-slugify), one uninterrupted pass, cold HOME and npm cache

| t (s) | Step | Human steps so far |
|---:|---|---:|
| 0.0 | `npx @celador/weft` | 1 |
| 1.2 | npm: `Need to install the following packages: @celador/weft@0.3.0 Ok to proceed? (y)` → y | 2 |
| 3.9 | `· installing wrangler (Cloudflare's CLI) into …/.config/weft/tools (once)` (`added 35 packages in 10s`) | |
| 17.3 | `✓ local gateway running` · `✓ created your local space sptxwilga8r5 (127.0.0.1:7880; your edits stay on this machine)` | |
| 17.7 | `? Add a second worktree (…/python-slugify-2) so two agents can work side by side? (Y/n)` → Enter | 3 |
| **19.1** | **(a) setup finished**: hooks in both checkouts, feed address, pairing code, "Next" and "First run" notes | 3 |
| 27.4 | agent A (Codex) joins: `hello python-slugify … -> s1 head #1 base #1` | 4 |
| 36.2 | A's `apply_patch` to `_decode_entities` accepted (#2, signature change) | |
| **60.9** | **(b) both agents have run under Weft**: B (Claude Code) joins, `head #5 base #5` | 5 |
| **67.8** | **(c) first diagnostic shown to an agent**: B's Edit denied, `reject #6 (stale_assumption,stale_read)` | 5 |
| 76 | B retreats, proposes `sequence` to A, gets `counterpart_away` (A has exited) and stops | |

What B (Claude Code) was shown, verbatim (tool result of its Edit):

```
PreToolUse:Edit hook error: [weft] Edit to slugify/slugify.py blocked: it conflicts with another agent's change (Weft edit-time coordination, log #6).
[weft error] stale_assumption slugify/slugify.py:58:12: You use slugify/slugify.py#_decode_entities, whose signature changed in #2 by python-slugify and is not in your checkout: that change has not landed and was never delivered to you. (caused by python-slugify · task T-master · event #2). Suggestion: Read the new slugify/slugify.py#_decode_entities (event #2) and update this call site, or negotiate with python-slugify.
  ↳ event #2 by python-slugify changed slugify/slugify.py (their change is not in your checkout yet):
    -def _decode_entities(text: str, entities: bool, decimal: bool, hexadecimal: bool) -> str:
    -    if entities:
    +def _decode_entities(text: str, opts: dict[str, bool]) -> str:
    +    if opts['entities']:
    …
[weft warning] stale_read slugify/slugify.py:167:5: slugify/slugify.py#_modern_slugify body changed in #2 by python-slugify and is not in your checkout: …
  ↳ Your options: retreat (rework without that code) | wait (until python-slugify lands or releases it) | negotiate: `…/.weft/bin/weft negotiate propose overload "<what python-slugify should keep working for you>" --wait 240` …
```

B's final answer: "I haven't added `decode_html`, and `slugify/slugify.py` is unchanged. Another agent is
blocking the edit. … I sent `python-slugify` a proposal (#9) …". That is the intended behavior.

(d) Live feed, Python: my harness failed to read the pairing code out of the colored output on the first try
(my bug, not Weft's: the page showed the browser's own "Please fill out this field."). `npx @celador/weft pair`
then printed a new code in 0.65 s and the headless browser was paired and showing events 5 s later
(`live · 1 repo`, events #7–#11 with the negotiation and `counterpart_away`).

### TypeScript (vercel/ms), with the investigation in between

| t | Step |
|---:|---|
| 0:00 | `npx @celador/weft` (same three prompts) |
| **0:21** | **(a) setup finished** (`127.0.0.1:7879`; 7878 was taken, it picked the next port) |
| **0:57** | **(d) live feed paired** in the headless browser: `live · 1 repo`, "No events yet. Start a coding agent…" (includes one retry by my script, which first typed the code into the prefilled Space field) |
| 1:12 | Attempt 1, A (Claude Code): make `parse` take `opts: { strict: boolean }`. Weft recorded only `ms` and `parseStrict` body changes (#2, #3); **the `parse` signature change was not recorded** |
| **1:45** | **(b) B (Codex) joins**; it writes `src/duration.ts` with `cat > src/duration.ts <<'EOF'` → **nothing reaches Weft** (no check, no feed event; B's `weft inbox`: `inbox empty: no open errors, nothing owed.`) |
| 2:28 | Attempt 2, B (Codex) adds `toSeconds` calling `parse(str)` inside `src/index.ts` via `apply_patch` → `accept (clean)`: nothing to conflict with, because #2/#3 never said `parse` changed |
| 9:36 | Attempt 3, A changes `format(ms, options?)` to `format(ms, locale, options?)` → `src/index.ts#format signature` (#14) |
| **9:59** | **(c) first diagnostic shown to an agent**: B (Codex) SessionStart injects `Open errors: [weft error] stale_assumption src/index.ts:225:17: ms changed the signature of src/index.ts#format (#14) after your change started using it …` with A's diff |
| 10:08 | B proposes `overload`, gets `counterpart_away`, escalates; the coordinator merges the two tasks (#20); B then writes `format(ms, { long: true })` (the old form) and it is accepted, because merged tasks no longer block each other |
| 13:14 | `npx @celador/weft --hosted` |
| **13:18** | **(e) hosted space created**: `✓ created your hosted space on Cloudflare spb2e60h0ib3 (weft-hosted.elier.ai)` (4.2 s) |
| 13:28 | `npx @celador/weft usage` → `plan free · 2026-11 0 of 5,000 free events (0%) · past the allowance: npx @celador/weft upgrade (usage-based, no seats)` (1.1 s) |
| **13:31** | **(f) `upgrade`** prints a `checkout.stripe.com` URL (2.0 s, `open` called); the headless browser shows Stripe Checkout: "Atelier · Subscribe to Weft hosted · $0.00 due today · Then $0.001 per unit, billed monthly based on usage", Apple Pay / Link / card / Cash App, Subscribe button (7.6 s to render). Not paid |
| 13:58 | `npx @celador/weft uninstall --space --yes` → `✓ erased space spb2e60h0ib3 on https://weft-hosted.elier.ai: 1 repo (ms), 0 logged events …, 4 keys`, hooks removed from both checkouts (1.8 s) |

Erasure confirmed with the hosted admin API: `[{"id":"spb2e60h0ib3","status":"erased","created_at":"2026-11-17","repos":0,"tokens":0,"internal":true}]`.
I tagged the space `internal` right after creating it, so it never entered the funnel numbers
(`/v1/admin/stats` before and after: `"spaces":{"total":4,"active":1}`, days unchanged).

Both local gateways were stopped (`npx @celador/weft local stop` → `local gateway stopped`), and no
`heartbeat-loop`, `wrangler` or `workerd` process under the scratch dirs was left running.

### Steps per milestone (a person at a terminal)

| Milestone | Python | TypeScript | Human steps |
|---|---:|---:|---|
| (a) setup finished | 19 s | 21 s | 3: run the command, `y` to npx, Enter for the second worktree |
| (b) two agents under Weft | 61 s | 1:45 | +2: start an agent in each checkout (+1 with interactive Codex: "Trust all and continue") |
| (c) first diagnostic to an agent | **68 s** | **9:59** (attempts 1–2: none) | 0 more |
| (d) live feed in a browser | ~6 s after `pair` | 0:57 | +2: open the printed address (setup opens it), type the code |
| (e) hosted space | n/a | 4.2 s | 1 |
| (f) Stripe Checkout reached | n/a | 3.1 s (`usage` + `upgrade`) | 2 + open the link |

## Telemetry truth: why the funnel shows 0 first runs

- **What counts.** `site/funnel.mjs` takes "first runs" from `GET weft-hosted.elier.ai/v1/admin/stats`
  `days`: new hosted spaces per UTC day (`apps/gateway/src/spaces.ts`: "new spaces per day (= first runs of
  `npx weft`)"), minus spaces tagged internal. A space is created only by `POST /v1/spaces` on the hosted
  gateway.
- **What 0.3.0 sends in local mode: nothing.** `chooseGateway` returns the hosted URL only for `--hosted`,
  `use hosted`, or a machine/repo that already had a hosted space (`packages/cli/src/main.ts`). Otherwise the
  CLI talks to `127.0.0.1` only, and runs wrangler with `WRANGLER_SEND_METRICS=false`
  (`packages/cli/src/gateways.ts`). The only external traces of a local first run are npm fetching
  `@celador/weft` and `wrangler` (npm's download counts). Confirmed today: two cold local first runs (TS and
  Python) left `/v1/admin/stats` unchanged.
- **So "0 first runs in 7 days" means nobody opted into hosted**, not that nobody ran Weft. The four outside
  spaces ever (10-23, 10-25, 2× 11-04) came from 0.1.0/0.2.0, which defaulted to hosted, plus whatever ran
  `--hosted` after that.
- **npm downloads don't settle it either.** Last 30 days: 772 in total, with spikes on publish days (267 on
  10-23, 173 on 10-25, 179 on 11-02) and a floor of 2–7 a day, which looks like registry mirrors and
  scanners. 33 in a week is close to that floor. Each of our own cold runs adds one or two.

**Proposal (not shipped; needs John's OK).** Send one anonymous count per machine and CLI version on setup:

- `POST https://weft.mx/e` (the existing site endpoint → Workers Analytics Engine, which stores no IP or user
  agent) with `{e: "cli_setup", v: "0.3.x", mode: "local"|"hosted"|"own", agents: <number of harnesses
  found>, os: "darwin"|"linux"|"win32"}`. No repo name, path, code, space id or key. Optionally a second
  event, `cli_first_diagnostic`, the first time any adapter shows a diagnostic on that machine: that is the
  "aha" metric.
- Off with `WEFT_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `CI` set. The first run prints one line saying what was
  sent and how to turn it off. A flag file in `~/.config/weft` keeps it to once per version.
- Copy that would change: README "Nothing leaves the machine" and try-it.md "your code and diffs never leave
  it" stay true for code, but the privacy page and README must mention the count.
- Size: S, about half a day (CLI 40 lines + tests, `site/worker.js` event names, a `funnel.mjs` column).

## Ranked friction list (most strangers stopped first)

| # | What a stranger hits | Who it stops | Status | Size |
|---|---|---|---|---|
| 1 | TS analyzer: a signature change of a function whose body destructures (or of a class member next to a computed `[Symbol.iterator]()`) is not recorded, so the other agent is never warned | most real TS repos; it hid the `parse` change in vercel/ms | **fixed on this branch**; reaches npx users with the next npm release | done (S) |
| 2 | Codex writes files through the shell (`cat > f <<EOF`, also `python -`, `sed -i`): the Codex adapter sees only `apply_patch`, so those edits are invisible (no check, no feed) | Codex users, mostly when an agent creates a new file | **fixed on wt/t_81723188** (t_81723188): the Codex adapter snapshots dirty files at PreToolUse Bash and submits what the command changed at PostToolUse Bash, like the Claude Code adapter; reaches npx users with the next npm release | done (M) |
| 3 | The aha needs choreography (A changes a signature, then B uses it the old way, in the other checkout). weft.mx only says "Run in your repo"; `npx @celador/weft demo` (the known-good collision) is only in try-it.md and the README | every stranger whose first prompts don't collide | comment on the site card t_77ce8f6b: show the two prompts and `demo` next to the command | S |
| 4 | A stale_assumption open error is cleared by *any* accepted edit of the same file, because an edit's `reads` are every call in the whole file (TS and Python). In the Python run B's harmless `__all__` edit (#7) cleared the error, so B's next `weft negotiate propose` (no `--to`) answered `weft: no open conflict to negotiate about here; pass --to AGENT (or --change CHANGE) and --keys path#symbol`. The same whole-file reads produce `stale_read` noise on functions B never touched | anyone who reads a denial and then edits the same file | card t_0c4537af: fixed on `wt/t_0c4537af` (reads scoped to the declarations an edit touches, [docs/languages.md](../languages.md#reads-are-scoped-to-the-edit)); needs a release | M |
| 5 | The deny's "negotiate" hint gave a command without `--to`/`--keys`, which fails in case 4 | agents that follow the hint | **fixed on this branch**: the hint names the counterpart and the symbols (shell-safe ones only), in the Claude Code and Codex adapters | done (S) |
| 6 | Escalating merges the two tasks, after which B writes the incompatible call (`format(ms, { long: true })`) and it is accepted: the conflict is hidden, not resolved | teams that let agents escalate unattended | design question (should a merge keep the open error until one side adapts?) | S–M |
| 7 | Hosted setup says `created your hosted space on Cloudflare … (weft-hosted.elier.ai)` but not that the agents' edits and diffs now go there, nor the free allowance. The host is `elier.ai`, the site is `weft.mx` | privacy-minded teams | comment on the Pro card t_6ee961cf (it rewrites `main.ts`; I did not touch it) | S |
| 8 | Stripe Checkout shows the account name **"Atelier"**, "$0.001 per unit" (unit undefined) and no mention of the 5,000 free events | anyone about to pay | John: Stripe account public name; product/price display on the Pro card t_6ee961cf | S (settings) |
| 9 | Feed lines name changes by raw id: `coordinator merged the tasks of I97b4e65a700be9519c20f0cb0dc19f92eeb06f5d + I03344f…`, `ms-2 → I97b4e65a…: proposes overload` | feed readers | listed; summary needs the change→agent map | S |
| 10 | weft.mx fine print says "The analyzer understands TypeScript today." (12 languages are supported) | readers who leave because they use Python/Go/… | already fixed in the uncommitted site work on `wt/site-signup` (t_77ce8f6b); I left it alone | done there |
| 11 | npm's own `Ok to proceed? (y)` and "New major version of npm available" notice | nobody (harmless) | outside Weft | — |

Not friction, worth knowing: Codex joins at `L2` (`ms-2 joined (codex-code, L2)`), and its denial path works
(attempt 3). The setup's "First run" notes were correct for Codex (`--dangerously-bypass-hook-trust`
printed `` `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this
invocation. `` twice and the hooks ran).

## What changed on this branch

1. `packages/analyzer/src/index.ts`: `declarations()` skips declaration nodes with no name of their own
   (destructuring `const { a } = …` / `const [a, b] = …`, computed members). They used to take the enclosing
   declaration's key and overwrite its entry. Tests in `src/index.test.ts`: signature change of a function
   that destructures in its body, array destructuring keeps the body change, a computed method no longer
   stands in for its class. RED before the fix (`expected [] to deeply equal [ Array(1) ]`, 3 failures),
   GREEN after (21/21). Re-checked against the real vercel/ms edit: `analyze(orig, final)` went from
   `ms body, parseStrict body` to `ms body, parse signature, parseStrict body`. Python and Go functions with
   tuple/multiple assignment were already right (checked).
2. `packages/adapters/{claude-code,codex}/src/render.ts`: `optionsHint` prints
   `negotiate propose overload "…" --to <agent> --keys <symbols> --wait 240` and
   `negotiate escalate "<why>" --to <agent> --keys <symbols>`. Agent ids and keys that are not shell-safe
   (`[\w./#:@+-]`) are left out, so nothing from a diagnostic is pasted into a shell unquoted. Tests:
   `claude-code/test/adapter.test.ts` (deny text, a new `optionsHint` unit test with unsafe input, and a
   check that the printed command parses), `codex/test/collision.test.ts`.

Gate on the final tree: `pnpm -r --no-bail typecheck && pnpm -r --no-bail test` → `GATE_EXIT 0` (analyzer 214,
claude-code 128, codex 16, mcp 18, conformance 59, cli 85, gateway 154 + 35, every other package green).

Not changed, to avoid colliding with running cards: `packages/cli/src/main.ts` and `packages/cli/README.md`
(rewritten on `wt/pro-plan`, which already drops the stale "Usage-based pricing is coming." line) and
`site/public/index.html` (being rewritten on `wt/site-signup`).

## Still open

- Release: the two fixes reach strangers only with the next npm release (`wt/pro-plan` bumps the CLI to 0.4.0;
  its go-live card t_5408b767 waits for John's price decision). Until then `npx @celador/weft` runs 0.3.0.
- Follow-up cards: t_81723188 Codex shell writes (#2), t_0c4537af open errors cleared by unrelated same-file edits (#4). Notes left on t_6ee961cf (#7, #8) and t_77ce8f6b (#3).
- Needs John: the telemetry count (proposal above), the Stripe account's public name (#8).
- Cursor, Gemini, Copilot, OpenCode, Antigravity were not run (card scope: the installed Claude Code and Codex
  only; no harness was installed).
