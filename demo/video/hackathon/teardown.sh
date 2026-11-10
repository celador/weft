#!/usr/bin/env bash
# Stop everything the demo started and delete the throwaway world.
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
tmux -L hx kill-server 2>/dev/null
[ -d "$SHOP" ] && (cd "$SHOP" && npx -y @celador/weft@0.3.0 local stop >/dev/null 2>&1)
if [ -f "$HERMES_HOME/gateway.pid" ]; then kill "$(python3 -c 'import json,sys;d=open(sys.argv[1]).read().strip();print(json.loads(d)["pid"] if d.startswith("{") else d)' "$HERMES_HOME/gateway.pid")" 2>/dev/null; fi
pkill -f "$HERMES_HOME/logs/gateway-stdio.log" 2>/dev/null
sleep 1
rm -rf "$SHOP" "$SHOP-2" "$HX"
echo teardown done
