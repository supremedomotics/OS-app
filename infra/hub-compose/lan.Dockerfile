# Multi-stage build for supreme-lan (§ Production Architecture Refactor — SupremeOS LAN Transport
# Service) and its workspace dependencies. Build context is the monorepo root so pnpm can resolve
# the workspace graph. Deliberately tiny at runtime: no database driver, no auth library — only
# `@supreme/messaging` (the NATS event bus) and `node:dgram`.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Trust the environment's egress-proxy CA when present, so package fetches behind a
# TLS-intercepting proxy validate. The ca-certs/ dir is empty on normal networks (CI, real hubs).
COPY infra/hub-compose/ca-certs/ /usr/local/share/ca-certificates/
RUN for f in /usr/local/share/ca-certificates/*.crt; do [ -f "$f" ] && cat "$f" && echo; done > /usr/local/share/proxy-ca.pem 2>/dev/null || true

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
# @supreme/lan only depends on @supreme/messaging — a far smaller workspace subgraph than the
# Gateway's, but `packages`/`services` are copied wholesale for a simple, uniform build step
# (pnpm's own `--filter ...^...` dependency resolution ignores everything it doesn't need).
COPY packages ./packages
COPY services ./services
RUN [ -s /usr/local/share/proxy-ca.pem ] && export NODE_EXTRA_CA_CERTS=/usr/local/share/proxy-ca.pem; \
    corepack enable && \
    pnpm install --frozen-lockfile && \
    pnpm --filter @supreme/lan... run build && \
    pnpm --filter @supreme/lan deploy --prod --legacy /deploy

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /deploy /app
CMD ["node", "dist/server/main.js"]
