# Weft agent sandbox image (Cloudflare Containers, linux/amd64).
#
# Contents: git, node 24, Claude Code CLI, Codex CLI, Mergiraf, the WCP adapters, and the
# in-container orchestrator /opt/weft/agent-run.mjs. NO secrets: model keys, the fork's git
# token and the Weft agent token stay in the Worker and are added to outbound requests by the
# Outbound entrypoint (src/outbound.ts).
#
# Build context = apps/sandbox. Run `node scripts/stage.mjs` first (wrangler deploy does it via
# the package script) so image/vendor/ holds the adapter bundles.
FROM node:24-trixie-slim

ARG CLAUDE_CODE_VERSION=2.1.289
ARG CODEX_VERSION=0.160.0
ARG MERGIRAF_VERSION=0.20.0
ARG TYPESCRIPT_VERSION=5.9.3

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates coreutils curl git jq procps ripgrep xz-utils \
	&& rm -rf /var/lib/apt/lists/*

# Agent CLIs (pinned: flags and event formats change between releases).
RUN npm install --global --no-fund --no-audit \
		@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
		@openai/codex@${CODEX_VERSION} \
		pnpm@9.15.0 \
	&& npm cache clean --force

# Mergiraf (structural merge driver, used by the layered merge in B8).
RUN curl -fsSL "https://codeberg.org/mergiraf/mergiraf/releases/download/v${MERGIRAF_VERSION}/mergiraf_x86_64-unknown-linux-musl.tar.gz" \
		| tar -xz -C /usr/local/bin mergiraf \
	&& mergiraf --version

# WCP adapters (bundles staged from packages/adapters/* by scripts/stage.mjs).
COPY image/vendor/adapters /opt/weft/adapters
RUN cd /opt/weft/adapters/claude-code && npm install --no-fund --no-audit --omit=dev typescript@${TYPESCRIPT_VERSION} \
	&& npm cache clean --force \
	&& ln -s /opt/weft/adapters/claude-code/dist/weft-claude.mjs /usr/local/bin/weft-adapter-claude

# Affected-test selector for weft-job (bundle of packages/analyzer/src/testselect.ts; typescript
# comes from the claude-code adapter's install above).
COPY image/vendor/testselect /opt/weft/testselect
RUN ln -s /opt/weft/adapters/claude-code/node_modules /opt/weft/testselect/node_modules

COPY image/agent-run.mjs /opt/weft/agent-run.mjs
COPY image/weft-job.mjs /opt/weft/weft-job.mjs
COPY image/versions.sh /opt/weft/versions.sh

# Git: the Containers CA (HTTPS interception by the Outbound entrypoint) is passed per
# process via GIT_SSL_CAINFO/NODE_EXTRA_CA_CERTS; mergiraf is registered as a merge driver.
RUN git config --system init.defaultBranch main \
	&& git config --system merge.mergiraf.name mergiraf \
	&& git config --system merge.mergiraf.driver 'mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L' \
	&& mkdir -p /workspace /root/.claude \
	&& echo '{"hasCompletedOnboarding":true}' > /root/.claude.json

WORKDIR /workspace
CMD ["sleep", "infinity"]
