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
- `sip.transfer`
- `sip.bye`

`sip.createOutbound` accepts optional SIP digest credentials as `auth: { "username": "...", "password": "..." }`. Both fields are required when `auth` is present. A caller can also supply `outboundAttemptId`; while dialog creation is pending, `sip.cancelOutbound` can send a SIP CANCEL for that ID from the same control connection.

### External SIP handoff

`sip.transfer` accepts `sessionId`, `mediaSessionId`, `requestUri`, and an application-generated
`transferId`. Optional `headers`, `callingNumber`, `callingName`, `proxy`, and complete `auth`
credentials use the outbound SIP format. The requester must own both sessions, and the
dedicated media session must contain the RTP endpoint advertised by the source dialog.
Shared agent WebRTC media sessions cannot be handed off. A draining gateway rejects
new transfers with `SHUTTING_DOWN`.

```json
{
    "type": "request",
    "id": "handoff-request",
    "method": "sip.transfer",
    "params": {
        "sessionId": "carrier-dialog",
        "mediaSessionId": "call-media",
        "requestUri": "sip:collections@call-center.example",
        "transferId": "application-generated-uuid"
    }
}
```

The destination is dialed with an INVITE without SDP and must provide a final SDP
offer. Provisional (early) SDP is ignored and never relayed. All recording stops
must succeed before the carrier receives the destination offer. Success releases
call media and retains both SIP dialogs with `ownership: "handed-off"`; media flows
directly between the remote endpoints.

The result and `sip.transferred` event contain `transferId`, `logicalCallId`, `state`,
`startedAt`, `committedAt`, `destinationSipCallId`, and `recordings`. Each finalized
recording contains `recordingId`, optional `backendId`, `filePath`, `recordingPath`,
`downloadPath`, `durationMs`, and `packets`. Archive these files through the recording HTTP API.

Repeated transfer IDs return the current result without dialing again. Concurrent
different transfers, and transfers of a call that is not application-owned, fail with
`CONFLICT`. If a call's native signaling outcome is unknown the command fails with
`SIGNALING_UNKNOWN`; do not replay it. An expired control request does not prove SIP
failure: query `session.get` for its `transfer` and `ownership` before retrying or
terminating the call. Status lasts for the live SIP call; it is not a durable
operation history. An application disconnect leaves completed handoffs running.

Inbound `sip.invite` requests include `logicalCallId`. Correlated returns also carry
`returning: true` and `previousSessionId`. A REFER on a known dialog whose target is an
ordinary inbound route returns locally. Authorized INVITE/Replaces preserves identity;
an unrelated referred INVITE starts a new logical call. Start the returned application's
IVR after `sip.answered`, which confirms the new carrier path. While a call is handed off, `sip.reinvite` on it fails with `CONFLICT` and `sip.bye` ends both dialogs; the gateway relays remote re-INVITE and UPDATE between the two peers itself. See the
[handoff design and limitations](../development/sip-handoff-plan.md).

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

`rtp.createOffer` accepts `srtp: true` for required SRTP or `srtpOptional: true` for opportunistic SRTP. The two options are mutually exclusive; opportunistic mode allows the peer to select plain RTP by omitting crypto from its answer.

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
