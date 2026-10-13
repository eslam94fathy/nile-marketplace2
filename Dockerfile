# syntax=docker/dockerfile:1
# One image for api, worker and migrate (architecture §13). CLAUDE.md §12: multi-stage, non-root,
# no dev dependencies or .env in the image. No application ENV defaults: every setting comes from the
# deployment (NODE_EXTRA_CA_CERTS below is trust for the platform, not application config).

ARG NODE_IMAGE=node:24.21.0-bookworm-slim
# Amazon RDS CA bundle (all regions). Node does not trust this CA, and the app verifies the database
# certificate when DB_SSL is on (architecture §13.1, P8-Q9). Pinned: a changed bundle fails the build;
# update the checksum after checking the new file (docs/runbooks).
ARG RDS_CA_BUNDLE_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ARG RDS_CA_BUNDLE_SHA256=fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c

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

# 4. Slim runtime. The containers run node only (never npm), so npm, npx, corepack and yarn are removed:
# less to patch, and their bundled packages are what image scanners flag (P8-Q14).
FROM ${NODE_IMAGE} AS runtime
# Debian security fixes released after the base image was built (scanned in CI, P8-Q14).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
ARG RDS_CA_BUNDLE_URL
ARG RDS_CA_BUNDLE_SHA256
ADD --checksum=sha256:${RDS_CA_BUNDLE_SHA256} --chown=node:node ${RDS_CA_BUNDLE_URL} /app/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem
USER node
EXPOSE 3000
# API liveness. The worker container (same image, `node dist/worker.js`) serves no HTTP and disables this.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
