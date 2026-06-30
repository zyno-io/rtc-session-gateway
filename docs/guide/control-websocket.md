# Control WebSocket

The control WebSocket is the primary integration surface. It is a multiplexed JSON request/response/event channel.

## Connect

Connect to `CONTROL_WS_PATH`, default `/control`.

```http
GET /control
Authorization: Bearer <token>
Upgrade: websocket
```

After connection, the gateway sends:

```json
{
  "type": "event",
  "event": "control.connected",
  "eventId": "connection-id",
  "occurredAt": "2026-06-30T00:00:00.000Z",
  "data": { "connectionId": "connection-id" }
}
```

## Message Envelopes

Request:

```json
{ "type": "request", "id": "req-1", "method": "session.list", "params": {} }
```

Response:

```json
{ "type": "response", "id": "req-1", "ok": true, "result": {} }
```

Event:

```json
{
  "type": "event",
  "event": "sip.terminated",
  "eventId": "event-id",
  "sessionId": "session-id",
  "sequence": 3,
  "occurredAt": "2026-06-30T00:00:00.000Z",
  "data": {}
}
```

## Route Registration

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

Registered routes are owned by the connection. A competing connection cannot register the same route while it is active.

## Inbound SIP Decisioning

When an inbound INVITE matches a WebSocket route, the gateway sends `sip.invite` before allocating rtpbridge resources. This lets the application reject, redirect at the SIP level, or create media only when it is ready to answer.

```json
{
  "type": "request",
  "id": "invite-1",
  "method": "sip.invite",
  "params": {
    "event": "invite",
    "callId": "abc@example.com",
    "sipCallId": "abc@example.com",
    "destinationUri": "sip:support@example.net",
    "destinationUser": "support",
    "sourceUri": "sip:+15551234567@example.net",
    "sdp": "v=0..."
  }
}
```

Reject:

```json
{
  "type": "response",
  "id": "invite-1",
  "ok": true,
  "result": { "action": "reject", "status": 486, "reason": "Busy Here" }
}
```

Answer:

```json
{
  "type": "response",
  "id": "invite-1",
  "ok": true,
  "result": { "action": "answer", "sdp": "v=0..." }
}
```

## Command Parity

The WebSocket command surface is the canonical command surface. HTTP routes call into the same command dispatcher where a REST-like equivalent exists. Recording download and merge remain HTTP streaming routes because WebSocket is not a good fit for large binary PCAP streams.

## Ownership Cleanup

Media sessions created by a control connection are tied to that connection. When the connection closes, owned sessions are torn down.
