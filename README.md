# rtc-session-gateway

Carrier-neutral SIP, WebRTC, RTP, and recording session gateway for backend-controlled real-time communication.

The gateway connects directly to sipbridge over verified mTLS for native SIP signaling, accepts inbound SIP `INVITE`s, routes each destination URI to an owning backend over a multiplexed WebSocket control connection or static HTTP webhook, and exposes rtpbridge-backed media sessions for SIP-less WebRTC, RTP, bridging, playback, DTMF, gathering, leave-message flows, and PCAP recording access.

## Current Capabilities

- Inbound SIP routing by exact destination user or destination-user prefix.
- Pre-media inbound decisioning over the control WebSocket before rtpbridge allocation.
- Outbound SIP origination through the same command surface.
- Multiplexed WebSocket control protocol with request/response commands and gateway events.
- HTTP management API with equivalent command routes for simple integrations and operations.
- rtpbridge-backed media sessions with WebRTC, RTP, file playback, bridge/unbridge, DTMF injection, digit gathering, and leave-message support.
- Recording start/stop/list/download/delete plus gateway-side ordered PCAP segment merge.
- Native integration tests against the pinned sipbridge runtime, plus Docker Compose E2E tests with sipbridge, two rtpbridge backends, coturn, SIP/RTP/WebRTC media, decoded recordings, and failure cleanup. CI runs the native suite and both TLS/HMAC and plaintext media modes before publishing images.

## Documentation

VitePress documentation lives in [`docs/`](docs/).

```sh
corepack enable
yarn install --immutable
yarn docs:dev
```

Start with:

- [Getting Started](docs/guide/getting-started.md)
- [Configuration](docs/guide/configuration.md)
- [Control WebSocket](docs/guide/control-websocket.md)
- [HTTP API](docs/guide/http-api.md)
- [Documentation Plan](docs/documentation-plan.md)

## Development

This project uses Node.js 24 and Yarn Berry through Corepack.

```sh
corepack enable
yarn install --immutable
yarn test
yarn build
```

