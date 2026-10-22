# VS Code extension: live runs, 2026-10-22

The packaged extension (`apps/vscode/out/weft-0.1.0.vsix`, the same file for both editors) in a
clean profile of VS Code 1.143.0 and of Cursor 1.128.0 (VS Code base), against a local gateway
(`cd apps/gateway && pnpm dev:local --port 8831`), while two real Claude Code agents with the
Weft adapter (`claude -p`) collide. Driver: `apps/vscode/test/live/run.mjs --app vscode|cursor`
(it uses only the extension's public commands and `api.state()`; screenshots are of the editor
window, by its process id). Prompts, agent output, the driver log and the recorded gateway log
are next to the screenshots.

The story in both editors: claude-b plans `cartTotal` with `calcTotal(items)`; claude-a changes
`calcTotal(items, opts: PriceOptions)` (#4); claude-b's edit of `src/cart.ts` is refused,
`stale_assumption`, caused by claude-a · event #4. john pauses claude-b, opens the cause, sends
claude-b a message and resumes it.

| Beat | `vscode/` (repo shop-feed-222754) | `cursor/` (repo shop-feed-225614) |
|---|---|---|
| Feed live while the agents work (#4 arrives over the socket) | `1-feed-live.png` | `1-feed-live.png` |
| Editing now lists both tasks (Show the cart total / Prices include tax) | `2-…`, `6-feed-end.png` | `2-…`, `6-feed-end.png` |
| Squiggle on `calcTotal` in claude-b's checkout, hover with "caused by claude-a · event #4" | `2-squiggle-hover.png` | `2-squiggle-hover.png` |
| Problems panel | `3-problems.png` | `3-problems.png` |
| Open causing event → claude-a's diff in the native diff editor | `4-cause-diff.png` | `4-cause-diff.png` |
| Pause (#7 / #9) and Message (#10 / #11) in the log | `5-paused-message.png`, `6-feed-end.png` | `5-paused-message.png`, `6-feed-end.png` |

Quick fixes on the squiggle (`state.json` / `driver.log`): VS Code: *Open causing event (#4)*,
*Show the blocked change in the Weft feed (#6)*, plus Copilot's *Fix* / *Explain*. Cursor: the same
two (the blocked change is #8 there) plus Cursor's own *Fix in Agent* (and *Fix with Agent* in the
hover).

Differences between the runs: in VS Code claude-b was resumed while still running and landed
`calcTotal(items, { taxRate: 0 })` (#13), which closed the squiggle. On Cursor the machine was
under heavy load (load average ~300), so claude-b had already stopped while paused when the
resume (#12) arrived; the squiggle stays open at the end, which is correct. Cursor's clean
profile is seeded from this Mac's own Cursor state (sign-in and first-run choices) so its
first-run cards don't cover the workbench; the seeded profile is deleted after the run.

## Agent probe: does the editor's agent read the squiggles? (`agent-probe-vscode/`)

`apps/vscode/test/live/agent-probe.mjs --app vscode`: a fresh real conflict (claude-b refused at
#8, then paused so the squiggle stays open), VS Code with the .vsix and this Mac's Copilot
sign-in, `src/pricing.ts` open, and the question **"what errors are in this file?"** typed into
the chat in Agent mode.

Answer (`answer.txt`, `3-answer.png`): *"Checked pricing.ts, 1 problem found. There's one
reported issue at line 3 in pricing.ts:3: calcTotal's signature changed in another change, so
the editor is flagging a contract conflict and blocking edits. Read the updated signature and
align this function or its callers with it."* The only diagnostic in that file is Weft's, so
**Copilot agent mode reports the Weft squiggle** (cooperative L1 confirmed).

Cursor: not answered by a live probe yet. In the seeded clean profile Cursor's agent stays
signed out ("Log in"), and Cursor 3 opens its own profile in the Agents window, not on the
folder. See docs/harness-coverage.md §7 Q5.
