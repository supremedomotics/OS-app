# Multi-stage build for the Supreme API Gateway and its workspace dependencies.
# Build context is the monorepo root so pnpm can resolve the workspace graph.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
# Copy only the manifests first for a cacheable install layer.
COPY packages ./packages
COPY services ./services
COPY tools ./tools
RUN pnpm install --frozen-lockfile=false
# Build the gateway and everything it depends on via Turborepo's affected graph.
RUN pnpm --filter @supreme/gateway... run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Bring the built workspace (node_modules symlinks + dist) from the build stage.
COPY --from=build /app /app
WORKDIR /app/services/gateway
EXPOSE 8080
CMD ["node", "dist/main.js"]
