# @weft/adapter-hermes

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
| `pre_tool_call` | `terminal` in scope | snapshot dirty files + HEAD; a `git commit` command first asks `gate commit` |
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

### Projects and scope

Every Hermes profile reports edits in **every project**, one Weft repo per project:

- a project is a git repo directly under `~/github` or `~/code`; its Weft repo is the directory
  name (sanitized to `[A-Za-z0-9._-]`, e.g. `~/github/cto` → `cto`);
- its `.worktrees/*` (kanban worktrees) and any linked `git worktree` elsewhere whose common git
  dir is the project resolve to the same repo, with worktree-relative paths (all worktrees share keys);
- explicit `roots` (`{path, prefix, repo}`) override discovery;
- never reported: anything under `~/.hermes` (kanban scratch workspaces, skills, config),
  `.git`, `node_modules`, caches and build outputs (`dist`, `build`, `.next`, `target`,
  `DerivedData`, `.venv`, …), and paths outside a project.

`WeftRouter` keeps one `WeftAdapter` (= one WCP session) per repo, created on the first in-scope
tool call. A project that has no token for the profile (no Weft repo yet) is a no-op with one log
line per process; `install.py --sync` adds it.

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
(`RELOAD_EVERY_S`), so a synced project starts reporting within a minute, no restart. New plugin
*code* reaches the gateway through `install.py` (when the code changed it runs `plugins disable`
+ `enable`, which makes the gateway force-reload plugins; the old router closes its sessions on
unload) or a gateway restart.
Relative tool paths resolve against the Hermes session's cwd, not the gateway's own cwd.

Uninstall: `hermes plugins disable weft` per profile, deletes `<profile home>/plugins/weft/`,
revokes the profile's tokens (`DELETE /v1/admin/tokens/<id>`), removes it from the config file
(and the file when empty). Weft repos are kept. Manual equivalent: `hermes [-p P] plugins disable
weft && rm -rf <home>/plugins/weft`, then `rm ~/.config/weft/hermes-adapter.json`.

Overrides: `WEFT_HERMES_CONFIG`, `WEFT_HERMES_URL`, `WEFT_HERMES_TOKEN`, `WEFT_HERMES_MODE`,
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
