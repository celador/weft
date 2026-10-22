#!/bin/bash
# Two Claude Code agents side by side (tmux), with Weft's terminal feed on the right.
# Run from the repo's main checkout after `npx @celador/weft` created ../shop-2.
#   two-agents.sh "<npx args>"
FEED="${1:-@celador/weft}"
MAIN="$PWD"; WT="$(cd "$PWD/../shop-2" && pwd)"
A_PROMPT="In src/pricing.ts, make calcTotal take a second parameter opts: { taxRate: number } and apply the tax to the total. Only edit src/pricing.ts."
B_PROMPT="Read src/pricing.ts and src/cart.ts and sum each up in one sentence. Then make cartSummary in src/cart.ts also show the cart total, computed with calcTotal(items) from ./pricing."
# the agents may run their own Weft CLI (negotiate / inbox) without a permission prompt
ALLOW="Bash($MAIN/.weft/bin/weft:*) Bash($WT/.weft/bin/weft:*) Bash(.weft/bin/weft:*)"
T="/opt/homebrew/bin/tmux -L weftrec -f /dev/null"
$T kill-server 2>/dev/null
# a clean server: no profile, no rc files, this (clean) environment
B=$($T new-session -d -P -F '#{pane_id}' -s weft -x 220 -y 56 -c "$WT" "bash --noprofile --norc")
$T set -g default-command "bash --noprofile --norc"
$T set -g allow-set-title off
$T set -g status off
$T set -g pane-border-status top
$T set -g pane-border-format ' #[bold]#{pane_title} '
$T set -g pane-active-border-style fg=colour215
$T select-pane -t "$B" -T "agent shop-2   (worktree ~/work/shop-2)"
A=$($T split-window -v -P -F '#{pane_id}' -t "$B" -c "$MAIN")
$T select-pane -t "$A" -T "agent shop   (main checkout ~/work/shop)"
F=$($T split-window -h -f -l 82 -P -F '#{pane_id}' -t "$B" -c "$MAIN")
$T select-pane -t "$F" -T "npx @celador/weft feed"
# Both agents join Weft first (Claude Code's SessionStart hook says hello). shop then changes
# calcTotal's signature; after Weft accepts it, shop-2 gets its task and calls the old
# calcTotal(items) from its own worktree -> Weft squiggles that edit before it lands.
$T send-keys -t "$F" "clear; npx --yes $FEED feed" Enter
$T send-keys -t "$B" "claude --permission-mode acceptEdits --allowedTools '$ALLOW'" Enter
(
for i in $(seq 1 60); do grep -q "hello" "$WT/.weft/log/adapter.log" 2>/dev/null && break; sleep 1; done
$T send-keys -t "$A" "claude --permission-mode acceptEdits --allowedTools '$ALLOW' -- \"$A_PROMPT\"" Enter
for i in $(seq 1 90); do grep -q "commit src/pricing.ts" "$MAIN/.weft/log/adapter.log" 2>/dev/null && break; sleep 1; done
$T send-keys -t "$B" -l "$B_PROMPT"
sleep 1
$T send-keys -t "$B" Enter
) >/dev/null 2>&1 &
$T select-pane -t "$B"
$T attach -t weft
