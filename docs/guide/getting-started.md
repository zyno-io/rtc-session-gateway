# Getting Started

## Prerequisites

- Node.js 20 or newer.
- Corepack.
- Yarn Berry, provided through the `packageManager` field.
- Docker, for the local compose E2E stack.
- A Drachtio server for SIP signaling outside compose.
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

The service listens on `HTTP_PORT`, default `3001`, and connects to Drachtio using `DRACHTIO_HOST`, `DRACHTIO_PORT`, and `DRACHTIO_SECRET`.

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
yarn e2e:compose
```

The E2E stack starts the gateway, Drachtio, two rtpbridge backends, SIP probes, RTP probes, WebRTC probes, and recording merge checks.
