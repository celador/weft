# Security policy

Weft sits between coding agents and the code they change, so security problems matter here:
anything that lets one agent read, block or alter another agent's work without authority, leak
diffs or tokens, or break the guarantees of the event log.

## Reporting a vulnerability

Please report privately. **Do not open a public issue or pull request.**

- Use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/celador/weft/security/advisories/new)
  (the repository's **Security** tab, then **Report a vulnerability**). Only the maintainers see the report.

There is no security email address: GitHub's private reporting is the one channel.

Include what is affected, steps to reproduce, and the impact you see. You'll get a reply within
3 business days. Please give us a reasonable time to fix it before you publish anything; we'll
credit you in the advisory unless you prefer not to be named.

If you find a live credential (a token, key or password) in this repository or its history, report it
the same way and do not use it. We rotate it and remove it from the tree.

## Scope

In scope: the coordinator and gateway (`apps/gateway`, `packages/sequencer`), the protocol and
its reference implementation (`packages/protocol`), the harness adapters (`packages/adapters/*`),
the CLI (`packages/cli`, published as `@celador/weft`), the Claude Code / Copilot plugin
(`plugins/weft`), the VS Code extension (`apps/vscode`), the hosted service built from this
repository, and the web UI. Examples: bypassing an open conflict or the stop/commit gates, claims
that can't expire, token or scope escalation, config discovery that sends data to an unexpected
server, a file in a cloned repository that changes where a hook sends edits, non-deterministic
journal replay.

Out of scope: the public read-only demo showing demo data, denial of service by volume against
the preview deployment, and issues in third-party harnesses themselves.

## Supported versions

Weft is pre-1.0. Only `main` and the latest published release are supported.
