# @weft/hook-conformance — `wcp-hook-conformance`

Standalone conformance runner for [Agent Hooks Core v0.1](../../docs/protocol/hooks-core-v0.md).
Give it any command that implements a hook (one process per event, JSON on stdin, JSON on
stdout) and the host dialect it speaks; it drives the command through the core fixtures and
prints which capability levels it actually delivers:

```
| Declared | **L3** (cursor-cli; observe sync, inject immediate, deny_edit true, refuse_stop true, commit_gate tool_interception) |
| **Verified** | **L3** — L0 pass, L1 pass, L2 pass, L3 pass |
| Declaration honest | yes (declared ≤ verified) |
| Failure policy (backend down) | fail-open |
```

No runtime dependencies beyond Node ≥ 22 and git: the bundle carries the oracle (a WCP
reference coordinator) and the fixtures.

## Use

```sh
pnpm --filter @weft/hook-conformance build        # → dist/wcp-hook-conformance.mjs (+ dist/fixtures)
node packages/conformance/bin/wcp-hook-conformance.mjs fixtures

node packages/conformance/bin/wcp-hook-conformance.mjs run \
  --dialect claude-code \
  --setup 'node /abs/path/weft-claude.mjs install --url {url} --repo {repo} --agent {agent} --task {task}' \
  --env WEFT_TOKEN=conformance-token \
  --md report.md --json report.json \
  -- node /abs/path/weft-claude.mjs hook
```

| Option | |
|---|---|
| `--dialect` | `core` (the core stdio binding), `claude-code`, `codex`, `cursor`, `gemini`, `opencode` |
| `--setup '<shell>'` | run in each fresh fixture workspace before the first event, to point the hook at the oracle. `{url} {repo} {agent} {task} {workspace}` are substituted; the same values are exported as `WCP_URL WCP_REPO WCP_AGENT WCP_TASK WCP_TOKEN WCP_WORKSPACE` |
| `--env K=V` | extra environment (repeatable) |
| `--timeout ms` | per-invocation budget, default 30000 (Cursor's default) |
| `--only ids` | run a subset |
| `--require-level N` | exit 1 unless L*N* is verified |

Exit status: 0 when the hook's declaration is honest (declared ≤ verified) and any
`--require-level` is met.

`bridge` wraps a native hook so it speaks the core stdio binding:

```sh
echo '{"hooks":"0.1","event":"agent.stop","id":"e1","session":"s1","cwd":"/w","stop":{"repeat":0}}' \
  | node packages/conformance/bin/wcp-hook-conformance.mjs bridge --dialect cursor -- node weft-cursor.mjs hook
```

## How it works

For each fixture (`fixtures/core/*.json`): a fresh git workspace (`workspace.json`), a fresh
oracle on `127.0.0.1:<random>`, the setup command, then the steps — core events encoded in the
chosen dialect (`src/dialects.ts`), tool calls applied to disk only when not denied, a peer
agent's change applied directly on the oracle, and checks against the hook's decoded answers
and against the oracle's log. Levels: spec §11.

The oracle is WCP's reference coordinator because it makes the right answers deterministic
(an edit that calls a function whose signature a peer changed after the agent's base must be
denied). The levels and checks are core semantics; a non-WCP hook can be tested by pointing
its policy at the oracle in `--setup`, or by contributing fixtures with another oracle.

## Language fixture sets

`fixtures/languages/<language>/` holds per-language sets (Python, C, C++, Java, Kotlin, Ruby, PHP today): a workspace in that
language and fixtures where a peer renames a function or changes its signature and the agent's
edit must be denied (or allowed after adapting, or allowed when unrelated). Run one with
`--fixtures python`; list it with `fixtures python`. `test/languages.test.ts` checks every set
against `@weft/analyzer` and the Claude Code adapter. See [docs/languages.md](../../docs/languages.md).

## Weft reports

`node packages/conformance/scripts/weft-reports.mjs` (from the repo root, after building the
adapters) regenerates [docs/standardization/reports](../../docs/standardization/reports/README.md)
for the Claude Code, Codex, OpenCode, Cursor and Gemini CLI adapters, the core binding via
`bridge`, and the Claude Code adapter in advisory mode.
