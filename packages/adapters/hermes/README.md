# @weft/adapter-hermes

For ordinary users and catalog reviewers, start with [Weft for Hermes](plugin/weft/README.md):
local-first, configurable checkout linking, Hermes-managed credentials, tools, `/weft`, Desktop pane.
The remainder of this document describes the **separate development installer** used for Weft's
own multi-profile build. It is not the catalog setup path; its optional `installer/legacy_config.py`
is copied only by `scripts/install.py` and is absent from the catalog subdirectory.

WCP v0.1 adapter for [Hermes Agent](https://hermes-agent.nousresearch.com/docs): a Python plugin
that puts Hermes' tool calls on the Weft log and Weft's diagnostics back into the agent's run.
It is how Weft's own build (Hermes kanban workers on the `weft` board) is coordinated by Weft, and
how every edit by every Hermes profile in every one of John's projects reaches the Weft change log.

Declared capability: **L3** (`observe: sync`, `inject: immediate`, `deny_edit`, `refuse_stop`,
`commit_gate: tool_interception`).

## Hook mapping

| Hermes hook | Tool / condition | WCP |
|---|---|---|
| `pre_tool_call` | `write_file`, `patch` (replace mode) | analyze proposed before/after → `submit mode:"check"`; `reject` → `{"action":"block","message": verdict.context}` (L2) |
| `pre_tool_call` | `terminal`, `execute_code` in scope | snapshot dirty files + HEAD of every worktree the call can change (see below); a `git commit` command first asks `gate commit` |
| `pre_tool_call` / `post_tool_call` | `terminal`, `execute_code` (any workdir) | HEAD of every worktree the session works in + trunk tips; HEAD moved → `checkpoint {sha, x_work}`; trunk moved → auto-land (`land.py`, detached) |
| `pre_tool_call` | `kanban_complete`, `kanban_request_review` | auto-land check (detached); `gate stop`; refused → block with the rendered open errors (L3) |
| `post_tool_call` | any edit above, `patch` V4A mode, terminal-made changes | real before/after → `submit mode:"commit"` (diff, reads, writes) |
| `post_tool_call` | other tools, session open | `inbox.drain` at most every 20 s |
| `transform_tool_result` | queued verdict/inbox context | adds `weft_diagnostics` to the JSON tool result (or appends text) — L1 |
| `pre_verify` | session open | `gate stop`; refused → `{"action":"continue"}` (L3, bounded by `agent.max_verify_nudges`) |

Base and inbox (spec §5.2, §5.4): `base_seq` advances only to a `delivered_through` whose context
was actually passed to the model (block message or tool-result injection), and the inbox is acked
up to the ids injected. A `trunk` item with `requires_rebase` caps the base below the landing until
the worktree gets a new commit.

Quoting the cause: in separate worktrees the other agent's change is not in this checkout, so
"re-read the cited symbol" would re-read the old code. For `stale_assumption`, `stale_overwrite` and
`contract_changed` the adapter fetches the causing event (`GET /repos/{repo}/events/{seq}`, the
agent token's `observe` scope; space tokens carry it, and so do `install.py` tokens minted from
this version on) and appends the new
declaration and at most 30 lines of that event's diff for the symbol's file (never for excluded
paths). It also says whether this checkout already has the change. An unchanged retry of an edit
just blocked for `stale_assumption`/`stale_overwrite` is blocked once more, locally, with the same
quote; a second unchanged retry goes to the coordinator (the agent's deliberate call, §5.2).

Advice text (issue #15): the block, gate-refusal and `pre_verify` messages end with
`BLOCKED_EDIT_ADVICE` / `OPEN_ERROR_ADVICE`, byte-identical to `@weft/protocol`'s (pinned by
`src/advice-text.test.ts`). They defer to each error's suggestion, which carries the repo's
`conflicts` mode: update the code under `hold`, stop and report to the owner when the suggestion
says the other agent owns the conflict (`continue`). The plugin never tells an agent by itself to
re-read and adapt to another agent's change; re-editing is what the suggestion asks for, or what
the agent's own earlier edit needs.

Identity: agent `hermes-<profile>` (one repo-scoped token per profile and repo), change
`hermes-<profile>/<kanban task id>` (`adhoc-<session>` outside kanban), task title/priority read
from the kanban DB (`HERMES_KANBAN_DB`) and used as `intent` / `summary_hint`.

Keys: every language `@weft/analyzer` knows gets declaration keys (`shop/pricing.py#calc_total`,
`src/a.ts#Cart.total`). The analyzer is bundled to `analyze.mjs` with the tree-sitter grammars in
`grammars/` next to it, and runs as one persistent `node … --serve` child per Hermes process.
TS/JS go through the TypeScript backend plus cross-file reads from relative imports
(`src/analyze-cli.ts#importReads`); Python and every other tree-sitter language go through
`analyzeSource`, with imports resolved against the checkout. At start the plugin asks the bundle
which extensions it analyzes (`node analyze.mjs --languages`), so a new language needs no Python
change. Other files get a whole-file key `path#*`.

Node: the configured `node` (or, unset, the first of `/opt/homebrew/opt/node@24/bin/node`,
`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `node` on PATH) is probed once per process
(`node -p process.versions.node`, >= 22): an existing binary can abort in dyld after a `brew
upgrade` of one of its dylibs. A broken one is skipped with one log line (`node <path> is broken:
<first stderr line>; using <fallback>`). If the `--serve` child still dies before answering twice
in a row, the node is re-probed and switched; with no working node (or a bundle that dies at
start) the analyzer pauses 300 s and re-probes, so a fixed node needs no gateway restart. The
child's stderr first line is logged when it dies. `install.py` writes only a probed node.

### Projects and scope

Every Hermes profile reports edits in **every project**, one Weft repo per project:

- a project is a git repo directly under one of the project dirs (`projects.dirs` in the config,
  set with `install.py --project-dirs`; default `~/github,~/code`);
- a checkout that `npx @celador/weft` already registered keeps the repo named in its
  `.weft/space.json` (`<space>-<folder>`), so its Hermes and Claude Code edits share one feed.
  That file sits in the checkout the agent edits, so it only ever names a repo (never a gateway,
  token or mode): `install.py --sync` ignores one git tracks (it came with a clone), and before a
  sync the plugin accepts the name only when it is a repo the config already has and the folder
  name is not;
  any other project's Weft repo is the directory name (sanitized to `[A-Za-z0-9._-]`, e.g.
  `~/github/cto` → `cto`);
- its `.worktrees/*` (kanban worktrees) and any linked `git worktree` elsewhere whose common git
  dir is the project resolve to the same repo, with worktree-relative paths (all worktrees share keys);
- explicit `roots` (`{path, prefix, repo}`) override discovery;
- never reported: anything under `~/.hermes` (kanban scratch workspaces, skills, config),
  `.git`, `node_modules`, caches and build outputs (`dist`, `build`, `.next`, `target`,
  `DerivedData`, `.venv`, …), and paths outside a project.

`WeftRouter` keeps one `WeftAdapter` (= one WCP session) per (repo, Hermes conversation), created
on the first in-scope tool call. The conversation comes from each hook call's own ids
(`conversation_id`, else `session_id` mapped back to its conversation, else `task_id`), never
from process state: the gateway process runs many chats at once, and each chat's edits are
reported as its own change (`hermes-<profile>/adhoc-<conversation>`). A kanban worker (or a
pinned candidate run) is one task for the whole process. A conversation's sessions close on
`on_session_finalize`, or after 2 h without a tool call (no heartbeats for a quiet chat).
A project that has no token for the profile (no Weft repo yet) is a no-op with one log line per
process; `install.py --sync` adds it.

Terminal calls are located by their leading `cd <abs path> &&` or `git [opts] -C <abs path>
[opts] <subcommand>` target (the Claude Code adapter's Bash forms, plus `'\''` quoting, git
global options and leading blank lines) and by `workdir` (else the session's cwd): `cd
~/github/x/.worktrees/t && rm f` run from another worktree's session edits `t`. Capture does
not depend on that parse being complete. Around every `terminal` and `execute_code` call the
adapter snapshots (`git status` plus a stat signature of every dirty file, in parallel):

- **named**: those directories, plus every directory a literal path in the command names
  (absolute, `~`, `$HOME`, or relative to its cwd);
- **own**: every worktree the conversation worked in before, whatever the command says (a
  script or a build can write there without naming it);
- **wide**, when the call is *opaque*: every worktree of every repo the conversation works in,
  plus every project whose folder name the call mentions. A call is opaque when the parse cannot
  vouch for it: a `$`/backquote expansion (`${HOME:-/x}`, `$WT`, `$(...)`), a directory change
  other than the leading one, `..`, an absolute glob, `~user`, inline code (`python3 -c`,
  `node -e`, `eval`, `xargs`, `source`), an unbalanced quote, more than 4096 words or 256
  directories (a bound makes the call opaque; it never drops paths), and every `execute_code`.

An opaque call that mentions `commit` runs the commit gate in every repo it is captured in. A
change in a worktree another live session worked in during the call (same process, or another
Hermes process's status file) is left to that session's own capture, so no change is reported
twice. Measured cost of the wide capture on 4–12 worktrees: about 35 ms before and 35 ms after
the call. What stays out of reach: a program that writes into a repo the conversation never
touched without naming its folder (for example a script that builds the path from data).

Kanban worktrees join the Claude Code adapter: on `on_kanban_worker_spawned` the plugin checks
whether the worker's workspace is a linked git worktree of a checkout with `.weft/claude.json`
and, if so, runs that checkout's adapter (`.weft/bin/weft install --dir <worktree> --task
<kanban task id> --token-from <main token file>`). Claude Code sessions and commits in the
worktree then report as the kanban task. (The dispatcher's `git worktree add` runs with git
hooks off, so a `post-checkout` hook could not do this.) The Claude Code adapter itself stops its
config search at a linked worktree without its own `.weft/claude.json`, so an unjoined worktree's
commits are never stamped with the main checkout's Task-Id / Change-Id; while the main checkout
enforces, its hook refuses edits and commands in such a worktree (except the join command) until
it joins, so `git worktree add` is no way around enforcement. Setting:
`join_worktrees` (default on).

### Modes

Per repo: `modes` in the config (`{"weft": "enforce"}`), everything else `default_mode`
(`advise`). `WEFT_HERMES_MODE` forces one mode for all repos.

- **enforce**: the full L2/L3 behaviour above (pre-check can block an edit, gates refuse `git
  commit` / completion while errors are open).
- **advise**: never blocks and never waits on the gateway. No pre-check; the commit (analysis +
  submit) runs on a per-repo background worker, and its verdict/diagnostics are injected into a
  later tool result. On process exit the worker gets at most 5 s to flush.

### Failure behaviour

Fail open: transport errors, timeouts (4 s HTTP, 6 s analyzer) and bugs let the tool run; they are
logged to `~/.cache/weft-hermes/<profile>.log`. (Hermes fails a *timed-out* `pre_tool_call` closed,
which is why everything is bounded well under `plugins.hook_callback_timeout`.) A **circuit
breaker** per gateway URL (shared by all repo sessions in the process) opens on a transport error
or 5xx: for `breaker_cooldown_s` (default 300) every call fails instantly, then one trial call is
let through. A dead or hung gateway therefore costs at most one timeout per 5 minutes, and in
advise repos not even that lands on the tool-call path. Expired sessions are re-opened
transparently (`410` → new `hello`); a daemon thread heartbeats while a session lives.

A completion refused for the same open errors twice is treated as a deliberate retreat on the
third attempt: the adapter submits a `release` for those keys (visible in the feed) and lets it
through, so a worker can never be wedged by an error it chose not to fix.

## Install / sync / remove

```sh
python3 packages/adapters/hermes/scripts/install.py              # all profiles, all projects
python3 packages/adapters/hermes/scripts/install.py --sync       # new projects/profiles: repos + tokens only
python3 packages/adapters/hermes/scripts/install.py --status
python3 packages/adapters/hermes/scripts/install.py --uninstall  # reverses everything below
```

Flags: `--project-dirs DIR,DIR` (saved absolute in `projects.dirs`; later runs reuse it);
`--url` = the gateway address the plugin on this Mac uses (loopback for a local gateway, e.g.
`http://127.0.0.1:7878`), `--public-url` = the same gateway's address for other devices (e.g. a
tailnet URL the Otto relay hands to phones; `''` removes it). Both are saved (`url`,
`public_url`) and kept by later runs. With no `--url` and none configured, a running local
gateway (`npx @celador/weft`) is preferred over the hosted preview, and a loopback `--url` on its
port uses that gateway's admin token. An admin token is sent to a loopback URL only when every
process listening on that port runs as you: a `/v1/health` answer alone proves nothing, since
any local user can bind the port while the gateway is down. Linux reads `/proc/net/tcp`. macOS
reads its own processes' sockets through libproc in-process (no `lsof`: on a hung mount it never
returns, even with `-b`) and connects to each address the URL resolves to; a connection whose
accepted end none of your processes holds is another user's listener, and the token is refused.
Elsewhere `lsof` runs with a timeout and is abandoned, never waited for, when it hangs. URLs
compare with scheme and host case ignored. Moving between the two addresses of one gateway keeps every token
and re-keys the shared human token (`otto-human-token.json`) to `public_url or url`, the key
clients look it up under. A config whose `url` is the public address while `WEFT_HERMES_URL`
(env or `~/.hermes/.env`) points at a healthy loopback gateway is migrated to `url` = loopback,
`public_url` = the old `url`. `--no-build` uses the bundle already in `dist/` (or `--build-dir`)
after the usual probe; a package dir you cannot write is built into a temp dir instead, so a
read-only checkout (another account's) installs as is. The config also gets `plugin`
(`{installed, version, profiles, installed_at}`, no secrets) for the relay.

Install (idempotent): builds `dist/analyze.mjs`; **sync** — discovers projects, creates each
missing Weft repo (`POST /v1/admin/repos`, admin token from `~/.config/weft/preview-admin-token`)
and issues one agent token per (profile, repo) (`POST /v1/admin/tokens`, agent
`hermes-<profile>`; agent tokens are single-repo by protocol §3); writes
`~/.config/weft/hermes-adapter.json` (mode 600: url, projects map, modes, per-profile tokens);
backs up every profile's `config.yaml` to `~/.hermes/cache/backups/weft-plugins-<date>/`; copies
`plugin/weft/*` + `analyze.mjs` to `<profile home>/plugins/weft/` with an `INSTALLED.json`
manifest; runs `hermes [-p <profile>] plugins enable weft --no-allow-tool-override`.

The admin token never enters an agent process: the plugin only reads its own tokens. A project
created after install is skipped until someone runs `install.py --sync` (John, or the PM).
Kanban workers are fresh processes and read the config at start. Every `hermes` / `hermes chat`
turn (`-q`/`-Q` one-shots included) runs inside the long-lived gateway process, not the CLI
process: there the plugin re-reads the config for an unknown project at most once a minute
(`RELOAD_EVERY_S`), so a synced project starts reporting within a minute, no restart. That
includes a project outside the project dirs (an explicit `roots` entry or a `projects.repos`
path anywhere on disk): an edit in no known project triggers the same rate-limited re-read, which
refreshes `roots` too. A `projects.repos` path resolves wherever it lives. New plugin
*code* reaches the gateway through `install.py` (when the code changed it runs `plugins disable`
+ `enable`, which makes the gateway force-reload plugins; the old router closes its sessions on
unload) or a gateway restart.
Relative tool paths resolve against the Hermes session's cwd, not the gateway's own cwd.

Uninstall: `hermes plugins disable weft` per profile, deletes `<profile home>/plugins/weft/`,
revokes the profile's tokens (`DELETE /v1/admin/tokens/<id>`), removes it from the config file
(and the file when empty). Weft repos are kept. Manual equivalent: `hermes [-p P] plugins disable
weft && rm -rf <home>/plugins/weft`, then `rm ~/.config/weft/hermes-adapter.json`.

Overrides (none needed for a normal install): `WEFT_HERMES_CONFIG`, `WEFT_HERMES_URL` (wins over
the config's `url`), `WEFT_HERMES_TOKEN`, `WEFT_HERMES_MODE`,
`WEFT_HERMES_CACHE`.

## Tests

```sh
pnpm --filter @weft/adapter-hermes test        # bundle + vitest (analyzer bridge) + python unittest (hooks, project resolution, modes, breaker; fake WCP)
python3 packages/adapters/hermes/scripts/verify_live.py   # two adapters vs the deployed gateway (throwaway smoke-hermes-* repo)
```

## Landing (PM merges → `land`)

Since adapter 0.3 the plugin lands by itself (auto-land): when a session sees its repo's trunk
move, it spawns `plugin/weft/land.py`, which lands every change whose newest work commit (from the
change's own `checkpoint` records, not branch names) is on trunk, in every registered repo. Details:
docs/runbook.md "Auto-land". `scripts/weft_land.py` stays for manual catch-up and backfill
(`--all-repos --since <date> [--dry-run]`).

Weft's build merges kanban branches with `git merge`, outside Weft. `scripts/weft_land.py` appends
the system `land` for each merged change so its claims are released and other cards get
`trunk_advanced`: run it after every merge into main (`--recent N` to catch up, `--dry-run` to
preview). Details, token and log: docs/runbook.md "PM landings → Weft land". Live check:
`scripts/verify_land_live.py`. B8's landing queue replaces it.
