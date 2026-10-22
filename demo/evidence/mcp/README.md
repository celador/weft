# @weft/mcp: real run of a hookless MCP agent (card t_70b3d8fe)

Run with `node demo/mcp-hookless.mjs --url http://localhost:8796` against a local gateway
(`cd apps/gateway && pnpm dev:local --port 8796`), Claude Code 2.1.308, model `sonnet`.

**Harness used:** Zed's native agent and Warp were the preferred hosts. Neither could be run on the
build Mac. Zed's agent needs a Zed sign-in or an Anthropic API key, and Warp's agent needs a Warp
login; the machine has neither, and both are GUI-only. As the card allows, agent B is **Claude
Code with no Weft hooks and only the Weft MCP server configured**:

- `--mcp-config` with only the `weft` server, plus `--strict-mcp-config`;
- `--setting-sources project`, and the worktree has no `.claude/` directory, so no hooks load;
- `b-hooks.jsonl` (every call the server's core handled) shows only the `mcp:claude-code` harness:
  synthetic events from the MCP server and its watcher, never a Claude Code hook.

Agent A (`claude-a`) is Claude Code with the normal Weft hooks adapter (L3, hooks in
`.claude/settings.local.json`, run with `--setting-sources project,local`).

## What happened (`summary.json`, `b-turn2.jsonl`, `events.json`)

1. B turn 1 read the code. The MCP server said hello (`join` #1: `harness mcp:claude-code`,
   `level 0`), which pinned B's base at #1.
2. A changed `calcTotal(items)` to `calcTotal(items, opts: PriceOptions)` (event #4, accepted) and
   committed it (checkpoint #5).
3. B turn 2 called **`weft_check`** with its proposed `src/cart.ts` (`calcTotal(items)`) and got
   **A's squiggle**: `REJECT` and `[weft error] stale_assumption src/cart.ts:4:43 … signature
   changed in #4 by claude-a after your base #1`, with A's diff quoted (log #9, a rejected check).
4. B adapted: `cartSummary(items, opts: PriceOptions = { taxRate: 0 })` passing `opts` to
   `calcTotal`, checked again (accept), and wrote the file with Claude Code's own **`Write`
   tool**. Weft never saw that tool call. The embedded watcher reported the edit as **`commit`
   #10** (`tool: Write`, `call_id: watch-…`, accepted).
5. `weft_gate stop` returned allowed, and B finished.

All seven checks in `summary.json` pass: B is L0/MCP, A is hooked L3, B has no Claude Code hooks,
B called `weft_check`, B received A's squiggle (it cites A's event #4), B's own-tool edit appears
in the log through the watcher, and B used its native edit tool.

## Earlier runs of the same script (evidence overwritten)

The model's next step after the squiggle varied between runs. Each was a valid WCP path:

- It proposed an overload (`weft_negotiate`), got no reply because A had exited, then adapted to
  `calcTotal(items, { taxRate: 0 })`. Its `Write` reached the log through the watcher.
- It proposed an overload, then escalated. The coordinator merged both tasks (`control merge`,
  WCP §7.6), B wrote its call with its own `Edit` tool, and the watcher reported it.
- With the turn-2 prompt that did not say "adapt instead of waiting", it proposed an overload and
  stopped without editing. Its open error stayed in the log, and the session stayed open for the
  git pre-commit gate. An MCP server cannot refuse a stop (`refuse_stop: false`). The prompt now
  says to adapt rather than wait, so the run always exercises the watcher path.

## Files

| File | What |
|---|---|
| `summary.json` | checks, tool calls, the squiggle excerpt, the watcher's records |
| `b-turn1.jsonl`, `b-turn2.jsonl`, `a.jsonl` | Claude Code stream-json transcripts (init lines trimmed to the essentials) |
| `events.json` | the repo's event log (observer token; diffs included) |
| `b-hooks.jsonl`, `b-adapter.log`, `a-adapter.log` | per-call timing and verdict logs of both checkouts |
| `b-cart.ts`, `a-pricing.ts` | final files in each worktree |

No tokens are in this directory. They were minted per run and passed only through files with
mode 600 and environment variables.
