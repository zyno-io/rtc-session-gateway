# Events Reference

## `control.connected`

Sent immediately after a WebSocket control connection is accepted.

```json
{
  "type": "event",
  "event": "control.connected",
  "eventId": "connection-id",
  "occurredAt": "2026-06-30T00:00:00.000Z",
  "data": { "connectionId": "connection-id" }
}
```

## `sip.invite`

Gateway-initiated request, not an event. Sent to the route owner before media allocation.

## `sip.answered`

Sent when a SIP dialog is answered.

## `sip.reinvite`

Sent as a gateway-initiated request when the remote side sends a re-INVITE that requires an application SDP answer.

## `sip.bye`

Sent when the remote side sends BYE.

## `sip.terminated`

Sent when a SIP dialog is terminated.

## `media.rtpbridge`

Forwards rtpbridge events for a media session owned by a control connection.

```json
{
  "type": "event",
  "event": "media.rtpbridge",
  "eventId": "event-id",
  "sessionId": "media-session-1",
  "sequence": 1,
  "occurredAt": "2026-06-30T00:00:00.000Z",
  "data": {
    "event": "endpoint.ice_state_changed",
    "data": { "endpointId": "webrtc-1", "iceState": "disconnected" }
  }
}
```

## Ordering

Events that include `sessionId` also include a per-session `sequence` number. Consumers should use this for local ordering checks, not as a durable global event offset.
