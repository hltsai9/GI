# syntax=docker/dockerfile:1
# Base image can point at a company mirror (build arg NODE_IMAGE).
ARG NODE_IMAGE=node:22-alpine
# Backend API + scheduler (Oracle import, daily sweep, alerts). Run exactly ONE container.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Company networks: HTTP(S)_PROXY build args, an internal npm registry, and a company root
# certificate (build secret "company_ca") for TLS-inspecting proxies. All optional.
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=secret,id=company_ca \
    if [ -s /run/secrets/company_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/company_ca; fi; \
    npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY mock-oracle/*.ts ./mock-oracle/
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Company networks: HTTP(S)_PROXY build args, an internal npm registry, and a company root
# certificate (build secret "company_ca") for TLS-inspecting proxies. All optional.
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=secret,id=company_ca \
    if [ -s /run/secrets/company_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/company_ca; fi; \
    npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY db ./db
COPY docker-entrypoint.sh ./
RUN mkdir -p mock-oracle/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
