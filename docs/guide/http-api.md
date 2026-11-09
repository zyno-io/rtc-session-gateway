# HTTP API

The HTTP API supports health checks, static SIP webhooks, management, media commands, and recording streaming.

## Auth

When bearer auth is enabled, command and recording routes require:

```http
Authorization: Bearer <token>
```

`GET /healthz` and `GET /readyz` remain unauthenticated.

## Health

```http
GET /healthz
```

Response:

```json
{ "ok": true, "calls": 0 }
```

`GET /readyz` reports new-work admission separately from liveness. It returns 503
during drain, without an admitting native session, or when media or routes are
missing while `RTPBRIDGE_REQUIRED` or `ROUTES_REQUIRED` is set. Owners can still
register routes while it is unready. See [operations](./operations.md#health).

A native SIP command whose outcome is unknown, such as one whose reply was lost,
returns HTTP 503 with `code: "SIGNALING_UNKNOWN"`; do not replay it. An
unavailable native session returns 503 with `SIGNALING_UNAVAILABLE`. Control
WebSocket responses use the same codes.

## Calls And Sessions

- `GET /calls`
- `GET /calls/:callId`
- `GET /sessions`
- `GET /sessions/:sessionId`
- `POST /calls`
- `DELETE /sessions/:sessionId`
- `POST /calls/:callId/reinvite`
- `POST /calls/:callId/bye`

## Media Commands

- `POST /sessions`
- `POST /sessions/:sessionId/webrtc/offers`
- `POST /sessions/:sessionId/webrtc/from-offer`
- `POST /endpoints/:endpointId/webrtc/answer`
- `POST /endpoints/:endpointId/webrtc/offer-answer`
- `POST /endpoints/:endpointId/webrtc/ice-restart`
- `POST /sessions/:sessionId/rtp/offers`
- `POST /sessions/:sessionId/rtp/from-offer`
- `POST /endpoints/:endpointId/rtp/answer`
- `POST /endpoints/:endpointId/rtp/reinvite`
- `POST /sessions/:sessionId/media/play`
- `POST /sessions/:sessionId/media/bridge`
- `POST /media/bridges/:endpointId/unbridge`
- `DELETE /media/bridges/:endpointId`
- `POST /sessions/:sessionId/media/gather`
- `POST /sessions/:sessionId/media/play-and-gather`
- `POST /sessions/:sessionId/media/leave-message`
- `POST /media/endpoints/:endpointId/dtmf`
- `POST /media/endpoints/:endpointId/direction`
- `DELETE /media/endpoints/:endpointId`

## Recordings

- `POST /sessions/:sessionId/recordings`
- `POST /recordings/:recordingId/stop`
- `GET /recordings`
- `GET /recordings/:backendId`
- `GET /recordings/:backendId/*`
- `POST /recordings/merge`
- `DELETE /recordings/:backendId/*`

Streaming routes return PCAP bytes and should be consumed as binary streams.

`GET /recordings` scans rtpbridge recording indexes and can fan out across multiple configured backends. Production archival flows should usually choose deterministic `filePath` values, persist the returned `backendId`, and then download or merge explicit `{ backendId, path }` targets without a prefix scan.
