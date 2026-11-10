# Source me. Throwaway world for the Hermes-hackathon demo: an isolated Hermes home with its own
# standalone gateway, an isolated Weft home/cache, and the project /tmp/shop (+ paired /tmp/shop-2).
# Nothing here touches ~/.hermes, its gateway, ~/.weft or ~/.cache/weft-hermes.
#
# Everything lives under /tmp so every path that reaches the screen is neutral (no home directory).
export HX=/tmp/hx
export HERMES_HOME="$HX/profiles/demo"           # a profiles/<name> home: no --profile default selector
export HERMES_GATEWAY_LOCK_DIR="$HX/gateway-locks" # its own host-gateway rendezvous, not the real one
export WEFT_HOME="$HX/weft-home"
export WEFT_HERMES_CACHE="$HX/weft-cache"          # snapshots of THIS demo only (no other sessions)
export SHOP=/tmp/shop
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
# A kanban worker's / gateway's identity must not leak into the demo sessions.
for v in $(env | grep -oE '^(HERMES_KANBAN_[A-Z_]*|HERMES_SESSION_[A-Z_]*|HERMES_PROFILE|HERMES_TENANT|HERMES_TURN_AUTHOR|WEFT_HERMES_CONFIG|WEFT_HERMES_MODE|WEFT_HERMES_TASK|WEFT_HERMES_CHANGE|TERMINAL_CWD)=' | tr -d =); do
  unset "$v"
done
