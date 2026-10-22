# GitHub Copilot + Weft — live evidence (2026-10-22)

Adapter: `@weft/adapter-copilot` ([README](../../../packages/adapters/copilot/README.md)), one
`.github/hooks/weft.json` per checkout. Gateway: local `pnpm dev:local --port 8797` (no
Cloudflare). Copilot account: GitHub Copilot **Free** (`free_limited_copilot`). Tokens were
minted per run and are not in these files; paths are shortened to `<work>` / `~`.

| Dir | Surface | What happened |
|---|---|---|
| [`stop-gate/`](stop-gate/) | Copilot CLI 1.0.102 (`copilot -p`, model `gpt-6-luna`) ×2 | copilot-b planned `calcTotal(this.items)`; copilot-a changed calcTotal's signature; copilot-b (resumed, told to give up if blocked) had its `apply_patch` **denied** (`permissionDecisionReason` = the `stale_assumption` squiggle with copilot-a's diff), then its stop was **refused** (`agentStop` → `decision:"block"`, "stop refusal 1/5"). Copilot fed the reason back as a prompt, the model read the new signature, wrote `calcTotal(this.items, { taxRate: 0 })`, which was accepted, and its next stop was allowed. |
| [`reroute/`](reroute/) | Copilot CLI ×2 | Same setup, B told to adapt: denied once, adapted, accepted. Main after merging both branches: `tsc` exit 0. |
| [`vscode/`](vscode/) | VS Code 1.135 agent mode, Local harness (Copilot Chat 0.63), driven with `code chat -m agent` | The Local harness read `.github/hooks/weft.json` (and the raw-payload probe `.github/hooks/zz-probe.json` next to it). vscode-b's stale `apply_patch` was **blocked by hook** (screenshot; coordinator event #4 `rejected stale_assumption`). B's own `src/pricing.ts` still had the old signature, yet its next edit used `{ taxRate: 0 }`, which only the denial told it; accepted. |
| [`vscode-stop-gate/`](vscode-stop-gate/) | VS Code agent mode | B's edit raced A's change (pre-check clean, A's commit landed first): the post-edit commit was **REJECTED** and injected through `PostToolUse` (`hookSpecificOutput.additionalContext`), and the stop was refused (**"Blocked by Stop hook"** in the chat). The model then fixed the call; accepted. |
| [`double-fire.txt`](double-fire.txt) | Copilot CLI | With both the Copilot and the Claude Code adapter installed in one checkout, Copilot CLI ran BOTH (`.claude/settings.local.json` is read too): every event twice. After the guard in the Claude Code hook, only the Copilot adapter answers. |

In the VS Code runs agent A is agent-a's Copilot adapter driven with Copilot CLI payloads by a
script the moment B's session says hello (an LLM for A was too slow to land between B's hello
and B's first edit). B is the real VS Code agent.

## Which hook files each surface read

- Copilot CLI: `.github/hooks/*.json` **only in a trusted folder**. `copilot -p` in an untrusted
  folder ran with no hooks and no warning (probe: 0 hook calls; with `COPILOT_ALLOW_ALL=true`:
  6). `--trust-folder` cannot be combined with `--resume`; the resumed turns used
  `COPILOT_ALLOW_ALL=true`. Also `.claude/settings.local.json` (see double-fire).
- VS Code Local harness: `.github/hooks/weft.json` and `.github/hooks/zz-probe.json` (Copilot
  camelCase format, mapped to its PascalCase events; payloads carry `tool_use_id`). Hook env has
  `VSCODE_PID`, no `COPILOT_CLI`.

## Copilot cloud agent probe

Probe repo `celador/weft-copilot-cloud-probe` (private): `.github/hooks/weft-probe.json` on
`main` runs `probe.sh` on sessionStart/preToolUse/postToolUse/agentStop/sessionEnd; it curls
`https://weft-gateway-preview.elier.ai/v1/health` and returns the result as `additionalContext`
(`WEFT-PROBE event=… curl_rc=… result=…`), and the task asks the agent to write those lines to
PROBE.md in its PR.

```
$ gh agent-task create -R celador/weft-copilot-cloud-probe "Create a file PROBE.md …"
failed to create job: 403 Forbidden: Forbidden
$ gh api /copilot_internal/user  →  access_type_sku "free_limited_copilot", premium_interactions entitlement 0
```

Result: **not run**. The cloud agent is not available on Copilot Free, so neither "did the hook
fire" nor "did it reach the gateway" could be observed. Re-run the command above on an account
with Copilot Pro/Pro+/Business; the probe repo is ready.

## Reproduce

```sh
(cd apps/gateway && pnpm dev:local --port 8797) &
WEFT_URL=http://localhost:8797 node demo/copilot-live.mjs stop-gate     # or: reroute
```
