# Build the Installer Portal (Vite/React) and serve the static bundle via nginx.
# Build context is the monorepo root so pnpm can resolve the workspace graph.
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Trust the egress-proxy CA when present (no-op on normal networks).
COPY infra/hub-compose/ca-certs/ /usr/local/share/ca-certificates/
RUN for f in /usr/local/share/ca-certificates/*.crt; do [ -f "$f" ] && cat "$f" && echo; done > /usr/local/share/proxy-ca.pem 2>/dev/null || true
WORKDIR /app
COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY tools ./tools
COPY cloud ./cloud
COPY drivers ./drivers
COPY apps/web-installer ./apps/web-installer
# API base for the bundle. Default empty = SAME-ORIGIN (the portal is served behind
# the same Caddy TLS host as the API at /v1). Override for split deployments.
ARG VITE_SUPREME_API_URL=
ENV VITE_SUPREME_API_URL=$VITE_SUPREME_API_URL
# Asset base path. Behind the hub edge the portal is served under /installer/.
ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE
RUN [ -s /usr/local/share/proxy-ca.pem ] && export NODE_EXTRA_CA_CERTS=/usr/local/share/proxy-ca.pem; \
    corepack enable && \
    pnpm install --frozen-lockfile=false && \
    pnpm --filter @supreme/web-installer... run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web-installer/dist /usr/share/nginx/html
EXPOSE 80
