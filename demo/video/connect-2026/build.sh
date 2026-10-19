#!/usr/bin/env bash
# Join the web beats (web.mp4, from demo/video/rig/connect-backup.mjs) and the terminal beat
# (term.mp4, from connect-term.tape) into connect-2026-backup.mp4 and upload it to R2 weft-media.
#   demo/video/connect-2026/build.sh [--no-upload]
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
unset CLOUDFLARE_API_TOKEN
ffmpeg -y -loglevel error -i web.mp4 -i term.mp4 \
  -filter_complex "[0:v]scale=1920:1080,fps=30,format=yuv420p,setsar=1[a];[1:v]scale=1920:1080,fps=30,format=yuv420p,setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -preset medium -crf 21 -movflags +faststart connect-2026-backup.mp4
ffprobe -v error -show_entries format=duration,size -of default=nw=1 connect-2026-backup.mp4
if [ "${1:-}" != "--no-upload" ]; then
  W="$(git rev-parse --show-toplevel)/node_modules/.bin/wrangler"
  [ -x "$W" ] || W="$HOME/github/weft/node_modules/.bin/wrangler"
  perl -e 'alarm 300; exec @ARGV' "$W" r2 object put weft-media/connect-2026-backup.mp4 \
    --file connect-2026-backup.mp4 --content-type video/mp4 --remote
  curl -sI https://weft-media.elier.ai/connect-2026-backup.mp4 | grep -i -E '^(HTTP|content-length)'
fi
