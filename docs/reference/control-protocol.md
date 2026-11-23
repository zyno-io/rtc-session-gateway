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
`transferId` (1-128 UTF-8 bytes of `[A-Za-z0-9._:-]`; anything else is rejected as `BAD_REQUEST`, on both the control
WebSocket and HTTP, because admitted IDs are retained for the life of the call). Optional `headers`, `callingNumber`, `callingName`, `proxy`, and complete `auth`
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

Calls answered with `fixedCallerMedia: true` use [shared rtpbridge handoff](../guide/sip-routing.md#shared-rtpbridge-handoff).
For standard handoff, the destination is dialed with an INVITE without SDP and must
provide a final SDP offer. Provisional (early) SDP is ignored and never relayed. All recording stops
must succeed before the carrier receives the destination offer. Success releases
call media and retains both SIP dialogs with `ownership: "handed-off"`; media flows
directly between the remote endpoints.

The result and `sip.transferred` event contain `transferId`, `logicalCallId`, `state`,
`startedAt`, `committedAt`, `destinationSipCallId`, and `recordings`. Each finalized
recording contains `recordingId`, optional `backendId`, `filePath`, `recordingPath`,
`downloadPath`, `durationMs`, and `packets`. Archive these files through the recording HTTP API.

Repeated transfer IDs return the recorded result without dialing again: the gateway keeps
the current result and the last 16 earlier finished results for the live call, so a delayed
retry of an older failed transfer returns that failure. It fails with `CONFLICT` once any
later transfer on the call has completed (the failure no longer describes the call). The
gateway also remembers every transfer ID it has admitted on the call, up to 256: a retry of
an ID whose result has been evicted fails with `CONFLICT` and never dials, and once 256 IDs
have been used, new transfer IDs on that call fail with `CONFLICT`. Concurrent
different transfers, and transfers of a call that is not application-owned, fail with
`CONFLICT`. If a call's native signaling outcome is unknown the command fails with
`SIGNALING_UNKNOWN`; do not replay it. An expired control request does not prove SIP
failure: query `session.get` for its `transfer` and `ownership` before retrying or
terminating the call. Status lasts for the live SIP call; it is not a durable
operation history. An application disconnect leaves completed handoffs running.

Inbound `sip.invite` requests include `logicalCallId`. Correlated returns also carry
`returning: true`, `previousSessionId` and a unique `returnAttemptId`; the same
`returnAttemptId` is echoed on that attempt's `sip.answered` and on its `sip.terminated`
event when the attempt fails. A REFER on a known dialog whose target is an
ordinary inbound route returns locally. Authorized INVITE/Replaces preserves identity;
an unrelated referred INVITE starts a new logical call. Start the returned application's
IVR after `sip.answered`, which confirms the new carrier path. While a call is handed off, `sip.reinvite` on it fails with `CONFLICT` and `sip.bye` ends both dialogs; the gateway relays remote re-INVITE and UPDATE between the two peers itself. See the
[handoff design and limitations](../development/sip-handoff-plan.md).

A return invite that the application answered can still fail (for example the carrier hangs up or rejects
the re-INVITE while the application is preparing media). The owner then receives a `sip.terminated`
event for the attempt, carrying the invite's `callId`, its `returnAttemptId` and a `reason`:

- For a REFER return the attempt shares the live call's `sessionId`. `return-aborted` means the call itself
  ended (whether or not the owner is the call's owner, and including a carrier that hung up or was fenced
  after the application's re-INVITE was accepted but before `sip.answered`): the call's own end event
  (`sip.bye`, or `sip.terminated` with another reason such as `return-carrier-uncertain`) is delivered first
  and `return-aborted` follows it. `return-failed` means the call continues after the failed attempt. If the
  call then ends, its `sip.bye` or `sip.terminated` follows `return-failed` when both events use the same
  canonical HTTP receiver URL or the same control connection. An attempt that reached `sip.answered`
  never also receives a `return-aborted`. `sip.answered` waits for the final REFER NOTIFY retries only when
  the referrer is the retained carrier leg.
- For an INVITE/Replaces return the replacement has its own `callId`. If the replaced call ended or the owner
  left before the replacement was answered, the attempt reports `return-failed`; a failure after the
  application answered (including the replaced call ending during the answer) reports `answer-failed`.
  Both carry the replacement's `callId`.
- Limitation: an INVITE/Replaces (a return to the gateway or a replacement of an application-owned call) must carry an SDP offer. The gateway does not surface the initial
  ACK's SDP to the owner, so an offerless Replaces INVITE is rejected (488 for an empty body, 415 for a
  non-SDP body) before the pair is claimed or the application consulted; the existing leg or handed-off pair stays intact.
  Ordinary offerless inbound INVITEs are unaffected (they retire nothing).

Release any media prepared for the invite when this event arrives. Handle `sip.terminated` per `reason` and
idempotently, and match attempts by `returnAttemptId` (not by `callId`, which a later attempt on the same
call shares), so a delayed failure for attempt A never releases media prepared for attempt B. An owner that
never answered the invite receives nothing further.

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
