#!/usr/bin/env bash
# Mirror plugins/weft into the small standalone repo celador/weft-plugin
# (the Claude plugin directory can't download the full monorepo archive).
#
# The plugin folder lands at the repo root, plus LICENSE. README.md is the
# plugin's own README. Nothing else goes in.
#
# Usage: scripts/sync-plugin.sh [remote-url]
#   remote-url defaults to git@github.com:celador/weft-plugin.git
#   Set DRY_RUN=1 to build the tree and commit locally without pushing.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/plugins/weft"
remote="${1:-git@github.com:celador/weft-plugin.git}"
work="$(mktemp -d "${TMPDIR:-/tmp}/weft-plugin.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if git ls-remote --exit-code --heads "$remote" main >/dev/null 2>&1; then
  git clone --quiet --depth 1 --branch main "$remote" "$work"
else
  git init --quiet -b main "$work"
  git -C "$work" remote add origin "$remote"
fi

# Replace everything except .git with the plugin folder verbatim.
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$src"/. "$work"/
cp "$here/LICENSE" "$work/LICENSE"

cd "$work"
git add -A
if git diff --cached --quiet; then
  echo "weft-plugin already up to date"
  exit 0
fi

rev="$(git -C "$here" rev-parse --short HEAD)"
git -c user.name="${GIT_AUTHOR_NAME:-weft-sync}" -c user.email="${GIT_AUTHOR_EMAIL:-weft-sync@users.noreply.github.com}" \
  commit --quiet -m "sync plugins/weft from celador/weft@$rev"
if [ "${DRY_RUN:-}" = 1 ]; then
  git ls-files
  exit 0
fi
git push --quiet origin main
echo "pushed weft-plugin main ($(git rev-parse --short HEAD)) from celador/weft@$rev"
