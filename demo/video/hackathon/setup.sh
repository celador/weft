#!/usr/bin/env bash
# Build the throwaway demo world (see env.sh). Stages so the filmed parts can run on camera:
#   setup.sh home      isolated Hermes home with its own standalone gateway (no plugin yet)
#   setup.sh project   /tmp/shop (pricing.py, cart.py) linked to a LOCAL Weft gateway; /tmp/shop-2 paired worktree
#   setup.sh plugin    (after `hermes plugins install weft --enable`) enforce mode + agent id + agent token secret
# Prints no secrets.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"

stage_home() {
  rm -rf "$HX"
  mkdir -p "$HERMES_HOME" "$HERMES_GATEWAY_LOCK_DIR" "$WEFT_HOME" "$WEFT_HERMES_CACHE"
  cd /tmp
  hermes config set model.provider anthropic >/dev/null
  hermes config set model.default "${HX_MODEL:-claude-sonnet-4-5}" >/dev/null
  hermes config set gateway.standalone true >/dev/null   # serve only this profile, never the host's
  hermes config set display.compact true >/dev/null
  hermes config set telemetry.shared_metrics.enabled false >/dev/null
  hermes config set telemetry.shared_metrics.send false >/dev/null
  hermes config set telemetry.shared_metrics.offer_version 2 >/dev/null
  echo "home ok: $HERMES_HOME"
}

stage_project() {
  rm -rf "$SHOP" "$SHOP-2"
  mkdir -p "$SHOP" && cd "$SHOP"
  git init -q -b main
  git config user.email demo@example.com
  git config user.name demo
  printf 'def calc_total(items):\n    return sum(i["price"] * i["qty"] for i in items)\n' > pricing.py
  printf 'from pricing import calc_total\n\n\ndef render(items):\n    return "total: %%.2f" %% calc_total(items)\n' > cart.py
  git add -A && git commit -qm init
  # exactly what `/weft setup` runs (plugin cli.py), with the isolated WEFT_HOME
  CI=true NO_COLOR=1 WRANGLER_SEND_METRICS=false npx -y @celador/weft@0.3.0 --yes --no-open --harness watcher --local </dev/null >"$HX/setup.log" 2>&1
  ls -d "$SHOP"/.weft "$SHOP-2"/.weft
  python3 - <<'EOF'
import json, os
s = json.load(open(os.environ["SHOP"] + "/.weft/space.json"))
print("space:", {k: v for k, v in s.items() if "token" not in k.lower() and "key" not in k.lower()})
EOF
}

stage_plugin() {
  cd /tmp
  agent=$(python3 -c 'import json,os;print(json.load(open(os.environ["SHOP"]+"/.weft/space.json"))["agent"])')
  hermes config set plugins.entries.weft.settings.mode enforce >/dev/null
  hermes config set plugins.entries.weft.settings.agent "$agent" >/dev/null
  # the plugin's declared secret (README step 2); stored in the isolated home only, mode 600
  umask 077
  { grep -v '^WEFT_AGENT_TOKEN=' "$HERMES_HOME/.env" 2>/dev/null || true; printf 'WEFT_AGENT_TOKEN=%s\n' "$(tr -d '\n' < "$SHOP/.weft/token")"; } > "$HERMES_HOME/.env.new"
  mv "$HERMES_HOME/.env.new" "$HERMES_HOME/.env"
  echo "plugin settings ok (agent=$agent, mode=enforce)"
}

for s in "$@"; do "stage_$s"; done
