# syntax=docker/dockerfile:1
#
# Single image that serves the whole demo behind one port:
#   /        chat UI (static)
#   /chat/*  chat backend (Claude over the Publisher MCP)
#   /api/*   Publisher REST + Explorer API
#   /mcp     Publisher MCP endpoint (for external agents: Claude Code, Codex, …)
#
# Build args:
#   HN_MONTHS  lookback window baked into the image (default 12)
#   HN_END     last month to include (default: latest available)

# ── 1) Build the web UI ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY app/web/package.json ./
RUN npm install --no-audit --no-fund
COPY app/web/ ./
RUN npm run build

# ── 2) Bake the default data window from Hugging Face ────────────────────────
FROM node:22-bookworm-slim AS data
WORKDIR /build
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY prep/ ./prep/
ARG HN_MONTHS=12
ARG HN_END=
ENV HN_OUT=/build/data
RUN HN_MONTHS=${HN_MONTHS} HN_END=${HN_END} node prep/build-data.mjs

# ── 3) Runtime ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx tini curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pin the Publisher server for reproducibility. Keep this in step with the
# `serve` script in package.json, so local dev and the image run one version.
RUN npm install -g @malloy-publisher/server@0.0.246

WORKDIR /app
# Root deps (@duckdb/node-api) so the entrypoint can re-fetch data on boot.
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY prep/ ./prep/
COPY publisher.config.json ./
COPY package/publisher.json package/hn.malloy package/hn.malloynb package/README.md ./package/
COPY --from=data /build/data/ ./package/data/

# Chat backend + its deps.
COPY app/server/ ./app/server/
RUN cd app/server && npm install --no-audit --no-fund --omit=dev

# Static UI + ops files.
COPY --from=web /web/dist/ ./web/
COPY docker/nginx.conf.template /app/nginx.conf.template
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ARG HN_MONTHS=12
ENV BAKED_HN_MONTHS=${HN_MONTHS} \
    NODE_ENV=production \
    PORT=8080
EXPOSE 8080
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
