# rtc-session-gateway

Carrier-neutral SIP, WebRTC, RTP, and recording session gateway for backend-controlled real-time communication.

The gateway connects to Drachtio for SIP signaling, accepts inbound SIP `INVITE`s, routes each destination URI to an owning backend over a multiplexed WebSocket control connection or static HTTP webhook, and exposes rtpbridge-backed media sessions for SIP-less WebRTC, RTP, bridging, playback, DTMF, gathering, leave-message flows, and PCAP recording access.

## Current Capabilities

- Inbound SIP routing by exact destination user or destination-user prefix.
- Pre-media inbound decisioning over the control WebSocket before rtpbridge allocation.
- Outbound SIP origination through the same command surface.
- Multiplexed WebSocket control protocol with request/response commands and gateway events.
- HTTP management API with equivalent command routes for simple integrations and operations.
- rtpbridge-backed media sessions with WebRTC, RTP, file playback, bridge/unbridge, DTMF injection, digit gathering, and leave-message support.
- Recording start/stop/list/download/delete plus gateway-side ordered PCAP segment merge.
- Local Docker Compose E2E stack with Drachtio, two rtpbridge backends, SIP probes, RTP probes, WebRTC probes, and recording merge validation.

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

Run the service locally against an external Drachtio server:

```sh
yarn dev
```

Run the automated local E2E stack:

```sh
yarn e2e:compose
```

The compose runner defaults to the CI-published `ghcr.io/zyno-io/rtpbridge:main` image. To test a local rtpbridge checkout, set `RTPBRIDGE_LOCAL_CHECKOUT=/path/to/rtpbridge`. To test a specific image, set `RTPBRIDGE_IMAGE=registry.example.com/rtpbridge:tag`. Set `E2E_GATEWAY_PORT` when host port `3001` is already in use.

## Configuration

Core environment variables:

- `DRACHTIO_HOST`: Drachtio server host, defaults to `127.0.0.1`.
- `DRACHTIO_PORT`: Drachtio control port, defaults to `9022`.
- `DRACHTIO_SECRET`: Drachtio shared secret, optional.
- `DRACHTIO_APP_TAG`: application tag advertised to a Drachtio server using outbound request routing.
- `DRACHTIO_ROUTE_FALLBACK_URL`: existing Drachtio HTTP router to use when no gateway route owns an INVITE.
- `HTTP_PORT`: HTTP/control port, defaults to `3001`.
- `CONTROL_WS_PATH`: backend control WebSocket path, defaults to `/control`.
- `CONTROL_AUTH_MODE`: `bearer` or `none`.
- `CONTROL_AUTH_TOKEN`: bearer token for control WebSocket and protected HTTP command routes.
- `RTPBRIDGE_HOST`: rtpbridge service DNS name or IP; enables media commands when set.
- `RTPBRIDGE_PORT`: rtpbridge WebSocket port, defaults to `9100`.
- `RECORDINGS_PATH`: rtpbridge recording root, defaults to `/var/lib/rtpbridge/recordings`.
- `ROUTES_JSON`: static HTTP route table, defaults to `[]`.

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
