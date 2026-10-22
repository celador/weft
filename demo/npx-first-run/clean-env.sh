#!/bin/bash
# A "clean machine" for the npx @celador/weft run: an empty HOME, and a PATH with only node
# (node, npm, npx), claude and the macOS base system (/usr/bin, /bin: git, sh, ...).
# Usage: source clean-env.sh   (then everything runs as a first-time user)
set -e
CLEAN=/Users/john/.hermes/cache/scratch/clean
rm -rf "$CLEAN"; mkdir -p "$CLEAN/home" "$CLEAN/bin" "$CLEAN/work"
NODEBIN=/opt/homebrew/opt/node@24/bin
for b in node npm npx; do ln -s "$NODEBIN/$b" "$CLEAN/bin/$b"; done
ln -s /Users/john/.local/bin/claude "$CLEAN/bin/claude"
# Claude Code's login lives in the macOS keychain of the real user; hand the clean HOME its token.
export CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s 'Claude Code-credentials' -w | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')"
# skip Claude Code's first-run onboarding in the empty HOME
W="$CLEAN/work"
printf '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"%s/shop":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true},"%s/shop-2":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}\n' "$W" "$W" > "$CLEAN/home/.claude.json"
export HOME="$CLEAN/home" PATH="$CLEAN/bin:/usr/bin:/bin" WEFT_NO_OPEN=1 SHELL=/bin/bash TERM=xterm-256color
unset WEFT_HOME XDG_CONFIG_HOME CLOUDFLARE_API_TOKEN NPM_CONFIG_PREFIX npm_config_prefix
export PS1='$ '
cd "$CLEAN/work"
set +e
