# Weft in every harness: coverage map

Status: research snapshot, 2026-10-22. Card `t_13086853`. Owners of follow-up work: the phase 2
cards listed in [§8](#8-phase-2-cards).

Goal: every coding agent, in any harness, gets coordinated by Weft. Every human watching those
agents gets the experience Otto has today: a live Changes feed across repos, a diff for every
event, an "Editing now" row per running task, squiggles that link to the edit that caused them,
and one-tap Approve / Undo / Pause / Resume / Message.

Levels are the ones in [WCP §8.1](protocol/wcp-v0.md#81-capability-levels) and
[Hooks Core §3](protocol/hooks-core-v0.md): **L0** observe, **L1** inject model-visible text,
**L2** deny an edit before it runs (with a reason the model sees), **L3** refuse the agent's stop.
A claim marked *documented* comes from the vendor's docs. A claim marked *verified* was run
against the real harness. Claims marked *(secondary)* rely on a third-party write-up because the
vendor's docs don't say. Treat those as leads to probe, not as facts.

## 1. The coverage table

Tier **a** is a native hook adapter, **b** is the Weft MCP server, **c** is the file watcher (or,
for cloud agents, git push events). **d** is an ACP proxy, which is experimental (§5.4).
"Best level" is the most the harness's surface allows. "Today" is what Weft ships now.

| Harness | Kind | Best level (surface) | Tier | Weft today | Next |
|---|---|---|---|---|---|
| Claude Code | CLI/IDE | L3 hooks | a | **L3 verified** (`adapter-claude-code`) | — |
| OpenAI Codex CLI | CLI | L3 hooks | a | **L0–L2 verified** (`adapter-codex`) | re-probe the L3 Stop |
| OpenCode | CLI | L3 plugin | a | **L3 verified** (`adapter-opencode`) | — |
| Hermes Agent | CLI | L3 plugin | a | **L3**, used on Weft's own build (`adapter-hermes`) | — |
| Cursor CLI + Cursor IDE | CLI/IDE | L3 hooks (same `.cursor/hooks.json`) | a | L3 fixture-tested (`adapter-cursor`); live run blocked on login | live run |
| Gemini CLI | CLI | L3 hooks | a | L3 fixture-tested (`adapter-gemini`) | low priority: the free tier moved to Antigravity |
| **GitHub Copilot** (CLI, cloud coding agent, VS Code agent mode) | CLI/IDE/cloud | L3 hooks | a | watcher only | **card: Copilot adapter** |
| **Google Antigravity** (2.0, CLI, IDE) | CLI/IDE | L3 hooks | a | watcher only | **card: Antigravity adapter** |
| **Windsurf / Devin Desktop** (Cascade) | IDE | L2 hooks | a | watcher only | **card: Windsurf adapter** |
| Cline (extension + CLI) | IDE/CLI | L2 hooks (+ next-turn context) | a | watcher only | queued (adapter #4) |
| Goose | CLI/desktop | L3 hooks | a | watcher only | queued (adapter #5; AAIF project) |
| Factory Droid CLI | CLI | L3 hooks (Claude-compatible) | a | watcher only | Claude-dialect profile (§4.2) |
| Qwen Code | CLI | L3 hooks (Claude-like) | a | watcher only | Claude-dialect profile |
| Augment Auggie CLI + IDE | CLI/IDE | L3 hooks (Claude-style) | a | watcher only | Claude-dialect profile |
| Kimi CLI | CLI | L3 hooks (Claude-style, TOML config) | a | watcher only | Claude-dialect profile |
| Continue `cn` CLI | CLI | L3 hooks (reads `.claude/` settings) | a | watcher only | Claude-dialect profile |
| Crush | CLI | L2 (PreToolUse only) | a | watcher only | Claude-dialect profile |
| Kiro (IDE + CLI) | IDE/CLI | L3 hooks (CLI documented) | a | watcher only | later |
| Amp | CLI | L3 TS plugin API | a | watcher only | later (plugin, like OpenCode) |
| Kilo Code (CLI + extension) | CLI/IDE | L2 plugin (OpenCode-style) | a | watcher only | later (reuse the OpenCode plugin) |
| VS Code (any agent) | IDE | squiggles via the Problems panel | b + UI | — | **card: VS Code extension** |
| Zed agent panel | IDE | MCP only (no hooks yet) | b, d | `@weft/mcp` (L0 + delayed L1); Zed config in its README, not yet run in Zed | live Zed run (needs a Zed sign-in or API key); ACP proxy later |
| JetBrains Junie / AI Assistant | IDE | MCP + ACP host; no tool hooks | b, d | `@weft/mcp` (config in its README) | live run; plugin later |
| Warp agent | terminal | MCP only | b | `@weft/mcp` (`.warp/.mcp.json` in its README) | live run (needs a Warp login) |
| Trae | IDE | MCP only (hooks undocumented) | b | `@weft/mcp` | live run |
| Xcode coding intelligence | IDE | MCP (hooks undocumented) | b | `@weft/mcp` | live run |
| Aider | CLI | L1 via `--lint-cmd` | c (+ lint shim) | watcher only | `weft check` as the lint command |
| Roo Code | IDE | discontinued (May 2026) | c | watcher only | none |
| Claude Code on the web | cloud | L3 (repo `.claude/settings.json` runs) | a | adapter works if the sandbox can reach the gateway | document + probe |
| Cursor cloud agents | cloud | L3 (repo `.cursor/hooks.json` runs) | a | adapter works if egress allows | probe |
| Copilot coding agent | cloud | L2 (repo `.github/hooks/*.json`) | a | — | covered by the Copilot card |
| Devin (cloud) | cloud | L0 push + L1 message API | c | — | GitHub push observer (later) |
| Google Jules | cloud | L0 push + L1 `sendMessage` | c | — | GitHub push observer |
| OpenAI Codex cloud | cloud | L0 push only | c | — | GitHub push observer |
| Factory droids (cloud) | cloud | L0 push + L1 message API | c | — | GitHub push observer |
| Augment remote agents | cloud | L0 push | c | — | GitHub push observer |
| Anything else, humans | any | L0 | c | **verified** (`adapter-watcher`) | — |

What the table says:

- **Hooks have become standard.** 20 of the harnesses above have a pre-tool hook (or in-process
  plugin) that can deny an edit and show the model a reason. The
  [2026-10-03 research note](research/hooks.md) covered five. Native adapters (tier a) are now the main path. MCP (tier b) is for the shrinking set of
  harnesses without hooks.
- **The Claude Code hook shape is the de facto standard.** Copilot, VS Code, Factory, Qwen,
  Augment, Kimi, Continue `cn` and Crush all use `PreToolUse` / `permissionDecision` /
  `additionalContext` / `Stop` with `decision:"block"`, or a close variant. Several of them read
  `.claude/settings.json` directly. A single "Claude-dialect" adapter with per-host profiles
  covers most of them (§4.2).
- **The holdouts use their own dialects:** Cursor, Gemini/Antigravity, Windsurf, Cline, Kiro, and
  the in-process plugin APIs (OpenCode, Kilo, Amp). Writing each adapter is mostly translation,
  200–300 lines on the shared core (see [integrate.md](integrate.md)).

## 2. Tiers

### 2a. Native hook adapter (L1–L3)

The adapter runs inside the harness's hook points and speaks WCP to the gateway: `check` before
an edit, `commit` after it, `drain` the inbox into the next model-visible slot, and gate the stop
and `git commit` ([WCP §8.3](protocol/wcp-v0.md#83-what-adapters-do-at-each-hook-point)).
Use it wherever the harness has a synchronous pre-tool hook. Weft fails open on every adapter.

### 2b. Weft MCP server (cooperative L1, guaranteed L0)

For harnesses with MCP and no hooks (Zed's own agent, Warp, Trae, Xcode, JetBrains' native
agents), and as an extra for everyone else. An MCP server cannot deny the harness's built-in
edit tool. It can only offer tools the model chooses to call. So the server is built to be
useful even when the model ignores it:

- **It embeds the watcher.** Every file change in the checkout is reported to Weft as a `commit`
  edit whatever the model does, so other agents are always checked against this one (L0).
- **Tools** (names fixed by this doc):
  - `weft_check {path, new_content | patch}`: WCP `submit mode:"check"`. Returns the verdict and
    the rendered squiggles.
  - `weft_claim {keys[], firm?}`: WCP claims (§7.5).
  - `weft_status`: open errors, owed negotiations, and who else is editing what.
  - `weft_inbox`: drain and ack.
  - `weft_feed {repo?, limit?}`: recent records, the same rows the feed UIs show.
  - `weft_negotiate {action, ...}`: §7.4.
  - `weft_gate {gate:"stop"|"commit"}`: lets an agent check whether it may finish.
- **Every tool result carries the pending inbox.** Whatever the model calls, it also receives the
  squiggles waiting for it. That is the delayed-L1 delivery path.
- **Server `instructions`** tell the model to call `weft_check` before editing shared code and
  `weft_gate` before declaring the work done. Claude Code puts server instructions into the first
  turn ([third-party test (secondary)](https://claudecodereview.ai/a/claude-code-puts-a-tool-server-s-instructions-in-the-first-user-message-fddc64));
  Codex reportedly demotes them ([openai/codex#29097](https://github.com/openai/codex/issues/29097)).
- **Push where the host supports it.** Claude Code's channels push server events into the session
  ([docs](https://code.claude.com/docs/en/channels), research preview). VS Code shows resource
  updates but only injects them when the resource is attached
  ([docs](https://code.visualstudio.com/docs/copilot/guides/mcp-developer-guide)).
- **Declared capabilities:** `{level: 0, observe: "async", inject: "delayed", deny_edit: false,
  refuse_stop: false, commit_gate: "native"}`. The model *may* see diagnostics, but the
  coordinator must not rely on that, so the level stays 0. That keeps the honesty rule in Hooks
  Core §3.3.

**Status (t_70b3d8fe):** shipped as `packages/mcp` (`@weft/mcp`, bin `weft-mcp`, stdio). The
tools, the inbox on every result, the embedded watcher, `instructions` and the capabilities above
are implemented as specified; Claude Code channels push is behind `--channels`. Token lookup:
`WEFT_TOKEN`, the checkout's `.weft/token`, `~/.config/weft/<repo>.token`, `~/.config/weft/token`.
Verified with a real hookless run: Claude Code with no Weft hooks and only the MCP server
(`demo/mcp-hookless.mjs`, evidence in `demo/evidence/mcp/`) next to a hooked Claude Code agent on
a local gateway. The model called `weft_check`, got `stale_assumption` with the other agent's diff,
adapted its code (in earlier runs it negotiated or escalated first), and its own `Write` reached the
log through the watcher. Zed and Warp were not run: their agents need a Zed sign-in or Warp login (or an
Anthropic API key) that the build machine does not have.

### 2c. File watcher and git push events (L0)

[`adapter-watcher`](../packages/adapters/watcher/README.md) works for any local harness, editor
or human: fs.watch, then diff, then `commit`, plus git's own `pre-commit` gate. Cloud agents
don't have a local checkout to watch, so the equivalent is a **GitHub push observer**: a GitHub
App (or a webhook on the repo) receives `push` events for agent branches, fetches the diff, and
appends the commits as `edit` records under an agent id derived from the branch or author (for
example `copilot-swe-agent`, `devin-ai-integration`, `google-labs-jules`). That gives L0 for
Devin, Jules, Codex cloud, Factory, Augment remote agents, and any future cloud agent that opens
PRs. Four of them also accept follow-up messages through an API, so a push observer can deliver
the squiggles back as a message. That is L1, but delayed by a whole push:

| Cloud agent | Push to GitHub | Follow-up message API | Source |
|---|---|---|---|
| Devin | yes | `POST /v3/organizations/{org}/sessions/{id}/messages` | [docs](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages) |
| Jules | yes (`AUTO_CREATE_PR`) | `POST /v1alpha/sessions/{id}:sendMessage` | [docs](https://jules.google/docs/api/reference/sessions) |
| Cursor cloud agents | yes | `POST /v0/agents/{id}/followup` (+ status webhooks) | [docs](https://cursor.com/docs/cloud-agent/api/v0) |
| Factory droids | not documented | `POST /api/v0/sessions/{id}/messages` | [docs](https://docs.factory.ai/api-reference/sessions) |
| Codex cloud | yes (PR from the UI) | no public API | [docs](https://developers.openai.com/codex/cloud) |
| Copilot coding agent | yes | steering in the UI only; agent tasks REST API (preview) | [docs](https://docs.github.com/en/rest/agent-tasks/agent-tasks) |

Three cloud agents run repo hooks, so the **native adapter runs in the cloud sandbox** if it can
reach the gateway and has a token from the environment's secrets:

- Claude Code on the web runs `.claude/settings.json`. The network must be Custom or Full
  ([docs](https://code.claude.com/docs/en/claude-code-on-the-web),
  [environments](https://code.claude.com/docs/en/cloud-environments)).
- Cursor cloud agents run `.cursor/hooks.json` (`preToolUse`, `afterFileEdit`, `stop`; not
  `sessionStart`). Internet is on by default
  ([hooks](https://cursor.com/docs/reference/hooks),
  [network](https://cursor.com/docs/cloud-agent/security-network)).
- Copilot coding agent runs `.github/hooks/*.json` from the default branch. Its firewall applies
  to processes the agent starts through Bash, and MCP servers are exempt; whether hook commands
  are exempt is not documented, so probe it
  ([hooks](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks),
  [firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall)).

### 2d. ACP proxy (experimental)

The [Agent Client Protocol](https://agentclientprotocol.com/get-started/agents) connects editors
(Zed, JetBrains AI Assistant, Neovim, Emacs, VS Code extensions, Toad...) to agents (Claude via
`claude-agent-acp`, Codex via `codex-acp`, Gemini, Copilot CLI, Goose, OpenCode, Cline, Junie,
Kiro, Qwen, Kimi, Auggie, Droid, Hermes...). The draft
[proxy-chains RFD](https://agentclientprotocol.com/rfds/proxy-chains) and its
[conductor](https://github.com/agentclientprotocol/rust-sdk/blob/main/md/conductor.md) let a proxy
sit between the editor and the agent and intercept messages. A `weft-acp` proxy could:

- see every `session/update` tool call, including diffs (L0);
- answer `session/request_permission` with a reject plus a reason (L2, but **only for edits the
  agent asks permission for**; in auto-approve mode nothing reaches the proxy);
- append text to the prompt on the next turn (L1).

It will not see file writes reliably. `fs/write_text_file` is only used when the client
advertises it, and several agents write to disk directly
([claude-agent-acp#339](https://github.com/agentclientprotocol/claude-agent-acp/issues/339),
[opencode#38196](https://github.com/anomalyco/opencode/issues/38196)). So pair the proxy with the
watcher. Most ACP agents have native hooks anyway, so the proxy is mainly worth building for the
**editor-side feed in Zed and JetBrains** (§3.4), not for enforcement.

## 3. The Otto experience everywhere

### 3.1 What we are bringing over

What Otto does (`~/code/hermes-ios/ios/Hermes/Weft/`), and the observer API each part reads
([WCP §9](protocol/wcp-v0.md#9-observer-and-human-api)):

| Otto feature | Source in Otto | Observer API |
|---|---|---|
| Changes feed across every repo | `ChangesView.swift`, `WeftStore.swift` | `GET /v1/feed` (cursor) + `/v1/feed/stream` / per-repo `stream?after=` with resume (§9.4–9.5) |
| Diff per event | `WeftDiffView.swift`, `WeftEventDetailView.swift` | `GET /v1/repos/{repo}/events/{seq}` (`diff`) |
| "Editing now" per running task | `WeftStrip.swift` (`editingWindow` 3 h, per change since its last `land`) | derived from the feed |
| Squiggle linked to its cause | `ChangesView.swift` (`caused by <agent> · event #N`) | `diagnostics[].caused_by` → `events/{seq}` |
| Approve / Undo / Pause / Resume / Message | `ChangesView.swift` action router | `POST /v1/repos/{repo}/actions` (§9.6), `human` scope |
| Summary line per repo | `WeftSummary.swift` | `GET /v1/repos` (§9.2) |

### 3.2 One shared feed model: `@weft/feed`

Today the feed logic exists three times: Otto (Swift), the web UI (`apps/web/public/lib/model.js`)
and the deck. Decision: **one TypeScript package, `packages/feed` (`@weft/feed`)**, with no DOM
and no Node-only APIs, so it runs in a browser, a VS Code webview, Node (the terminal) and
JetBrains' JCEF. It contains:

1. `ObserverClient`: paging, the per-repo and combined stream with resume and dedupe by `seq`
   (and the `4413` fallback), the opaque cursor, and `act()` for human actions. Takes
   `{baseUrl, token}`.
2. Reducers, ported from Otto's `WeftStrip.swift` / `WeftLog.swift` so every surface agrees:
   `feedRows()`, `editingNow()` (3 h window, per change since its last land), `squiggles()` with
   cause links, `actionsFor(record)` (Undo only on an un-reverted `land`, and so on),
   `repoSummary()`.
3. `renderText()`: the one-line and multi-line text form of a row or squiggle, matching
   `renderContext()` so a squiggle reads the same in a terminal, a panel and a model's context.
4. `@weft/feed/view`: a dependency-free DOM component (the feed list, Editing now, the detail
   pane with a coloured diff, and action buttons) used by the web feed, the VS Code webview and
   the JetBrains tool window. It follows the web UI's CSP rules (no inline script or style).

Otto stays native Swift. Its reducers are the reference, and `@weft/feed` ships fixture tests
taken from real logs, so Otto and the TS port can be checked against the same records.

### 3.3 Where it ships

| Surface | Covers | Feed | Diffs | Squiggles | Actions | Owner |
|---|---|---|---|---|---|---|
| **VS Code extension** "Weft" (VS Code Marketplace + Open VSX) | VS Code, Cursor, Windsurf, Kiro, Antigravity, VSCodium (Open VSX); Trae via `.vsix` | webview view in the panel (`@weft/feed/view`) | native diff editor via a `weft-event:` virtual document | `DiagnosticCollection` on files in the workspace, with related info pointing at the cause | commands and buttons | card (§8) |
| `npx weft feed` | any terminal | live text feed | `weft show <seq>` | coloured lines | `weft approve/undo/pause/resume/msg` | `t_bd602434` (in progress); moves to `@weft/feed` when it lands |
| Web feed (`apps/web`) | any browser, phones | exists | exists | exists | exists | migrate `model.js` to `@weft/feed` later |
| Otto | iOS/iPadOS/macOS | exists | exists | exists | exists | — |
| Zed | Zed | Zed extensions have no webview panels; use the MCP server as a Zed context server and the `weft-lsp` squiggles below | — | via LSP | via MCP tools | later |
| `weft-lsp` (language server publishing Weft diagnostics) | Zed, Neovim, Helix, Emacs, JetBrains (LSP4IJ), Sublime | — | — | `textDocument/publishDiagnostics` | code actions → human actions | later |
| JetBrains plugin | IntelliJ family | tool window hosting `@weft/feed/view` in JCEF | IDE diff viewer | `ExternalAnnotator` ([docs](https://plugins.jetbrains.com/docs/intellij/syntax-highlighting-and-error-highlighting.html)) | actions | later |

Squiggles in the editor do more than inform the human. **They reach the model too.** Copilot agent
mode's `get_errors` tool reads the same diagnostics store as the Problems panel, including
diagnostics published by extensions
([tools reference](https://code.visualstudio.com/docs/agents/reference/tools-reference),
[vscode#326446](https://github.com/microsoft/vscode/issues/326446)). So the extension's
`DiagnosticCollection` acts as cooperative L1 for every VS Code agent that reads diagnostics.
Whether Cursor's and Windsurf's agents read extension diagnostics is not documented; the
extension card probes it. A language server can do the same in any LSP editor, which is why
`weft-lsp` is the universal squiggle carrier.

### 3.4 Auth for the UIs

Every surface reads a token with `observe` scope; actions need `human`. Token sources, in order:
`WEFT_TOKEN` env, then the repo's `.weft/` and `~/.config/weft` written by `npx weft`
(`t_bd602434`), then the editor's secret storage (VS Code `SecretStorage`). The web feed keeps its
server-side token (see [web-ui.md](web-ui.md)).

## 4. Ranking: users × effort

### 4.1 Published reach

| Harness family | Published reach | Source |
|---|---|---|
| GitHub Copilot (all surfaces) | 50M users (Jul 2026), 4.7M paid (Jan 2026) | Microsoft earnings, via [axis-intelligence](https://axis-intelligence.com/github-statistics) (secondary) |
| OpenAI Codex | 5M+ weekly users (Jun 2026) | [OpenAI](https://openai.com/index/codex-for-knowledge-work) |
| Claude Code | about 4M weekly developers (Q1 2026) | [presenc.ai](https://presenc.ai/research/claude-usage-statistics) (secondary) |
| Cursor | 1M+ daily users | [secondary](https://baeseokjae.github.io/posts/cursor-3-review-2026) |
| Gemini CLI → Antigravity | "millions of users", 100k+ stars; the free and individual path moved to Antigravity CLI on 2026-06-18 | [devlery](https://devlery.com/en/blog/google-antigravity-cli-gemini-cli-transition), citing [Google](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) |
| Zed | 92k stars | GitHub |
| Cline | 70.7k stars | GitHub |
| Warp | 65.6k stars | GitHub |
| Goose | 55.5k stars | GitHub |
| Aider | 49.7k stars | GitHub |
| Continue | 36.3k stars | GitHub |
| Crush / Qwen Code / Kilo | 28.8k / 28.7k / 27.7k stars | GitHub |
| Windsurf, Antigravity, Kiro, Amp, Factory, Augment, Trae | not published | — |

### 4.2 Effort

- **S: Claude-dialect profile.** The host already speaks the Claude Code hook shape. Add a
  profile to `adapter-claude-code` (or a thin wrapper) that sets the config path, tool-name map
  and payload casing. Factory, Qwen, Augment, Kimi, Continue `cn` and Crush (L2) are about a day
  each, plus a real run. Copilot is in this family, but it spans three surfaces with camelCase
  and snake_case payloads and a cloud sandbox, so it gets its own card.
- **M: new hook dialect.** A translator onto the shared core, the way `adapter-cursor` and
  `adapter-gemini` work: Antigravity, Windsurf, Cline, Kiro, Goose.
- **L: in-process plugin.** Amp (TS plugin API) and Kilo (OpenCode-style plugins; the OpenCode
  plugin may port almost as-is).
- **Tier b/c work** is one build each that covers many harnesses: the MCP server, the push
  observer, `weft-lsp`.

### 4.3 Order

1. **Copilot adapter** (S/M, 50M users, three surfaces from one adapter, L3).
2. **MCP server** (M, covers every hookless harness, and it is also the agent-facing tool set
   for `npx weft` users).
3. **`@weft/feed` and the VS Code extension** (M+M, the Otto experience for the largest
   editor family, plus model-visible squiggles for Copilot).
4. **Antigravity adapter** (M, Google's successor to Gemini CLI, one hook format for its app,
   CLI and IDE, L3).
5. **Windsurf / Devin Desktop adapter** (M, large IDE install base, L2).
6. Next, without cards yet: Cline (M, L2), Goose (M, L3, an AAIF project), the Claude-dialect
   profiles (S each), the GitHub push observer for cloud agents, `weft-lsp`, the ACP proxy, and
   the JetBrains plugin.

## 5. Per-harness evidence

Each row gives the extension surface, the levels it supports, and sources. Five harnesses were
covered in depth earlier in [research/hooks.md](research/hooks.md): Claude Code, Codex, Gemini
CLI, Cursor and Copilot.

### 5.1 CLIs

| Harness | Surfaces | L2 deny + reason | L1 inject | L3 stop | MCP | ACP | Sources |
|---|---|---|---|---|---|---|---|
| Claude Code | hooks, plugins, MCP | `PreToolUse` deny | `PostToolUse` `additionalContext` | `Stop` block | yes | via `claude-agent-acp` | [hooks](https://code.claude.com/docs/en/hooks) |
| Codex CLI | hooks (`hooks.json`, `config.toml`) | `PreToolUse` on `apply_patch` | `additionalContext` | `Stop` block | yes | via `codex-acp` | [hooks](https://developers.openai.com/codex/hooks) |
| Gemini CLI | hooks, extensions | `BeforeTool` deny | `AfterTool` | `AfterAgent` | yes | native | [hooks](https://geminicli.com/docs/hooks/reference) |
| Cursor CLI | hooks (`.cursor/hooks.json`) | `preToolUse` `permission:"deny"` | `postToolUse` `additional_context` | `stop` `followup_message` | yes | native | [hooks](https://cursor.com/docs/hooks) |
| Copilot CLI | hooks (`.github/hooks`, `~/.copilot/hooks`, also reads `.claude/settings.json`), plugins | `preToolUse` `permissionDecision:"deny"` | `postToolUse` `additionalContext` | `agentStop` block (8-block guard) | yes | preview | [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference), [ACP list](https://agentclientprotocol.com/get-started/agents) |
| OpenCode | in-process JS plugin | `throw` in `tool.execute.before` | append to tool output | `session.idle` → prompt (long-lived only) | yes | native | [research/hooks.md](research/hooks.md#opencode-cursor-cli-gemini-cli-adapter-verification-b12-2026-10-04) |
| Hermes | Python plugin | yes | yes | yes | yes | native | `packages/adapters/hermes` |
| Antigravity CLI | hooks (`.agents/hooks.json`, `~/.gemini/config/hooks.json`) | `PreToolUse` `decision:"deny"` + `reason` | `PreInvocation` `injectSteps` (delayed); `PostToolUse` returns `{}` | `Stop` `decision:"continue"` + `reason` | yes | not documented | [hooks](https://antigravity.google/docs/hooks) |
| Goose | hooks (Open Plugins: `.agents/plugins`), MCP extensions | `PreToolUse` exit 2 or `{decision:block}` | `PostToolUse` injection not documented | `Stop` block | yes | native | [hooks blog](https://goose-docs.ai/blog/2026/05/14/goose-hooks), [extensions](https://block.github.io/goose/docs/getting-started/using-extensions) |
| Amp | TS plugin API, tool permissions with `delegate` | `tool.call` reject + message | `tool.result` | `agent.end` → `continue` | yes | adapters only | [plugin API](https://ampcode.com/manual/plugin-api) |
| Crush | hooks (`PreToolUse` only, "Claude Code-compatible"), LSP | exit 2 + stderr | `context` on pre-hook | no | yes | community adapter | [hooks](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md) |
| Kilo Code CLI | plugin API (OpenCode-style) | `throw` in `tool.execute.before` | not documented | not documented | yes | `kilo acp` | [plugins](https://kilo.ai/docs/automate/extending/plugins) |
| Cline CLI | script hooks (`.clinerules/hooks/<Event>`) | `PreToolUse` `{cancel:true}` (`errorMessage` shown to the user) | `contextModification` on the next turn | no (TaskComplete is observe-only) | yes | `--acp` | [hooks](https://docs.cline.bot/customization/hooks) |
| Qwen Code | hooks (command, http, prompt, agent) | `permissionDecision:"deny"` | `additionalContext` | `Stop` (cap setting) | yes | native | [hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks) |
| Factory Droid | hooks (Claude-compatible), plugins | `permissionDecision:"deny"` | `additionalContext` | `Stop` continue | yes | native | [hooks](https://docs.factory.ai/harness/hooks) |
| Auggie (Augment) | hooks (`settings.json`) | `permissionDecision:"deny"` | `additionalContext` | `Stop` block | yes | native | [hooks](https://docs.augmentcode.com/cli/hooks) |
| Kimi CLI | hooks (TOML) | exit 2 or `permissionDecision:"deny"` | stdout on exit 0 | `Stop` block | yes | `kimi acp` | [hooks](https://kimi-cli.com/en/customization/hooks.html) |
| Continue `cn` | hooks (Claude-compatible; reads `.claude/`) | exit 2 | `hookSpecificOutput` | `Stop` | yes | not documented | [continue#11115](https://github.com/continuedev/continue/issues/11115) |
| Aider | `--lint-cmd`, `--test-cmd` | no | lint output fed back on a non-zero exit | no | no (unmerged PR) | no | [lint/test](https://aider.chat/docs/usage/lint-test.html) |
| Warp agent | MCP, rules, static allow/deny lists | no | no | no | yes | community only | [MCP](https://docs.warp.dev/agents/capabilities/mcp) |
| Kiro CLI | hooks | Pre Tool Use exit 2 | not documented | `stop` block → new user message | yes | native | [hooks](https://kiro.dev/docs/hooks/types) |

### 5.2 IDE agents

| Harness | Surfaces | L2 | L1 | L3 | VS Code extension host? | Sources |
|---|---|---|---|---|---|---|
| Cursor IDE | same hooks as the CLI | yes | yes | yes | yes (Open VSX) | [hooks](https://cursor.com/docs/hooks) |
| VS Code + Copilot agent mode | Local agent hooks (accepts Copilot- and Claude-format files), MCP, LM Tools API, `get_errors` | `PreToolUse` deny / exit 2 → stderr to the model | `PostToolUse` `additionalContext` | `Stop` block | — | [Local hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference), [tools](https://code.visualstudio.com/docs/agents/reference/tools-reference) |
| Windsurf / Devin Desktop (Cascade) | hooks (`.devin/hooks.json`, legacy `.windsurf/hooks.json`, `~/.codeium/windsurf/hooks.json`), MCP | `pre_write_code` exit 2; "the Cascade agent will see the error message from stderr"; input carries `file_path` + `edits[{old_string,new_string}]` | not documented (post hooks can't block) | not documented | yes (Open VSX) | [hooks](https://docs.devin.ai/desktop/cascade/hooks) |
| Antigravity IDE / 2.0 | same hooks as the CLI | yes | delayed (`injectSteps`) | yes | yes (Open VSX, inferred) | [hooks](https://antigravity.google/docs/hooks) |
| Cline extension | same hooks as the CLI (off by default; macOS/Linux) | yes | next turn | no | is an extension | [hooks](https://docs.cline.bot/customization/hooks) |
| Kiro IDE | agent hooks, MCP, Powers | Pre Tool Use | not documented | IDE semantics not documented | yes (Open VSX, inferred) | [hooks](https://kiro.dev/docs/hooks) |
| Augment (VS Code/JetBrains) | hooks shared with Auggie | yes (CLI docs) | yes | yes | is an extension | [changelog](https://augmentcode.com/changelog/vscode-0-890-2-stable-release-notes) |
| Zed agent panel | MCP, ACP host, static `tool_permissions` | no (hooks requested in [zed#52688](https://github.com/zed-industries/zed/issues/52688)) | MCP only | no | no | [MCP](https://zed.dev/docs/ai/mcp), [external agents](https://zed.dev/docs/ai/external-agents) |
| JetBrains Junie / AI Assistant | MCP, ACP host (Codex, Claude Agent, Junie bundled); Junie hooks are startup-only | no | MCP only | no | no | [ACP](https://jetbrains.com/help/ai-assistant/acp.html), [Junie hooks](https://junie.jetbrains.com/docs/junie-cli-hooks.html) |
| Xcode 26.3+ | Xcode is an MCP server for external agents; built-in Claude Agent and Codex have config dirs | not documented | MCP only | not documented | no | [Apple](https://developer.apple.com/videos/play/tech-talks/111428) |
| Trae | MCP, rules | not documented | MCP only | — | own store + `.vsix` | [secondary](https://github.com/anthony-chaudhary/dos-kernel/blob/master/docs/294_trae-advisory-only-the-host-with-no-hook-seam.md) |
| Continue extension | MCP | no | MCP only | no | is an extension | [MCP](https://docs.continue.dev/customize/deep-dives/mcp) |
| Roo Code | discontinued 2026-05-15 | — | — | — | — | [announcement](https://roocode.com/blog/sunsetting-roo-code-extension-cloud-and-router) |

### 5.3 Cloud agents

| Agent | Repo hooks | User MCP | Mid-run message API | Egress | Best level |
|---|---|---|---|---|---|
| Claude Code on the web | `.claude/settings.json` | `.mcp.json` | UI only | None / Trusted / Full / Custom | L3 if egress allows ([docs](https://code.claude.com/docs/en/claude-code-on-the-web)) |
| Cursor cloud agents | `.cursor/hooks.json` (not `sessionStart`) | yes | `followup` | allow-all by default | L3 ([docs](https://cursor.com/docs/cloud-agent/capabilities)) |
| Copilot coding agent | `.github/hooks/*.json` (default branch) | repo config, tools only | UI steering | firewall on Bash children; MCP exempt | L2 ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/use-hooks)) |
| Devin | CLI/Desktop only | yes (admin) | yes | open unless a Security Profile allowlist | L0 push + L1 message ([docs](https://docs.devin.ai/work-with-devin/mcp)) |
| Jules | none | curated list only | `sendMessage` | not documented | L0 + L1 ([docs](https://jules.google/docs/api/reference/sessions)) |
| Codex cloud | not documented | not documented | none public | agent-phase internet off by default | L0 ([docs](https://developers.openai.com/codex/cloud/agent-internet)) |
| Factory droids | `.factory/hooks.json` (cloud use not documented) | yes | yes | not documented | L1, maybe L3 ([docs](https://docs.factory.ai/api-reference/sessions)) |
| Augment remote agents | not documented | not documented | UI only | not documented | L0 ([docs](https://docs.augmentcode.com/using-augment/remote-agent)) |

## 6. Tie-in to the AAIF proposal

[docs/proposal-aaif.md](proposal-aaif.md) asks AAIF for a minimal hook interoperability layer,
drafted as [Agent Hooks Core v0.1](protocol/hooks-core-v0.md). This map is new evidence for it:

- **The problem has grown.** The proposal's evidence was five runtimes with documented hooks
  (2026-10-03). This survey finds 20 with a deny-capable hook or plugin. Each new harness ships hooks, and each adds its own spelling of the same five ideas: field
  casing (`permissionDecision`, `permission`, `decision`, `cancel`, exit 2), tool names and
  argument shapes (`file_path`/`edits`, `TargetFile`/`ReplacementChunks`, `filePath`/`oldString`),
  config locations (`.claude/`, `.github/hooks`, `.cursor/`, `.devin/`, `.agents/`, `.clinerules/`,
  `.factory/`, `.kiro/`), and stop semantics (`block`, `continue`, `followup_message`, a new user
  message). §10 of the core should grow from six hosts to every row in §1. The conformance
  dialects (`packages/conformance/src/dialects.ts`) are the executable form.
- **Convergence is already happening, informally.** Copilot, VS Code, Factory, Qwen, Augment,
  Kimi, Continue and Crush adopted the Claude Code shape, and several read `.claude/settings.json`.
  The core's stdio binding should state where it matches that shape and where it deliberately
  differs, so a host that already speaks "Claude-style" is a few fields from conformance.
- **The real gaps are L1 and L3, not L2.** Almost every host can deny an edit. Fewer can inject
  model-visible text after a tool call (Windsurf, Cline and Antigravity can't, or only on the next
  turn), and stop gates differ the most. The core's capability declaration (§3) exists to state
  this honestly. Coverage tiers b, c and d are what a coordinator does when the standard surface
  is missing.
- **The standard is the long-term way to reach every harness.** Every adapter in §8 is a stopgap
  until hosts conform to the Hooks Core. Once a host conforms, one adapter (the core stdio binding,
  `docs/standardization/reports/core-binding.md`) covers it, and the dialect translators go away.
  The ROADMAP's Q1 2027 goal, "hook adapters accepted upstream by at least one agent harness", is
  the first step. Goose is an AAIF project with Claude-like hooks, which makes it the natural first
  host to propose conformance to.

## 7. Open questions (each phase 2 card probes the ones it owns)

1. Copilot coding agent: do hook commands get past the firewall to the gateway, and how does the
   token get in (an Actions secret, `copilot-setup-steps`)?
2. VS Code Local hooks: which file locations does the Local harness read? Does a Copilot-format
   file in `.github/hooks/` fire for both Copilot CLI and VS Code?
3. Windsurf: is any post-hook output model-visible (L1)? Is there a stop hook? If neither, the
   adapter declares L2 with `inject:"delayed"`, delivering the inbox through the next pre-hook
   denial or the MCP server.
4. Antigravity: does `PreInvocation` `injectSteps` reach the model reliably? Is the file-tool
   argument set (`TargetFile`, `ReplacementChunks`, ...) stable across the app, CLI and IDE?
5. Cursor and Windsurf agents: do they read extension diagnostics (the VS Code extension's
   squiggles as cooperative L1)?
6. The MCP server: when is the inbox delivered if the model calls no Weft tool? (Claude Code
   channels can push; other hosts can't.) Answer from t_70b3d8fe: on hosts without push, not until
   the next `weft_*` call. The watcher's verdicts wait for it, and open errors stay visible in the
   feed and in the git pre-commit gate. In the real run the model called a Weft tool before every
   edit and before finishing, as the server instructions ask.

## 8. Phase 2 cards

Created on the `weft` board by this card. Each has its own worktree and branch, and "done" requires
a real harness run.

| Priority | Card | Branch | Depends on |
|---|---|---|---|
| 100 | `t_6244560b` GitHub Copilot adapter (CLI + coding agent + VS Code agent mode) | `wt/adapter-copilot` | — |
| 90 | `t_70b3d8fe` `@weft/mcp`: the Weft MCP server | `wt/weft-mcp` | — |
| 85 | `t_c8c6816b` `@weft/feed`: shared feed model + view | `wt/weft-feed` | — |
| 80 | `t_ece1e848` VS Code extension (feed panel, diffs, actions, squiggles) | `wt/vscode-extension` | `t_c8c6816b` |
| 70 | `t_7a3391a8` Google Antigravity adapter | `wt/adapter-antigravity` | — |
| 60 | `t_6b8460d9` Windsurf / Devin Desktop adapter | `wt/adapter-windsurf` | — |

Shared rules for these cards (decided here so siblings don't each decide them differently):

- An adapter package lives at `packages/adapters/<name>` as `@weft/adapter-<name>`, built on the
  same core as `adapter-cursor` and `adapter-gemini`, with a README in the same format.
- Its conformance dialect goes in a **new file** `packages/conformance/src/dialects/<name>.ts`,
  registered with one line in `DIALECTS`. Its report goes in `docs/standardization/reports/<name>.md`.
  **Hotspot:** `dialects.ts` and the adapters table in `integrate.md` are touched by every adapter
  card. Keep those edits to one line or one row each.
- `npx weft` harness detection is owned by `t_bd602434`. Adapter cards add their harness to its
  detect list only if that work is on `main`; otherwise leave a comment on that card with the
  binary name and install command.
- MCP tool names, `@weft/feed` and the token lookup order are fixed by §2b, §3.2 and §3.4.
