---
description: Turn Weft on in this repo (runs on this machine, no account) so this session's edits are checked against the other agents'
allowed-tools: Bash(npx -y @celador/weft@0.3.0 --harness claude-code --yes --no-open), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/weft-hook.mjs" adopt claude-code)
---

Set up Weft in the current git repository, then hand its hooks to this plugin so they work in
this session without a restart. Run these two commands from the repository root, one after the
other, and stop if the first one fails:

1. `npx -y @celador/weft@0.3.0 --harness claude-code --yes --no-open`
   If the user passed arguments (`$ARGUMENTS`), append them to this command and run it with them.
   Only the exact command without arguments is pre-approved, so with arguments Claude Code asks
   the user for permission first.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/weft-hook.mjs" adopt claude-code`

Then tell the user, briefly: Weft is on in this checkout; the live feed address printed by step 1,
with its one-time pairing code (the address has no key in it; the page asks for the code once and
pairs that browser; `npx @celador/weft pair` prints a new code for another device); and that each
other agent should work in its own checkout (`npx @celador/weft add` makes another git worktree).
