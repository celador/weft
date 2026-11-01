# Repository security controls

What protects this repository and what we ship from it. Report problems privately: see
[SECURITY.md](../.github/SECURITY.md).

## `main`

- Branch protection: pull requests need one approval, including a code owner's for the paths in
  [`.github/CODEOWNERS`](../.github/CODEOWNERS) (`plugins/`, `packages/cli/`, `packages/adapters/`,
  `.github/`), and the `gate` and `secrets` checks must pass. Force pushes and deletion are off.
  Repository admins are not forced through these rules (so the maintainer can fast-forward and
  push); everyone else is.
- Secret scanning and push protection are on.

## CI (`.github/workflows/ci.yml`)

- The workflow token is read-only (`permissions: contents: read`); checkouts do not persist it.
- `gate`: typecheck and tests. `secrets`: gitleaks over the full history with the checksum-verified
  release pinned in the workflow; reviewed false positives are in `.gitleaks.toml` (a real secret
  is removed and rotated, never added there). `audit`: `pnpm audit --prod --audit-level high`;
  accepted advisories are listed in the root `package.json` under `pnpm.auditConfig`.

## Releases

- `@celador/weft` is published by `.github/workflows/release.yml` (manual dispatch from `main`)
  with npm provenance, so `npm audit signatures` ties a tarball to the commit it was built from.
  `publishConfig.provenance` makes a publish from outside CI fail instead of shipping an
  unattested package.
- The VS Code extension package contains no source maps (`apps/vscode/scripts/package.mjs`
  refuses to pack one).

## The plugin and `.weft/` in a cloned repository

A repository can ship its own `.weft/` config. The Claude Code / Copilot plugin therefore never
trusts it: it runs the adapter only for a checkout whose gateway you chose with `npx @celador/weft`
(recorded in `~/.config/weft/pins.json`) and the adapter ignores a config that differs from that
choice. See [`plugins/weft/README.md`](../plugins/weft/README.md).
