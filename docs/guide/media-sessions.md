# Media Sessions

Media sessions are backed by rtpbridge when `RTPBRIDGE_HOST` is configured.

## Session Lifecycle

Create:

```json
{ "type": "request", "id": "1", "method": "session.create", "params": { "callId": "call-1" } }
```

Delete:

```json
{ "type": "request", "id": "2", "method": "session.delete", "params": { "sessionId": "media-session-1" } }
```

Sessions created through a control connection are owned by that connection and are cleaned up when it disconnects.

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
