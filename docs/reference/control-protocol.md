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
- `sip.reinvite`
- `sip.bye`

Sessions:

- `session.create`
- `session.get`
- `session.list`
- `session.delete`

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
