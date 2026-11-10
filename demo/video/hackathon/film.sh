#!/usr/bin/env bash
# One complete take, from nothing: isolated home -> filmed catalog install -> project + local gateway
# -> plugin settings -> two live Hermes sessions filmed in tmux. Copies the take to $1 (a directory).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?usage: film.sh <take-dir>}"
mkdir -p "$out"
bash "$here/teardown.sh" >/dev/null 2>&1 || true
bash "$here/setup.sh" home
source "$here/env.sh"
( cd "$here" && vhs install.tape >"$out/vhs-install.log" 2>&1 )
bash "$here/setup.sh" project plugin
rm -f "$HX/go" "$HX/done"
python3 "$here/live.py" prepare
python3 "$here/live.py" run >"$out/live-run.out" 2>&1 &
( cd "$here" && vhs live.tape >"$out/vhs-live.log" 2>&1 )
wait
cp "$HX/install.mp4" "$HX/live.mp4" "$HX/live-log.json" "$HX/pane-A.txt" "$HX/pane-B.txt" "$out/"
cp "$WEFT_HERMES_CACHE/demo.log" "$out/weft-adapter.log" 2>/dev/null || true
cat "$out/live-run.out"
