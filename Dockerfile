FROM node:20-alpine

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
