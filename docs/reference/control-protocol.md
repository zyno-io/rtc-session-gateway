# Control Protocol Reference

The control WebSocket exchanges JSON messages.

## Envelopes

Request:

```json
{ "type": "request", "id": "id", "method": "method.name", "params": {} }
```

Successful response:

```json
{ "type": "response", "id": "id", "ok": true, "result": {} }
```

Failed response:

```json
{
  "type": "response",
  "id": "id",
  "ok": false,
  "error": { "code": "BAD_REQUEST", "message": "Invalid request" }
}
```

Event:

```json
{
  "type": "event",
  "event": "event.name",
  "eventId": "event-id",
  "sessionId": "session-id",
  "sequence": 1,
  "occurredAt": "2026-06-30T00:00:00.000Z",
  "data": {}
}
```

## Commands

Route:

- `route.register`

SIP:

- `sip.createOutbound`
- `sip.cancelOutbound`
- `sip.reinvite`
- `sip.bye`

`sip.createOutbound` accepts optional SIP digest credentials as `auth: { "username": "...", "password": "..." }`. Both fields are required when `auth` is present. A caller can also supply `outboundAttemptId`; while dialog creation is pending, `sip.cancelOutbound` can send a SIP CANCEL for that ID from the same control connection.

Sessions:

- `session.create`
- `session.get`
- `session.list`
- `session.delete`

When coturn authentication is configured, `session.create` returns an `iceConfiguration` tied to the selected RTPBridge backend. `webrtc.restartIce` renews that configuration without changing backends.

WebRTC:

- `webrtc.createOffer`
- `webrtc.createFromOffer`
- `webrtc.acceptAnswer`
- `webrtc.acceptOffer`
- `webrtc.restartIce`

RTP:

- `rtp.createOffer`
- `rtp.createFromOffer`
- `rtp.acceptAnswer`
- `rtp.reinvite`

Media:

- `media.play`
- `media.playAndWait`
- `media.stop`
- `media.bridge`
- `media.unbridge`
- `media.gather`
- `media.playAndGather`
- `media.leaveMessage`
- `endpoint.updateDirection`
- `dtmf.inject`

Recordings:

- `recording.start`
- `recording.stop`
- `recording.list`
- `recording.delete`

Reserved or deferred:

- `event.ack`
- `sip.answer`
- `sip.reject`
- `vad.start`
- `vad.stop`
- `amd.start`
- `amd.stop`

## Binary Data

Large PCAP recording downloads and merges are HTTP streaming routes, not WebSocket messages.