Run the service locally with an endpoint catalog and sipbridge controller certificate configured (see [Configuration](#configuration)):

```sh
yarn dev
```

Run the automated local E2E stack:

```sh
export SIPBRIDGE_IMAGE=$(node -p 'require("./dependencies/sipbridge-runtime.json").image')
yarn test:native
yarn e2e:compose
```

The pinned sipbridge image is in an authenticated registry; log Docker in with a read-only pull credential first (see [local E2E](docs/development/local-e2e.md)). `yarn test` runs offline and skips the native suite. `yarn test:native` verifies the pinned image against the contract receipt and runs the native integration tests. See [architecture](ARCHITECTURE.md) and [native implementation notes](docs/development/native-sipbridge-plan.md).

The compose runner pulls the CI-published `ghcr.io/zyno-io/rtpbridge:main` image by default. To build and test a local rtpbridge checkout, set `RTPBRIDGE_LOCAL_CHECKOUT=/path/to/rtpbridge`. An explicit `RTPBRIDGE_IMAGE=registry.example.com/rtpbridge:tag` takes precedence over a local checkout. Set `E2E_GATEWAY_PORT` when host port `3001` is already in use.

## Configuration

Core environment variables:

- `RTC_ENDPOINTS_FILE`: required; atomically replaced endpoint catalog v2 listing the sipbridge control endpoint and rtpbridge media backends.
- `SIPBRIDGE_TLS_CERT_FILE`, `SIPBRIDGE_TLS_KEY_FILE`, `SIPBRIDGE_TLS_CA_FILE`: required; mounted native controller identity and server trust.
- `SIPBRIDGE_INSTANCE_ID`: optional process instance name; each startup gets a fresh epoch.
- `HTTP_PORT`: HTTP/control port, defaults to `3001`.
- `CONTROL_WS_PATH`: backend control WebSocket path, defaults to `/control`.
- `CONTROL_AUTH_MODE`: `bearer` or `none`.
- `CONTROL_AUTH_TOKEN`: bearer token for control WebSocket and protected HTTP command routes.
- `RTPBRIDGE_AUTH_HMAC_SECRET_FILE`: mounted HMAC key file shared with rtpbridge.
- `RTPBRIDGE_TLS_CA_FILE`: optional PEM CA bundle for private rtpbridge certificates.
- `RECORDINGS_PATH`: rtpbridge recording root, defaults to `/var/lib/rtpbridge/recordings`.
- `ROUTES_JSON`: static HTTP route table, defaults to `[]`.

The service exits at startup without the catalog and all three `SIPBRIDGE_TLS_*` files. Media backends come from the catalog's `media` section. See [Configuration](docs/guide/configuration.md) for the full list.

Example static routes:

```json
[
    { "match": "exact", "value": "support", "url": "https://api.example.com/sip" },
    { "match": "userPrefix", "value": "dev-support-", "url": "https://dev.example.com/sip" }
]
```

Dynamic route registration over the control WebSocket is preferred for applications that need to accept or reject inbound SIP before media allocation.

## Control WebSocket

Backends connect to `/control`, optionally with `Authorization: Bearer <token>`, then register routes:

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

When an inbound SIP `INVITE` matches that route, the gateway sends a request before allocating rtpbridge media:

```json
{
    "type": "request",
    "id": "invite-1",
    "method": "sip.invite",
    "params": {
        "event": "invite",
        "callId": "abc123@example.com",
        "sipCallId": "abc123@example.com",
        "destinationUri": "sip:support@example.net",
        "destinationUser": "support",
        "sdp": "v=0..."
    }
}
```

The backend can reject immediately:

```json
{
    "type": "response",
    "id": "invite-1",
    "ok": true,
    "result": { "action": "reject", "status": 486, "reason": "Busy Here" }
}
```

Or answer after creating or selecting media:

```json
{
    "type": "response",
    "id": "invite-1",
    "ok": true,
    "result": { "action": "answer", "sdp": "v=0..." }
}
```

Media sessions and SIP dialogs created or accepted over a control connection are owned by that connection and are torn down when it disconnects.

SIGTERM, SIGINT, `POST /drain`, and `POST /terminate` stop admission and let existing calls and media sessions finish before a configurable shutdown deadline. Use `/readyz` for new-traffic readiness and retain existing owner connections during drain. See [operations](docs/guide/operations.md) for rolling deployment requirements.

## Recording Proxy

HTTP recording routes are bearer-protected when `CONTROL_AUTH_MODE=bearer`.

- `GET /recordings?startsWith=<prefix>&skip=<n>&limit=<n>`
- `GET /recordings/:backendId/*`
- `POST /recordings/merge`
- `DELETE /recordings/:backendId/*`

Production applications should prefer deterministic recording filenames over prefix scans. If the application chooses the `filePath` when starting each segment, it already knows the recording path and should not need `GET /recordings` on the hot path. In multi-backend deployments, also retain the `backendId` returned by `recording.start` and `recording.stop`; direct download, delete, and merge targets are `{ backendId, path }`. `GET /recordings` fans out across configured rtpbridge backends and is best reserved for diagnostics, operator browsing, or recovery/backfill flows.

`POST /recordings/merge` accepts an ordered target list and streams one PCAP response. The gateway writes the first global PCAP header once, validates that every source segment has the same global header, and appends packet records in request order.

```json
{
    "targets": [
        { "backendId": "rtpbridge-0", "path": "call_42__seg_0001.pcap" },
        { "backendId": "rtpbridge-1", "path": "call_42__seg_0002.pcap" }
    ]
}
```

Clients should delete source segments only after the merged artifact is durably stored.

Merged or downloaded PCAP files can be decoded with rtpbridge `pcap2audio`; see the rtpbridge recording docs at <https://zyno-io.github.io/rtpbridge/protocol/recording.html#decoding-pcap2audio>.
