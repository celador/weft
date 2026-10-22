# Google Antigravity + Weft — live evidence (2026-10-22)

Adapter: `@weft/adapter-antigravity` ([README](../../../packages/adapters/antigravity/README.md)), one
`.agents/hooks.json` per checkout. Harness: **Antigravity CLI `agy` 1.4.5** (Homebrew cask
`antigravity-cli`), model Gemini 3.8 Flash (High), signed in with a Google account. Gateway:
local `pnpm dev:local --port 8799` (no Cloudflare). Tokens were minted per run and are not in
these files; paths are shortened to `<work>` / `~`.

| Dir | What happened |
|---|---|
| [`hook-probe/`](hook-probe/) | Raw payloads agy sent to a logging hook, before the adapter was fixed. **Run 1** answered `{}` to every `PreToolUse`: agy denied every call (`tool call denied by pre-tool hook: ` in the transcript). **Run 2** answered `decision:"ask"`: tools ran (with `--dangerously-skip-permissions`; without it, headless agy auto-denied `run_command`), `SessionStart` and `PreInvocation` `injectSteps` appeared in the trajectory, and `Stop` `decision:"continue"` re-entered the loop (the model then did what the reason asked). |
| [`stop-gate-claude/`](stop-gate-claude/) | **agy + a hooked Claude Code agent** (the card's run): deny with squiggle, Stop continued, PreInvocation inbox injection, clean landing. See below. |
| [`stop-gate-claude-giveup/`](stop-gate-claude-giveup/) | agy + Claude Code, agy-b never adapts: five Stop refusals, then released by the core. |
| [`stop-gate-agy-x2/`](stop-gate-agy-x2/) | Two real agy agents, one coordinator: the demo collision. See below. |

## stop-gate-agy-x2: two `agy` agents

`node demo/antigravity-live.mjs stop-gate` with `WEFT_DEMO_A=agy`. Coordinator log:
[`coordinator-log.json`](stop-gate-agy-x2/coordinator-log.json); agy-b's full trajectory:
[`agy-b-transcript.jsonl`](stop-gate-agy-x2/agy-b-transcript.jsonl); every hook call:
[`hooks-b.jsonl`](stop-gate-agy-x2/hooks-b.jsonl), [`hooks-a.jsonl`](stop-gate-agy-x2/hooks-a.jsonl).

1. **SessionStart (L1).** agy-b's first step after the prompt is a `SYSTEM_MESSAGE` "injected by a
   SessionStart hook: [weft] This checkout is coordinated by Weft …" (transcript step 1).
2. agy-b plans `return calcTotal(this.items);` without editing. agy-a then changes
   `calcTotal(items, opts: PriceOptions)` and its caller (events #3, #4).
3. **Deny with the squiggle (L2).** agy-b, resumed with `--conversation`, writes the old call with
   `edit_file`. The hook answers `decision:"deny"`; agy shows the agent (step 9):
   `tool call denied by pre-tool hook: [weft] Edit to src/cart.ts blocked … [weft error]
   stale_assumption src/cart.ts:15:12: You use src/pricing.ts#calcTotal, whose signature changed in
   #3 by agy-a …` with agy-a's diff. Coordinator event #5 `edit rejected`.
4. **Stop refused while the error is open (L3).** agy-b was told not to adapt and to end its turn.
   Each `Stop` (`terminationReason:"NO_TOOL_CALL"`) was answered `decision:"continue"`; agy
   re-entered the loop with "Stop hook blocked termination: [weft] Not done (stop refusal 1/5): 1
   open Weft error(s) …" as a system message (steps 11, 19, 88, 92, 94). Between refusals the
   model used the hint in the reason and **negotiated** through `.weft/bin/weft negotiate propose`
   (event #6: make `opts` optional). After 5 refusals the core lets the agent stop and leaves the
   error in the feed (by design).
5. agy-a's next turn: renamed `taxRate`→`rate` (#8, #9); its own stop was refused until it answered
   the open proposal (`stop gate refused #1 (reply:#6)`, adapter-a.log); it accepted (#10) and made
   `opts` optional (#11).
6. **Inbox via `PreInvocation` `injectSteps` (delayed L1).** agy-b's next turn: before the first
   model call the hook drained the inbox and injected (step 97) "The following system message was
   injected by a PreInvocation hook: [weft diagnostics] [weft negotiation] #10 agy-a … ACCEPTED #6
   …". agy-b quoted it, retried its plan, and the edit was accepted (#12).
7. Landing ([`landing.txt`](stop-gate-agy-x2/landing.txt)): both branches committed (the Weft
   commit gate let them through: nothing open), main after merging agent-a then agent-b: `tsc` exit
   0.

Side observations: agy ran shell commands and read files outside its checkout (including this
repo's adapter source) although the prompt asked for no commands. `--dangerously-skip-permissions`
was used for the sandboxed demo checkouts; with it, Weft's `ask` resolves to allow.

## stop-gate-claude: agy alongside a hooked Claude Code agent

`node demo/antigravity-live.mjs stop-gate` (default: agent A is **Claude Code** 2.x, `claude -p`,
hooked by `@weft/adapter-claude-code`; Claude Code used the OAuth token of its keychain login via
env because headless `claude auth status` reports `loggedIn:false`). Coordinator log:
[`coordinator-log.json`](stop-gate-claude/coordinator-log.json); agy-b trajectory:
[`agy-b-transcript.jsonl`](stop-gate-claude/agy-b-transcript.jsonl); claude-a sessions:
`claude-a-session-*.jsonl`; script output: [`demo-stdout.txt`](stop-gate-claude/demo-stdout.txt).

1. SessionStart: agy-b gets the Weft system message (`injected by a SessionStart hook: [weft] This
   checkout is coordinated by Weft …`).
2. claude-a changes `calcTotal(items, opts: PriceOptions)` and its caller (events #3, #4).
3. **Deny with the squiggle (L2).** agy-b writes `calcTotal(this.items)`; agy shows it `tool call
   denied by pre-tool hook: [weft] Edit to src/cart.ts blocked … [weft error] stale_assumption
   src/cart.ts:16:12: You use src/pricing.ts#calcTotal, whose signature changed in #3 by claude-a …`
   (event #7 `Blocked`).
4. **Stop continued (L3).** agy-b's stops were answered `decision:"continue"`: `Stop hook blocked
   termination: [weft] Not done (stop refusal 1/5): 1 open Weft error(s) …` (and 2/5). Re-entered,
   agy-b proposed an overload to claude-a (event #8) and then adapted: `calcTotal(this.items,
   { taxRate: 0 })` was accepted (#9).
5. claude-a renamed `taxRate`→`rate` (#11–#13).
6. **Inbox via PreInvocation `injectSteps` (delayed L1).** agy-b's next turn begins with `injected
   by a PreInvocation hook: [weft diagnostics] [weft warning] stale_read src/cart.ts:15:12:
   src/pricing.ts#calcTotal body changed in #12 by claude-a …`; agy-b updated its call (#17).
7. Landing (end of `demo-stdout.txt`): `cart.ts` calls `calcTotal(this.items, { rate: 0 })`; main
   after merging agent-a then agent-b: `tsc` exit 0.

In that run claude-a could not answer agy-b's proposal: headless `claude -p` needed approval to run
`.weft/bin/weft`. The script now allow-lists `Bash(<checkout>/.weft/bin/weft …)` for claude-a.

[`stop-gate-claude-giveup/`](stop-gate-claude-giveup/) is a second Claude Code + agy run where agy-b
obeyed "do not adapt" to the end: deny, then five `Stop` → `continue` refusals (hooks-b.jsonl), then
the core lets it stop and the error stays in the feed; agy-b's `cart.ts` is unchanged and nothing
was injected on turn 3 because nothing new was queued for it (B3 `NONE`).

## reroute: agy adapts, then a core gap shows up

`node demo/antigravity-live.mjs reroute` (Claude Code as A, with `.weft/bin/weft` allow-listed).
The adapter side worked: agy-b's stale call was denied with the squiggle (event #7, transcript), and
agy-b adapted to `calcTotal(this.items, { taxRate: 0 })`, accepted (#8). claude-a then renamed
`PriceOptions.taxRate`→`rate` (#10, #11) and **the coordinator raised nothing for agy-b**: no
diagnostic was queued, so turn 3's PreInvocation drain had nothing to inject (B3 `NONE`), both
commits passed the gate, and main fails `tsc` (`'taxRate' does not exist in type 'PriceOptions'`,
[`landing.txt`](reroute/landing.txt)). In stop-gate-claude the same rename reached agy-b only as a
`stale_read` warning ("contract is unchanged"). This is the core analyzer (a dependency through an
object literal typed by a renamed type field is not tracked), not the Antigravity adapter; it is
filed as a follow-up card.

## Reproduce

```sh
(cd apps/gateway && pnpm dev:local --port 8799) &
WEFT_URL=http://localhost:8799 node demo/antigravity-live.mjs stop-gate                  # Claude Code as agent A
WEFT_URL=http://localhost:8799 WEFT_DEMO_A=agy node demo/antigravity-live.mjs stop-gate  # agy as agent A
```
