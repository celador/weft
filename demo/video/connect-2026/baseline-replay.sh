#!/usr/bin/env bash
# Sets up a replay of the landing step of the real Weft-OFF baseline run (demo/m1-baseline.mjs) on
# its actual commits, for the "without Weft" clip (baseline.tape). Usage:
#   demo/video/connect-2026/baseline-replay.sh <work dir from demo/evidence/m1-baseline/summary.json>
# Clones the run's repo into a fresh temp dir (printed) with main reset to the initial commit and
# agent-a/agent-b as local branches, so the tape can merge both and run tsc + node --test for real.
set -euo pipefail
WORK=${1:?work dir}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
REPLAY=$(mktemp -d "${TMPDIR:-/tmp}/weft-baseline-replay.XXXXXX")
git clone -q "$WORK/origin" "$REPLAY"
cd "$REPLAY"
for b in agent-a agent-b; do git branch -q "$b" "origin/$b"; done
git reset -q --hard "$(git rev-list --max-parents=0 HEAD)"
ln -s "$REPO/node_modules" node_modules
echo "$REPLAY"
