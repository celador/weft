# Verification notes — Weft Hermes catalog plugin 0.4.0

## Scope

Catalog source is `packages/adapters/hermes/plugin/weft`. No built analyzer, grammar WASM,
bytecode or legacy credential-reader module is required or shipped in that subdirectory.
The development install remains a separate distribution: `scripts/install.py` supplies the optional
`installer/legacy_config.py`. The installed copy under `~/.hermes/plugins/weft` was not replaced,
enabled/disabled or restarted during this work.

## Executed checks

- `hermes plugins validate packages/adapters/hermes/plugin/weft --install-deps`:
  **Validation passed**, including capability probe, two declared tools, seven declared hooks,
  security scan **safe**, no core overrides and Desktop SDK surface checks.
- `hermes plugins doctor packages/adapters/hermes/plugin/weft --ci`:
  **OK: runtime discovery, manifest parsing, import, and registration passed**;
  **2 tools, 7 hooks**. No Python dependencies declared.
- Offline Python tests cover existing installer configuration, routing, auto-land, breaker and
  analyzer behavior, plus catalog regressions: no CLI-token reads, secret scope, trusted gateway
  boundary, distinct checkout identities with a shared token, settings reload, disabled reporting,
  malformed snapshots, valid/lossless inbox JSON, Python import/method dependencies, sensitive-file
  exclusions, no HTTP credential redirects and the installer-produced file set.
- `tests/e2e_catalog.py`: **ALL PASSED**, with a real local Weft gateway and real Hermes tool
  dispatch/hook calls in two session identities, no model inference. Proves:
  1. A's signature edit reaches disk cleanly.
  2. B's stale cross-file caller is rejected before disk write, with `stale_assumption` naming
     `pricing.py#calc_total` and the causative agent/event.
  3. `weft_status` reports the rejection, open conflict and local peer checkout.
  4. A same-file in-flight overlap gets its `claim_wait` warning in the edit result.
- Existing auto-land local-gateway integration: exactly one accepted land after a branch merge.
- Real FastAPI plugin backend route checked through `TestClient`: empty/populated snapshots,
  HTTP 200, no gateway requests.
- Desktop component rendered in headless Chrome using SDK test doubles and **real E2E gateway
  snapshots**: conflict, empty and backend-error states passed; no browser exceptions. Screenshots
  are labeled harness renders, not full Hermes Desktop-window verification. Visually inspected
  conflict screenshot: no clipping/overlap; rejected edit and symbol visible.
- Full project gate: `pnpm -r typecheck && pnpm -r test`; final result is recorded in the task handoff
  together with the raw log. No package versions or production services were changed.

## Corrections made during verification

Initial full-gate run found missing worktree dependencies (the machine's old global TypeScript was
being used); `pnpm install --frozen-lockfile` restored the locked toolchain. Later integration runs
caught the extracted legacy-config reader missing from a source-tree auto-land subprocess; the
fixture now supplies its installer module path, matching the installed distribution. These were
fixed and the affected integration test rerun successfully before the final full gate.

The live hook exercise also found that sharing a process/session-derived task ID across paired
checkouts makes Weft treat them as alternative candidates, masking conflicts. Standalone tasks
now use a stable checkout hash, while the token-authorized agent ID stays unchanged.

## Security impact

Local-first and silent until explicitly linked plus Hermes credential configuration. Untrusted
checkout gateway URLs are refused; WCP HTTP redirects are not followed. `.env*`, `.weft`, `.ssh`,
`.hermes`, common private-key containers and build/dependency directories are excluded from edit
reporting. Snapshots have mode 600 and contain no diffs/tokens. Source diffs still go to the chosen
gateway by design; the README and catalog PR disclose that, the pinned optional npm subprocess,
CLI background gateway, Git/worktree changes, reads and local storage. No telemetry added, no
LLM/provider calls, no cloud deployments, no paid resources or social posts.

## Human/maintainer work remaining

Nous merged the catalog entry on 2026-11-10 (PR #150998; `hermes plugins search weft` lists
0.4.0 @ fe30e497). The <90s demo video is cut (see [submission.md](submission.md)); John must post it
on X tagging @NousResearch and submit the form. The entry is **not submitted to the hackathon merely
because the catalog PR exists**.
