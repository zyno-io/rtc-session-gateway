# Media Sessions

Media sessions are backed by rtpbridge when `RTPBRIDGE_HOST` is configured.

## Session Lifecycle

Create:

```json
{ "type": "request", "id": "1", "method": "session.create", "params": { "callId": "call-1" } }
```

When `COTURN_AUTH_SECRET` is configured, the response includes an `iceConfiguration` whose `backendId` and `mediaIp` come from the exact rtpbridge client selected for the session. Its STUN, TURN/UDP, TURN/TCP, and TURN-TLS URLs therefore address the coturn sidecar cohosted with that backend. Use this configuration before gathering the first browser offer.

TURN credentials default to a 24-hour lifetime. `expiresAt` is explicit so long-lived clients can request `webrtc.restartIce` before expiry. Every restart response carries a freshly minted `iceConfiguration` for the session's current backend; clients must replace their peer-connection ICE servers before answering the restart offer.

Delete:

```json
{ "type": "request", "id": "2", "method": "session.delete", "params": { "sessionId": "media-session-1" } }
```

Media sessions created through a control connection are owned by that connection and are cleaned up when it disconnects. SIP dialogs created or accepted through that connection are terminated at the same time so calls cannot remain alive without an application owner.

## WebRTC

Gateway-generated offer:

```json
{
  "type": "request",
  "id": "3",
  "method": "webrtc.createOffer",
  "params": { "sessionId": "media-session-1", "direction": "sendrecv" }
}
```

Browser-generated offer:

```json
{
  "type": "request",
  "id": "4",
  "method": "webrtc.createFromOffer",
  "params": { "sessionId": "media-session-1", "sdp": "v=0..." }
}
```

ICE restart:

```json
{
  "type": "request",
  "id": "5",
  "method": "webrtc.restartIce",
  "params": { "endpointId": "webrtc-1" }
}
```

## RTP

RTP endpoints can be created from a gateway offer or from a remote offer. RTP re-INVITE is available for SIP media renegotiation.

## Bridge And Unbridge

Bridge sessions:

```json
{
  "type": "request",
  "id": "6",
  "method": "media.bridge",
  "params": {
    "sessionId": "media-session-1",
    "targetSessionId": "media-session-2",
    "direction": "sendrecv"
  }
}
```

Unbridge:

```json
{
  "type": "request",
  "id": "7",
  "method": "media.unbridge",
  "params": { "endpointId": "bridge-1" }
}
```

Bridge operations require both sessions to be on the same rtpbridge backend. Sessions with the same `callId` are pinned to the same backend.

## Media Actions

Implemented commands:

- `media.play`
- `media.stop`
- `media.gather`
- `media.playAndGather`
- `media.leaveMessage`
- `dtmf.inject`
- `endpoint.updateDirection`

`media.gather` and `media.playAndGather` let applications collect digits without repeated application round trips for each RFC4733 event.

`media.leaveMessage` waits for sufficient silence using existing rtpbridge VAD behavior, then plays a configured message source.
