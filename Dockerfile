FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm pack --pack-destination /out

FROM node:22-bookworm-slim AS runtime
ARG CLAUDE_CODE_VERSION=2.1.268
LABEL org.opencontainers.image.source="https://github.com/kikimoradev/kikimora" \
      org.opencontainers.image.description="kikimora worker with a pinned Claude Code CLI" \
      dev.kikimora.claude-code.version="${CLAUDE_CODE_VERSION}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    docker-ce-cli \
    docker-compose-plugin \
    docker-buildx-plugin \
    python3 \
    python3-pip \
    python3-venv \
    gh \
    jq \
    ripgrep \
    make \
    build-essential \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /tmp/pkg
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" /tmp/pkg/*.tgz \
  && rm -rf /tmp/pkg \
  && claude --version
RUN useradd --create-home kikimora
USER kikimora
WORKDIR /workspace
ENV KIKIMORA_LOG_FORMAT=json \
    DISABLE_AUTOUPDATER=1 \
    KIKIMORA_DISABLE_AUTOUPDATER=1
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD kikimora status --json >/dev/null || exit 1
CMD ["kikimora"]

FROM runtime AS browser
ARG PLAYWRIGHT_MCP_VERSION=0.0.80
LABEL dev.kikimora.playwright-mcp.version="${PLAYWRIGHT_MCP_VERSION}"
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PLAYWRIGHT_MCP_BROWSER=chromium
RUN npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
  && playwright-mcp install-browser --with-deps --no-shell chromium \
  && chown -R kikimora:kikimora "${PLAYWRIGHT_BROWSERS_PATH}" \
  && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
  && rm -rf /var/lib/apt/lists/* /root/.npm \
  && playwright-mcp --version
USER kikimora

FROM runtime
