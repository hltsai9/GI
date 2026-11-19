# syntax=docker/dockerfile:1
# Base images can point at a company mirror (build args NODE_IMAGE, NGINX_IMAGE).
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine
# Web front end: built with Node, served by nginx, which also forwards /api to the backend.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Company networks: HTTP(S)_PROXY build args, an internal npm registry, and a company root
# certificate (build secret "company_ca") for TLS-inspecting proxies. All optional.
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=secret,id=company_ca \
    if [ -s /run/secrets/company_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/company_ca; fi; \
    npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NGINX_IMAGE}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/healthz || exit 1
