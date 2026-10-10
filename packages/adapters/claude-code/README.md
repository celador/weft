# @weft/adapter-claude-code — WCP adapter for Claude Code (L3)

Connects a Claude Code checkout to a Weft coordinator (WCP v0.1, `docs/protocol/wcp-v0.md`).
Every edit Claude makes is checked against what other agents changed since its base; conflicts
come back as positioned, compiler-style diagnostics, block the edit, and keep the agent from
finishing or committing until they are resolved.

```sh
# in the agent's checkout (token: an agent token bound to this agent; add `observe` scope so
# the adapter can quote the other agent's diff)
# (the package is not on npm: build it with `pnpm --filter @weft/adapter-claude-code build` and
# use the absolute path of dist/weft-claude.mjs; `scripts/local-quickstart.mjs` does all of this)
WEFT_TOKEN=... node /abs/path/to/weft/packages/adapters/claude-code/dist/weft-claude.mjs install \
  --url http://localhost:8787 --repo my-repo \
  --agent claude-b --task T-2 --title "Show the cart total" [--priority 0] [--prefix sub/dir/] [--mode enforce|advise] [--shared]
```

`install` writes:

| file | content |
|---|---|
| `.weft/claude.json` | url, repo, agent, task, `change` (= the `Change-Id`, `I` + 40 hex, stable per task), mode |
| `.weft/token` (0600) | the agent token (from `WEFT_TOKEN`); never in config, logs or git |
| `.claude/settings.local.json` (`--shared`: `settings.json`) | the hooks below (absolute `node` + bundle paths) |
| git `commit-msg` hook | adds `Change-Id`, `Task-Id`, `Agent-Id` trailers (`git interpret-trailers --if-exists doNothing`) |
| git `pre-commit` hook | last gate: refuses the commit while the checkout's WCP session has open errors |
| `.git/info/exclude` | `.weft/`, `.claude/settings.local.json` |

### Subagents (`install-agent`, `hook --by-path`)

A subagent runs with its parent session's working directory, so the plain `hook` would look for
`.weft/claude.json` in the parent's checkout and ignore the subagent's edits in another worktree.
To let one orchestrating session hand each worktree to its own subagent:

```sh
# in each worktree the subagents will work in
WEFT_TOKEN=... npx weft-adapter-claude install --url … --repo my-repo --agent worker-1 --task T-1
# once, in the orchestrating session's project (then start a new session so it loads)
npx weft-adapter-claude install-agent [--name weft-worker]
```

`install-agent` writes `.claude/agents/weft-worker.md` (added to `.git/info/exclude`: it holds
absolute paths), a subagent whose own frontmatter hooks run `hook --by-path` on Edit, Write and
MultiEdit. `--by-path` looks for the config in the edited file's own checkout first (stopping at
the first directory holding `.git`), then in the cwd, so each subagent acts as the agent of the
worktree it edits. Give each subagent the absolute worktree path. Plain `hook` is unchanged.

**Pinned coordinator.** A checkout can ship its own `.weft/claude.json`, so `--by-path` does not
trust one by location alone. `install-agent` pins the coordinator URL and repo of the parent
session's own config (or `--url` and `--repo` when the parent has none) into the worker definition
as `hook --by-path --url U --repo R`. A `--by-path` hook coordinates only a checkout whose config
has exactly that url and repo. Any other checkout is logged (`hook --by-path refused`) and not
coordinated, and an unpinned `--by-path` hook trusts nothing. Re-run `install-agent` after changing
the coordinator. Plain `hook` does not read the pin.

**Bash target.** Under `--by-path`, a Bash command is attributed only through a target it names in
one of these forms, and is otherwise denied before it runs:

- a leading `cd <dir> && ...`, where `<dir>` is an absolute path or `~` / `~/...` (bare, `"…"` or `'…'`);
- a leading `git -C <dir> ...`, with the same `<dir>` forms.

Relative paths (`cd src && ...`), `$VAR` or `${VAR}`, a `cd` that is not the first command, and a
bare `cd <dir>` without `&&` are refused. The deny tells the agent to start the command with
`cd <worktree> &&`. Plain `hook` does not deny Bash.

