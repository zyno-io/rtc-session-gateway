# Getting Started

## Prerequisites

- Node.js 24.
- Corepack.
- Yarn Berry, provided through the `packageManager` field.
- Docker, for the local compose E2E stack.
- Outside Compose: a reachable sipbridge, an endpoint catalog file naming it, and an mTLS controller certificate it trusts.
- rtpbridge backends listed in the catalog's media section, for media sessions.

## Install

```sh
corepack enable
yarn install --immutable
```

## Build And Test

```sh
yarn test
yarn build
yarn docs:build
```

## Run Locally

```sh
CONTROL_AUTH_MODE=none yarn dev
```

The service listens on `HTTP_PORT`, default `3001`. It exits at startup unless `RTC_ENDPOINTS_FILE`, `SIPBRIDGE_TLS_CERT_FILE`, `SIPBRIDGE_TLS_KEY_FILE` and `SIPBRIDGE_TLS_CA_FILE` are set. See [configuration](./configuration.md).

## Minimal Dynamic Route

Connect to the control WebSocket:

```json
{
    "type": "request",
    "id": "register-1",
    "method": "route.register",
    "params": {
        "routes": [{ "match": "exact", "value": "support" }]
    }
}
```

When a SIP INVITE arrives for `sip:support@example.net`, the gateway sends `sip.invite` to that same connection. Respond with `reject` or `answer`.

## Local E2E

```sh
export SIPBRIDGE_IMAGE=$(node -p 'require("./dependencies/sipbridge-runtime.json").image')
yarn test:native
yarn e2e:compose
```

`yarn test:native` verifies the pinned sipbridge image and runs the native integration tests; `yarn test` skips them. The E2E stack starts the gateway, sipbridge, two rtpbridge backends, SIP probes, RTP probes, WebRTC probes, and recording merge checks.

Log Docker in to the sipbridge registry with a read-only pull credential first. See [local E2E](../development/local-e2e.md).
