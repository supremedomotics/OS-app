# Multi-stage build for the Supreme API Gateway and its workspace dependencies.
# Build context is the monorepo root so pnpm can resolve the workspace graph.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Trust the environment's egress-proxy CA when present, so package fetches behind a
# TLS-intercepting proxy validate. The ca-certs/ dir is empty on normal networks
# (CI, real hubs), in which case NODE_EXTRA_CA_CERTS is left unset (a no-op).
COPY infra/hub-compose/ca-certs/ /usr/local/share/ca-certificates/
RUN for f in /usr/local/share/ca-certificates/*.crt; do [ -f "$f" ] && cat "$f" && echo; done > /usr/local/share/proxy-ca.pem 2>/dev/null || true

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
# The gateway's workspace graph spans packages/, services/, cloud/ (licensing) and
# drivers/ (driver SDK), so all four are needed to resolve + build it.
COPY packages ./packages
COPY services ./services
COPY cloud ./cloud
COPY drivers ./drivers
COPY tools ./tools
# Use the proxy CA only if one was provided; then install + build the gateway
# subgraph via Turborepo's affected graph.
RUN [ -s /usr/local/share/proxy-ca.pem ] && export NODE_EXTRA_CA_CERTS=/usr/local/share/proxy-ca.pem; \
    corepack enable && \
    pnpm install --frozen-lockfile=false && \
    pnpm --filter @supreme/gateway... run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Bring the built workspace (node_modules symlinks + dist) from the build stage.
COPY --from=build /app /app
WORKDIR /app/services/gateway
EXPOSE 8080
CMD ["node", "dist/main.js"]
