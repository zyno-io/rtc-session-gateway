# Getting Started

## Prerequisites

- Node.js 24.
- Corepack.
- Yarn Berry, provided through the `packageManager` field.
- Docker, for the local compose E2E stack.
- A sipbridge native endpoint catalog and mTLS controller identity outside compose.
- rtpbridge when media sessions are required.

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

The service listens on `HTTP_PORT`, default `3001`. Configure `RTC_ENDPOINTS_FILE` and `SIPBRIDGE_TLS_CERT_FILE`, `SIPBRIDGE_TLS_KEY_FILE`, `SIPBRIDGE_TLS_CA_FILE` before startup. See [configuration](./configuration.md).

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

The E2E stack starts the gateway, sipbridge, two rtpbridge backends, SIP probes, RTP probes, WebRTC probes, and recording merge checks.

Authenticate Docker to the canonical sipbridge registry with a project-scoped read-only pull credential before native tests. Offline `yarn test` skips the separately required native suite.