Not covered yet (#10): a subagent's Bash commands and Stop are not routed by path, so the
in-session commit and stop gates use the parent's checkout; the worktree's git `pre-commit` hook
still refuses commits while that worktree has open errors.

Runtime state lives in `.weft/state/<claude-session>.json` (WCP session, base, acked inbox id,
pending edits; guarded by a lock dir because Claude runs parallel tool calls' hooks
concurrently); the adapter log is `.weft/log/adapter.log`.

## Hook mapping (spec §8.3)

| Claude Code hook | WCP | level |
|---|---|---|
| `SessionStart` | `hello` (re-hello on 410), drain, inject a one-paragraph "you are coordinated" notice + inbox | L1 |
| `UserPromptSubmit` | drain, inject | L1 |
| `PreToolUse` Edit / Write / MultiEdit | derive the proposed file text from `tool_input`, analyze before/after (`@weft/analyzer` + cross-file import reads), `submit mode:"check"`. **reject → `permissionDecision:"deny"`** with the rendered diagnostics; accept with warnings → `additionalContext` | L2 |
| `PreToolUse` Bash `git commit …` | `gate commit` → deny while errors are open (`commit_gate: tool_interception`) | L3 |
| `PostToolUse` Edit / Write / MultiEdit | real before (stashed at PreToolUse) / after (disk) → `submit mode:"commit"` with a unified diff; inject verdict + inbox (minus what PreToolUse already showed) | L0/L1 |
| `PostToolUse` other tools | drain (throttled to one per 2 s); Bash that moved `HEAD` → `checkpoint {sha}` | L1 |
| `Stop` | `gate stop` → `decision:"block"` with the open errors; after 5 refusals for the same errors Claude may stop (runaway guard; errors stay in the feed) | L3 |
| `SessionEnd` | `bye` — unless errors are open: then the session stays alive (detached heartbeat loop, 30 min idle limit) so the pre-commit gate and a resumed conversation still see them | |

Declared capabilities: `{level: 3, observe: sync, inject: immediate, deny_edit, refuse_stop, commit_gate: tool_interception}`.

### Squiggles

Diagnostics are rendered with the shared `renderDiagnostic` (identical text in every harness)
after the adapter fills `range` from the checkout: read-based codes (`stale_assumption`,
`stale_read`) point at the call site in the file being edited, others at the symbol's
declaration. For `stale_assumption` / `contract_changed` / `stale_overwrite` the adapter fetches
the causing event (`GET /events/{seq}`, needs `observe` scope) and quotes its hunks — the other
agent's edit lives in its own fork, so "read the new signature" is otherwise impossible:

```
[weft error] stale_assumption src/cart.ts:15:12: You use src/pricing.ts#calcTotal, whose signature changed in #4 by claude-a after your base #1. (caused by claude-a · task T-1 · event #4). Suggestion: …
  ↳ event #4 by claude-a changed src/pricing.ts (their change is not in your checkout yet):
    -export function calcTotal(items: Item[]): number {
    +export function calcTotal(items: Item[], opts: PriceOptions): number {
```

### base_seq

`base_seq` advances only when coordinator text actually reaches the model (deny reason,
`additionalContext`, stop reason) — to that response's `delivered_through` (spec §5.2 "received
**and passed to the model**"). Silent responses never advance it, so a conversation that read
a file before another agent changed a signature in it still submits with the old base and R2
flags the call. Trunk items (`requires_rebase`) floor the base below the landing until
`git merge-base --is-ancestor <land sha> HEAD` holds.

### Failure behaviour

Fail open: a transport/coordinator error lets the tool run (`additionalContext` notes that the
edit was not coordinated) and is logged. Files outside the checkout (with `--by-path`: outside
the edited file's own joined checkout), and under `.git`, `.weft`, `.claude`, `node_modules`,
`dist`, are ignored. Edits whose analysis yields no writes
(comment/import-only) are not submitted.

## Negotiation from the shell (spec §7.4, §7.6, §8.4)

`install` also writes `<checkout>/.weft/bin/weft`, the agent's own Weft command (the model runs
it through its shell tool; it uses this checkout's session and token):

```text
weft negotiate propose <overload|transfer|share|sequence|merge_tasks|other> "<terms>" [--to AGENT|--change CHANGE] [--keys k1,k2] [--wait SECONDS]
weft negotiate accept <seq>
weft negotiate reject <seq> ["<reason>"]
weft negotiate counter <seq> <kind> "<terms>" [--wait SECONDS]
weft negotiate escalate "<reason>" [--to AGENT|--change CHANGE] [--keys k1,k2]
weft inbox [--wait SECONDS]
```

- Without `--to`/`--keys`, `propose` and `escalate` target the agent behind this session's newest
  open error, with the symbols it blocks. `--wait` blocks until the reply arrives (or times out).
- Every loser-side error the adapter injects (`stale_assumption`, `claim_wait`, `claim_die`,
  `claim_wounded`) ends with a `↳ Your options:` line naming retreat, wait, the exact
  `negotiate propose` command and the `negotiate escalate` command.
- Proposals addressed to this agent arrive as `[weft negotiation] #n …` lines (any hook that
  injects context) with the answer commands; the Stop hook refuses to finish while one is
  unanswered, or while an accepted `overload` has not been made (`[weft negotiation due]`).
- Harness permissions: allow `Bash(<checkout>/.weft/bin/weft:*)` and `Bash(.weft/bin/weft:*)`
  for headless runs (models use both forms).

## Development

```sh
pnpm --filter @weft/adapter-claude-code test     # builds dist/weft-claude.mjs, runs vitest
node demo/claude-collision.mjs [stop-gate]       # two real `claude -p` sessions vs the preview gateway
```

The bundle (`scripts/build.mjs`, esbuild, `typescript` external and loaded lazily in a split
chunk) is what hooks execute: `node dist/weft-claude.mjs hook`.
