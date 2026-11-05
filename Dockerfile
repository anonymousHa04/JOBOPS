# syntax=docker/dockerfile:1
# One image for every JobOps process: the API, the queue server (with jd-search for the fetch
# step), both workers, the CLI and the gateway (built web UI). Each Kubernetes Deployment picks
# its command.
# Private data is never copied in (see .dockerignore): profile/ and data/ are volumes, settings
# come from a Secret made from .env.

# 1. Go binaries: the queue server, jd-search and the gateway (pure Go, no C compiler needed).
FROM golang:1.25-bookworm AS go
WORKDIR /src
COPY queue/ queue/
COPY jd-search/ jd-search/
COPY gateway/ gateway/
RUN cd queue && CGO_ENABLED=0 go build -trimpath -o /out/queue ./cmd/queue \
 && cd ../jd-search && CGO_ENABLED=0 go build -trimpath -o /out/jd-search ./cmd/jd-search \
 && cd ../gateway && CGO_ENABLED=0 go build -trimpath -o /out/gateway .

# 1b. The web UI (Vite build needs the dev packages; only ui/dist goes on).
FROM node:24-bookworm-slim AS ui
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY ui/ ui/
RUN npm run ui:build

# 2. Node packages for production (better-sqlite3 builds its native part here if needed).
FROM node:24-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 3. The runtime image.
FROM node:24-bookworm-slim
ARG TYPST_VERSION=0.15.1
ARG TARGETARCH
# chromium: the careers crawler (Google Chrome has no Linux arm64 build); poppler-utils:
# pdftotext/pdfinfo/pdffonts for the parse-back check; typst renders the resume (its font,
# New Computer Modern, is built in); tini passes signals so pods stop cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils poppler-utils chromium tini sqlite3 \
 && arch=$([ "$TARGETARCH" = "amd64" ] && echo x86_64 || echo aarch64) \
 && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${arch}-unknown-linux-musl.tar.xz" \
      | tar -xJ -C /tmp \
 && mv "/tmp/typst-${arch}-unknown-linux-musl/typst" /usr/local/bin/typst \
 && rm -rf /tmp/typst-* /var/lib/apt/lists/* \
 && mkdir -p /app/data /app/profile && chown -R node:node /app

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node api/ api/
COPY --chown=node:node requierements/ requierements/
COPY --chown=node:node jd-search/ jd-search/
COPY --from=go /out/queue /out/jd-search /out/gateway /usr/local/bin/
COPY --from=ui --chown=node:node /src/ui/dist ui/dist

ENV NODE_ENV=production \
    JOBOPS_ROOT=/app \
    JOBOPS_JDSEARCH_BIN=/usr/local/bin/jd-search \
    JOBOPS_CHROME_PATH=/usr/bin/chromium \
    DB_PATH=/app/data/jobops.db \
    JOBOPS_DB=/app/data/jobops.db \
    JOBOPS_PROFILE_DIR=/app/profile \
    HOST=0.0.0.0 \
    GATEWAY_UI_DIR=/app/ui/dist

USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "api/src/server.ts"]
