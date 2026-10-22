# @weft/adapter-antigravity — WCP adapter for Google Antigravity hooks

One hook format covers Antigravity 2.0, the Antigravity CLI (`agy`) and the Antigravity IDE
(https://antigravity.google/docs/hooks). Antigravity replaced Gemini CLI for free and individual
users on 2026-06-18. The hook command translates Antigravity payloads onto the shared WCP core
(`packages/adapters/claude-code/src`, via `host.ts`).

```sh
pnpm --filter @weft/adapter-antigravity build
WEFT_TOKEN=... node packages/adapters/antigravity/dist/weft-antigravity.mjs install \
  --url http://127.0.0.1:8787 --repo demo --agent agy-1 --task T-1
```

`install` writes a `"weft"` entry into the workspace's `.agents/hooks.json` (other hook names are
kept; the file is excluded from git), plus `.weft/antigravity.json`, the token, git hooks and
`.weft/bin/weft`. Each hook command names its event (`… hook PreToolUse`), because Antigravity
payloads do not carry the event name. The adapter also infers it from the payload fields.

| Antigravity event | core event | output | level |
|---|---|---|---|
| `SessionStart` | SessionStart | `injectSteps: [{systemMessage: {systemMessage}}]` (welcome + inbox) | L1 |
| `PreInvocation` (before every model call) | UserPromptSubmit | `injectSteps` with the inbox plus anything carried from tool hooks | delayed L1 |
| `PreToolUse` edit tools (below) | PreToolUse check | `decision:"deny"` + `reason` (shown to the agent as the tool error) | L2 |
| `PreToolUse` `run_command` with `git commit` | PreToolUse Bash | deny while errors are open | commit_gate |
| `PostToolUse` | PostToolUse | `{}` (fixed by the contract); the core's context is carried to the next `PreInvocation` | L0 |
| `Stop` (`terminationReason: "NO_TOOL_CALL"`) | Stop | `decision:"continue"` + `reason` (re-enters the loop as a system message) | L3 |

Argument mapping (agy 1.4.5 sends the first two; the others are the documented 2.0 / IDE names):
`edit_file {Path, Target, Replacement}` → Edit; `write_file {Path, Content, Overwrite}` → Write;
`write_to_file {TargetFile, CodeContent}` → Write;
`replace_file_content {TargetFile, TargetContent, ReplacementContent, AllowMultiple}` → Edit;
`multi_replace_file_content {TargetFile, ReplacementChunks[]}` → MultiEdit;
`run_command {CommandLine}` → Bash. A tool's Pre and Post carry the same `stepIdx`, which pairs them.

`PreToolUse` must always answer a `decision`: agy treats `{}` as a hard deny ("tool call denied
by pre-tool hook", observed live). A call Weft does not object to answers `decision:"ask"`, which
defers to the user's own permission settings (`allow` would bypass them); so does a hook that
fails (fail open). Injected text uses `systemMessage` steps, which stay in the trajectory;
`ephemeralMessage` is dropped after the turn.

Live evidence (agy 1.4.5): [demo/evidence/antigravity](../../../demo/evidence/antigravity/README.md).

Declared capabilities: `{level: 3, observe: sync, inject: delayed, deny_edit, refuse_stop, commit_gate: tool_interception}`.
Conformance: [docs/standardization/reports/antigravity.md](../../../docs/standardization/reports/antigravity.md).
