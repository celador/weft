---
description: Show Weft's state for this repo (gateway, space, checkouts, recent events) and whether this plugin is running its hooks
allowed-tools: Bash(npx -y @celador/weft@0.2.0:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/weft-hook.mjs" where claude-code)
---

Run `npx -y @celador/weft@0.2.0 status` and `node "${CLAUDE_PLUGIN_ROOT}/scripts/weft-hook.mjs" where claude-code`
from the repository root and summarize both for the user in a few lines.
