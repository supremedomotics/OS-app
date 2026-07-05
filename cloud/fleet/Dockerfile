# Cloud Fleet service (OPTIONAL). Build context is the monorepo root so pnpm can
# resolve the workspace graph. Deployed to Supreme Cloud, never to the hub.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
COPY infra/hub-compose/ca-certs/ /usr/local/share/ca-certificates/
RUN for f in /usr/local/share/ca-certificates/*.crt; do [ -f "$f" ] && cat "$f" && echo; done > /usr/local/share/proxy-ca.pem 2>/dev/null || true

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY cloud ./cloud
COPY services ./services
COPY drivers ./drivers
COPY tools ./tools
RUN [ -s /usr/local/share/proxy-ca.pem ] && export NODE_EXTRA_CA_CERTS=/usr/local/share/proxy-ca.pem; \
    corepack enable && pnpm install --frozen-lockfile=false && pnpm --filter @supreme/fleet... run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/cloud/fleet
EXPOSE 8090
CMD ["node", "dist/main.js"]
