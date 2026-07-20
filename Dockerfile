FROM node:24-alpine AS build

WORKDIR /app

RUN apk add --no-cache tini

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./

RUN yarn install --immutable && \
    yarn cache clean

COPY . .
RUN yarn build

ARG BUILD_VERSION=0.0.0
RUN npm version ${BUILD_VERSION} --allow-same-version

ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "."]

FROM build AS e2e

FROM node:24-alpine AS production

WORKDIR /app

RUN apk add --no-cache tini

RUN corepack enable

COPY --from=build /app/package.json /app/yarn.lock /app/.yarnrc.yml ./

RUN yarn workspaces focus --production && \
    yarn cache clean

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "."]
