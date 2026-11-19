# syntax=docker/dockerfile:1
# GI in one image: the backend (API, Oracle import, scheduler) also serves the built web page.
# Build from the repository root:  docker build -t gi .   (or: cd deploy && docker compose build)
# Base image can point at a company mirror (build arg NODE_IMAGE).
ARG NODE_IMAGE=node:22-alpine

# Company networks: HTTP(S)_PROXY build args, an internal npm registry (NPM_REGISTRY), and a company
# root certificate (build secret "company_ca") for TLS-inspecting proxies. All optional.

# ---- 1. web page -------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=secret,id=company_ca \
    if [ -s /run/secrets/company_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/company_ca; fi; \
    npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund
COPY frontend/ ./
RUN npm run build && rm -rf dist/demo-data

# ---- 2. backend --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=secret,id=company_ca \
    if [ -s /run/secrets/company_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/company_ca; fi; \
    npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
COPY backend/mock-oracle/*.ts ./mock-oracle/
RUN npm run build

# ---- 3. runtime --------------------------------------------------------------------------
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV NODE_ENV=production PORT=3000 STATIC_DIR=/app/public
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=secret,id=company_ca \
    if [ -s /run/secrets/company_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/company_ca; fi; \
    npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund --omit=dev && npm cache clean --force
COPY --from=api /app/dist ./dist
COPY backend/db ./db
COPY backend/docker-entrypoint.sh ./
COPY --from=web /web/dist ./public
RUN mkdir -p mock-oracle/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
