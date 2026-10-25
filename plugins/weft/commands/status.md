---
description: Show Weft's state for this repo (gateway, space, checkouts, recent events) and whether this plugin is running its hooks
allowed-tools: Bash(npx -y @celador/weft@latest:*), Bash(node:*)
---

Run `npx -y @celador/weft@latest status` and `node "${CLAUDE_PLUGIN_ROOT}/scripts/weft-hook.mjs" where claude-code`
from the repository root and summarize both for the user in a few lines.
