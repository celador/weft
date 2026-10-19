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
| `PreToolUse` Bash (any command) | snapshot the text of the checkout's dirty files (`git status`; skipped above 500 files / 4 MB) for the reconcile below | |
| `PostToolUse` / `PostToolUseFailure` Bash | files whose text differs from the snapshot (or from `HEAD` if they were clean) → one `edit`, `mode:"commit"`, with their diff; **also when the command failed partway**, since its edits are on disk all the same. Files the same command also committed show up as the checkpoint instead | L0/L1 |
| `PostToolUseFailure` Edit / Write / MultiEdit | same as `PostToolUse` (an unchanged file submits nothing) | L0/L1 |
| `PostToolUse` other tools | drain (throttled to one per 2 s); Bash that moved `HEAD` → `checkpoint {sha}` | L1 |
| `Stop` | `gate stop` → `decision:"block"` with the open errors; after 5 refusals for the same errors Claude may stop (runaway guard; errors stay in the feed) | L3 |
| `SessionEnd` | `bye` (the coordinator then releases the change's claims; open errors stay on the change) — unless errors are open: then the session stays alive (detached heartbeat loop, 30 min idle limit) so the git pre-commit gate, which asks through the live session, still sees them | |

File reads: the adapter only reads regular files inside the checkout, never through a symlink
(`O_NOFOLLOW`, and the file's real path must be `<real checkout>/<path>`, so a symlinked
directory on the way is refused too). A file it cannot read that way is treated as having no
text, so an edit to it is not coordinated rather than leaking the target's content into a diff.

`.weft/bin/weft claim --keys path#symbol[,…] [--firm] [--ttl MS]` submits an explicit claim
(spec §7.5); see docs/try-it.md.

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
edit was not coordinated) and is logged. Files outside the checkout, and under `.git`, `.weft`,
`.claude`, `node_modules`, `dist`, are ignored. Edits whose analysis yields no writes
(comment/import-only) are not submitted.

## Subagents: `install-agent` and `hook --by-path`

A subagent (for example `weft-worker`) runs in the parent session's cwd but edits inside its own
joined worktree, and has no SessionStart of its own. In the orchestrating session's project:

```sh
# in each worktree the subagents will work in
WEFT_TOKEN=... node …/weft-claude.mjs install --url … --repo my-repo --agent worker-1 --task T-1
# once, in the orchestrating session's project (then start a new session so it loads)
node …/weft-claude.mjs install-agent [--name weft-worker]
```

`install-agent` writes `.claude/agents/weft-worker.md` (added to `.git/info/exclude`: it holds
absolute paths), a subagent whose own frontmatter hooks run `hook --by-path` on Edit, Write,
MultiEdit, Bash and on Bash failures. Plain `hook` is unchanged.

**Which checkout.** `--by-path` takes the checkout from the edited file (for Bash, from the
`cd`/`git -C` target below): the nearest directory holding `.git`. That checkout is coordinated
only through its own `.weft/claude.json`; if it has none, or the config does not load (broken
JSON, JSON `null`, a missing field), the call is not coordinated. It never falls back to the
cwd's config, which would attribute the edit to the parent agent. Only a call that names no file
or target at all uses the cwd's checkout (still subject to the pin below); a Bash call with no
target is denied before it runs. The agent, change and task are the ones in that
checkout's config: each subagent acts as the agent of the worktree it works in.

**No symlinks.** The checkout is found from the path as written, so under `--by-path` an edit (or a
Bash target) whose path goes through a symlink, anywhere from the file up to and including the
directory holding `.git`, is denied before it runs: `src/x.ts -> /parent/src/x.ts` or
`linked -> /parent` would write to, or load the config of, another checkout. Give subagents the
real worktree path. Paths in no checkout are not checked (they are not coordinated at all). A
`..` segment in an edited path or a Bash target is denied too: the kernel resolves `link/..`
against the link's target, not lexically.

**Pinned coordinator.** A checkout can ship its own `.weft/claude.json`, so `--by-path` does not
trust one by location alone. `install-agent` pins the url, repo and mode of the parent session's
own config (or `--url`, `--repo` and `--mode` when the parent has none) into the worker definition
as `hook --by-path --url U --repo R --mode M`. A `--by-path` hook coordinates only a checkout whose
config has exactly that url, repo and mode (mode defaults to `enforce`). Any other checkout is
logged (`hook --by-path refused`) and not coordinated (on `PreToolUse` the agent is told so; the
edit is not blocked), and an unpinned `--by-path` hook trusts
nothing. Re-run `install-agent` after changing the coordinator. Under `--by-path`:

- `WEFT_URL`, `WEFT_ROOT`, `WEFT_MODE` and `WEFT_TOKEN` are ignored: each would move a pinned
  checkout elsewhere, or (`WEFT_TOKEN`, inherited from the parent session) act with the parent's identity.
- `.weft/claude.json` must be a regular file in a real `.weft/` directory (not a symlink to another
  checkout's config).
- The token file must be under the checkout's `.weft/`, which must be a real directory (not a
  symlink); the token path is compared by real path, so a symlink under `.weft/` that points
  outside it is refused. Otherwise the config does not load.
- An edit to a joined checkout's own `.weft/` (its config and token) is denied.

Plain `hook` reads none of this: no pin, the env overrides apply, and `tokenFile` is read as before.

**Bash target.** Under `--by-path`, a Bash command is attributed only through a target it names in
one of these forms, and is otherwise denied before it runs:

- a leading `cd <dir> && ...`, where `<dir>` is an absolute path or a bare `~` / `~/...`
  (an absolute path may be bare, `"…"` without `$`, backquote or `\`, or `'…'` taken literally; a
  quoted `~` is not expanded by the shell, so it is refused, and `$`, backquote or `\` inside `"…"`
  would be expanded or unescaped by the shell, so they are refused rather than decoded);
- a leading `git -C <dir> <subcommand> ...`, with the same `<dir>` forms; the subcommand must come
  right after `<dir>` (a second `-C`, `--work-tree`, `--git-dir` or `-c` there could move the
  command to another checkout, so it is refused).

Only spaces and tabs separate the words of the leading part: a newline ends a shell command, so
`git -C /wt/a⏎printf x > f` is refused.

Relative paths (`cd src && ...`), `$VAR` or `${VAR}`, a bare path with glob or brace characters
(`*`, `?`, `[`, `{`), a `cd` that is not the first command, and a bare `cd <dir>` without `&&` are
refused, and so is a target that is in no joined checkout (`cd /tmp && …`): it coordinates nothing
while the rest of the command may write a worktree. The deny tells the agent to start the command
with `cd <worktree> &&`. Plain `hook` does not deny Bash.

**Limit:** only the leading target is checked. A later `cd` or path inside the same command
(`cd /wt/a && cd /wt/b && sed -i … f`) is not attributed: the reconcile compares the named
checkout only, so writes the command makes in another checkout are not coordinated. Like every
hook, this constrains a cooperative agent's tool path and is not a sandbox (hooks-core-v0
"Enforcement is advisory against a hostile agent"): a shell command can still rewrite or remove
`.weft/` files.

Not covered yet: the in-session commit and Stop gates still use the parent's checkout for a
subagent's commands; the worktree's git `pre-commit` hook still refuses commits while that worktree
has open errors.

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
