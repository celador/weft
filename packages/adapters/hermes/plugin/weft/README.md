# Weft for Hermes

**Catch agent collisions while the code is being written — before there is a commit to merge.**

Agent A changes `calc_total(items)` to `calc_total(items, opts)`. Agent B is still writing callers
against the old signature. Weft names the changed symbol, the other agent and the event that caused
the conflict, directly in B's tool result. In enforce mode, that stale call-site edit never reaches disk.

This is a Python hook plugin, two agent tools, a `/weft` command, and a Desktop activity pane in one
package. No model calls, prompt replacement, or core overrides. MIT. [Weft / WCP](https://github.com/celador/weft).

## Start locally

Requires Hermes **0.22.5+**, Git, and Node **22+** for the optional local-gateway setup command.
The plugin and its built-in Python analyzer use only Python's standard library; Desktop's optional
backend uses FastAPI already supplied by Hermes. Tested on macOS; Linux is supported. Windows is
not supported by this package's existing Git/auto-land helper.

After the catalog PR is merged: `hermes plugins install weft`. Before admission, install the pinned
Git URL and subdirectory supplied in the catalog PR using `hermes plugins install --help`.

1. In a Git checkout, run `/weft setup`. This explicitly runs
   `npx -y @celador/weft@0.3.0 --yes --no-open --harness watcher --local`.
   It starts a local gateway, creates a paired checkout, and writes `.weft/` metadata.
2. In **Hermes → Plugins → Weft**, save **Agent token** from that checkout's `.weft/token`.
   This is a secret field: Hermes stores it through its credential route and the plugin obtains it
   only with `agent.secret_scope.get_secret("WEFT_AGENT_TOKEN")`. **The plugin never reads the CLI's
   credential file.** Never paste the token into a conversation or a Git commit.
3. Set **Agent id** to `agent` in the first checkout's `.weft/space.json`. For a paired checkout in
   the same Hermes profile, this lets both use that one repo-scoped token; each checkout still
   gets its own WCP task/change/session. Separate profiles can each use their own agent token.
4. `/weft status` confirms the gateway is connected. `/weft mode enforce` turns on pre-edit blocking.
   Start a Hermes session in each checkout. Both should be open before making the first edit.

Until a token is configured and a checkout is linked, the plugin is silent. It does not scan
`~/github`, `~/code`, or any other project directory by default. One Hermes profile's configured
token authorizes one Weft repository; use separate profiles for separate repositories.

**Hosted is opt-in:** `/weft setup hosted` instead of step 1 creates a space on
`https://weft-hosted.elier.ai`. Your edit diffs then leave your machine.
For a self-hosted gateway, run `/weft trust https://your-gateway` before using its checkout metadata.
A cloned repository cannot silently redirect edits to an arbitrary server.

Advanced: set `gateway_url`, `repo`, `agent`, and `project_dirs` (explicit checkout paths or their
parent directory) instead of using `.weft/space.json`. Save the same **Agent token** secret. All
settings are under `plugins.entries.weft.settings`; secrets are never values in that mapping.

## Surfaces

| Surface | What it does |
|---|---|
| `weft_status` tool | Current checkout, reachability, recent verdicts, open conflicts, locally visible peers |
| `weft_inbox` tool | Drain and acknowledge updates/negotiation messages without waiting for the next edit |
| `/weft status` | Human-readable version of status |
| `/weft setup [local\|hosted]` | Explicit, bounded setup using the pinned Weft CLI |
| `/weft mode advise\|enforce` | Switch reporting mode without restarting |
| `/weft feed` | Full shared-feed URL and a one-use pairing code |
| `/weft trust <url>` | Explicitly allow your self-hosted gateway |
| Desktop **Weft** pane | Current checkout's conflicts and activity, or live local sessions when no checkout matches |

The pane uses only the Desktop SDK. It reads local snapshots through its authenticated plugin
backend every five seconds; it does **not** poll the Weft gateway or wake cloud repository objects.
Peers shown by the pane/tools are Hermes processes visible on this host, not a global peer directory.
`/weft feed` provides the gateway's shared view.

## Coordination and limits

- **Advise (default):** never blocks edits; analysis/submission runs in a daemon worker and diagnostics
  ride with later tool results. There can be a delay.
- **Enforce:** checks `write_file` and replace-mode `patch` before execution. Errors reject the edit.
  In-flight soft-claim overlaps remain **warnings**, not blanket file locks. Terminal/V4A edits are
  observed after execution, not prevented. Commit/task-completion interception refuses while errors
  remain; a third repeated refusal is an explicit retreat/release, not an unbreakable policy gate.
- **Fail open:** an unavailable gateway does not stop coding. Status marks it unreachable;
  a circuit breaker avoids repeated slow requests. This is coordination, not a security boundary.
- **Analysis:** bundled standard-library Python AST analysis produces declaration keys, signature/body
  changes and heuristic in-checkout import dependencies. Other languages use whole-file keys
  (`path#*`): no inferred cross-file dependencies. No download/build is needed at plugin load.
  An optional locally built `analyze.mjs` (the `analyzer` setting) supplies the full Weft analyzer,
  which adds declaration-level analysis for TypeScript/JavaScript, Go, Rust, Java, Kotlin, Swift,
  C#, Ruby, PHP, C and C++ (12 languages with Python); it is never fetched by this plugin. Dynamic imports, shadowed names and runtime call graphs are not fully modeled.
- Use separate Git checkouts/worktrees for separate agents. Sessions in the **same checkout** share
  a route; they are not independent coordinateable editors. Tools running inside remote containers
  whose files are unavailable on the plugin host are not observed.

## Security / behavior disclosure

- **Network:** WCP hello, edit/check submissions, inbox, heartbeat, gate and bye go only to the selected
  gateway. Local loopback is the setup default. Hosted is an explicit choice. Submissions include
  filenames, symbol reads/writes, diffs, agent/change identity and task intent; treat them as source
  code. When a diagnostic says another agent changed a declaration this agent uses
  (`stale_assumption`, `stale_overwrite`, `contract_changed`), the plugin reads that one causing event
  from the same gateway and repo (`GET /v1/repos/<repo>/events/<seq>`, with the agent token; the
  gateway redacts secret-looking strings in diffs) and shows the model the new declaration plus at
  most 30 lines of that event's diff for the symbol's file. That is the other agent's code entering
  this agent's context, from the same repo only; files under the exclusions below are never quoted. No analytics/telemetry is added by this plugin; the optional CLI child explicitly disables Wrangler metrics. Gateway usage accounting is separate from
  optional analytics; see [Weft privacy](https://weft.mx/privacy).
- **Reads outside the plugin:** linked checkout files (max 512 KiB/file), Git metadata/status/HEAD,
  non-secret `.weft/space.json`, and optional task title/priority from the read-only Kanban DB.
  `.git`, `.weft`, `.hermes`, `.ssh`, `.env*`, common key containers, dependencies, caches and build
  outputs are excluded from edit reporting. This is not a general secret detector for arbitrary code.
- **Credentials:** catalog code reads its declared agent token only through Hermes secret scope.
  It does not read `.env`, `auth.json`, keychains, or CLI token files. No OAuth logic or provider tokens.
- **Commands:** bounded Git inspection; optional Node analyzer only at the user-configured path.
  `/weft setup` and `/weft feed` invoke the pinned npm CLI with stdin closed and a timeout (240s/60s).
  Setup downloads the official CLI/dependencies through npm, starts Weft's local Wrangler gateway
  in the background, creates a paired Git worktree, and installs the CLI's watcher/Git hooks. It may
  write Weft's own CLI credential files; the plugin does not read them. No subprocess starts at plugin
  registration. Setup/feed run only when the person invokes those slash commands, never via an agent tool.
- **Background:** session hello, a heartbeat thread, advisory submission worker, and optional persistent
  analyzer child. Setup's local gateway is owned by the CLI and outlives the chat. Stop it with
  `npx -y @celador/weft@0.3.0 local stop` in that repository; use its `uninstall --help` for cleanup.
- **Storage:** mode-600 local activity snapshots and bounded logs under `~/.cache/weft-hermes`
  (`WEFT_HERMES_CACHE` overrides it). Snapshots contain paths, symbol keys and diagnostic text,
  not source diffs or tokens; same-host Hermes processes can see each other's snapshots. Dead
  snapshots older than a day are pruned when read. Remove that directory to clear local history.
- **Legacy development install:** `scripts/install.py` (outside this catalog subdirectory) optionally
  supplies `legacy_config.py`, a multi-repo file-based credential reader and auto-land configuration.
  It is **not shipped in the catalog tree**, cannot activate there, and the catalog does not install
  itself over that development distribution. Existing development installs remain unchanged.

## Verification

From the monorepo root:

```sh
hermes plugins validate packages/adapters/hermes/plugin/weft --install-deps
hermes plugins doctor packages/adapters/hermes/plugin/weft --ci
cd packages/adapters/hermes
python3 -m unittest discover -s tests
python3 tests/e2e_catalog.py
```

The live E2E uses two real Hermes session identities and `model_tools.handle_function_call` against
a real throwaway local gateway, with no model inference: a cross-file stale-signature edit is blocked
before disk write, and a same-file in-flight overlap receives its soft-claim diagnostic. It uses
isolated Hermes/Weft homes and does not enable, replace or restart your installed plugin.
