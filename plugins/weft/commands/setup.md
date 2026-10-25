---
description: Turn Weft on in this repo (free hosted space, no account) so this session's edits are checked against the other agents'
allowed-tools: Bash(npx -y @celador/weft@0.2.0:*), Bash(node:*)
---

Set up Weft in the current git repository, then hand its hooks to this plugin so they work in
this session without a restart. Run these two commands from the repository root, one after the
other, and stop if the first one fails:

1. `npx -y @celador/weft@0.2.0 --harness claude-code --yes --no-open $ARGUMENTS`
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/weft-hook.mjs" adopt claude-code`

Then tell the user, briefly: Weft is on in this checkout; the live feed link printed by step 1
(private: anyone with the link can read the feed); and that each other agent should work in its
own checkout (`npx @celador/weft add` makes another git worktree). Do not repeat the feed key
anywhere else.
