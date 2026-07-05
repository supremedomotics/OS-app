# Supreme Cloud off-site backup vault — zero-knowledge encrypted-blob sink. Root context.
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY cloud ./cloud
COPY drivers ./drivers
COPY tools ./tools
RUN corepack enable && pnpm install --frozen-lockfile=false && pnpm --filter @supreme/backups-cloud... run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/cloud/backups
EXPOSE 8097
CMD ["node", "dist/main.js"]
