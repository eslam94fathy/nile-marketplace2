# syntax=docker/dockerfile:1
# One image for api, worker and migrate (architecture §13). CLAUDE.md §12: multi-stage, non-root,
# no dev dependencies or .env in the image. No ENV defaults: every setting comes from the deployment.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim

# 1. All dependencies (build needs TypeScript). Install scripts stay disabled.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

# 2. Compile.
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 3. Production dependencies only.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# 4. Slim runtime.
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
# API liveness. The worker container (same image, `node dist/worker.js`) serves no HTTP and disables this.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
