# Build the Installer Portal (Vite/React) and serve the static bundle via nginx.
# Build context is the monorepo root so pnpm can resolve the workspace graph.
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY tools ./tools
COPY cloud ./cloud
COPY drivers ./drivers
COPY apps/web-installer ./apps/web-installer
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @supreme/web-installer... run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web-installer/dist /usr/share/nginx/html
EXPOSE 80
