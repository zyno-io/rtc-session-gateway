# Build with the repository root as context:
#   docker build -f firewall-sidecar/Dockerfile .
# nftables-napi is AGPL-3.0-only; it lives only in this image.
FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ linux-headers libmnl-dev libnftnl-dev pkgconf
RUN corepack enable
COPY firewall-sidecar/package.json firewall-sidecar/yarn.lock firewall-sidecar/.yarnrc.yml ./firewall-sidecar/

# Production-only dependencies (no typescript/@types); native addon is compiled here against musl.
FROM base AS deps
RUN cd firewall-sidecar && yarn workspaces focus --production && yarn cache clean

FROM base AS build
RUN cd firewall-sidecar && yarn install --immutable && yarn cache clean
COPY firewall-sidecar ./firewall-sidecar
COPY src ./src
# Shared modules in ../src resolve dependencies from /app/node_modules.
RUN ln -s firewall-sidecar/node_modules node_modules
RUN cd firewall-sidecar && yarn build

FROM node:24-alpine AS firewall-sidecar
WORKDIR /app
RUN apk add --no-cache tini libmnl libnftnl
COPY --from=deps /app/firewall-sidecar/node_modules ./node_modules
COPY --from=build /app/firewall-sidecar/dist ./dist
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/firewall-sidecar/src/main.js"]
