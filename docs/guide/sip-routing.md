# SIP Routing

Inbound SIP routing uses the destination URI from the INVITE. The gateway extracts the destination user and matches it against dynamic WebSocket routes first, then static HTTP routes.

## Route Types

Exact match:

```json
{ "match": "exact", "value": "support" }
```

Prefix match:

```json
{ "match": "userPrefix", "value": "tenant-" }
```

## Dynamic Routes

Dynamic routes are registered over the control WebSocket with `route.register`. They are owned by a single connection and removed when the connection closes.

Dynamic routes are the right default when an application needs:

- Pre-media SIP answer/reject.
- Session ownership.
- Cleanup when the backend disconnects.
- Events delivered on the same control channel.

## Static HTTP Routes

Static routes are loaded from `ROUTES_JSON` and post INVITE payloads to a configured URL. They are useful for simple webhook integrations.

## Outbound SIP

Applications create outbound SIP calls with `sip.createOutbound` on the control WebSocket or `POST /calls` over HTTP. The application supplies the request URI and local SDP offer. The gateway creates a native sipbridge UAC dialog and returns the remote SDP answer.

For carriers that challenge outbound requests with SIP digest authentication, include both a username and password:

```json
{
  "requestUri": "sip:15551234567@carrier.example.com;transport=tcp",
  "sdp": "...",
  "auth": {
    "username": "carrier-user",
    "password": "carrier-password"
  }
}
```

## Follow-Up Events

Answered, re-INVITE, BYE, terminated and transferred events are delivered to the owning WebSocket connection or to the HTTP receiver URL selected during the INVITE response.

## External Handoff and Return

Use [`sip.transfer`](../reference/control-protocol.md#external-sip-handoff) to transfer an
established caller to a call-center URI. The gateway dials the destination without SDP,
stops every call recording, negotiates direct remote media, releases rtpbridge, and keeps
both SIP dialogs. The application should finalize its handling episode as transferred
and archive the returned recording metadata without sending BYE to the caller.

While handed off, the gateway relays re-INVITE, UPDATE and offerless re-INVITE between
the two peers, ends both dialogs when either party hangs up, and keeps working if the
application connection or rtpbridge stops. Planned drain waits for handed-off calls.

A return uses the application's ordinary inbound address. A REFER on a live known
dialog or an authorized exact `Replaces` match preserves the logical call identity.
`Replaces` authorization requires the source address of either established peer of
that call; a malformed or unauthorized request is refused (`400`/`403`) and scored by
the [SIP firewall](./sip-firewall.md). Unknown references receive `481`. An INVITE
without that correlation starts a new inbound call, including when its caller number
matches an earlier conversation.

If a finalized call returns, create a linked handling episode with a fresh recording.
Leave its earlier timestamps and archive intact. No special SIP address, custom header,
or partner integration is required.

This gateway resolves returns only against dialogs it holds (one gateway, one
sipbridge). In-dialog requests such as REFER must arrive on the dialog's established
transport connection; a REFER on a new TCP connection is refused with `403`.
See the [handoff design](../development/sip-handoff-plan.md).

### Shared rtpbridge with ZynoTalk

Set `SIP_SHARED_MEDIA_HANDOFF_SECRET` to the same dedicated peer secret that
Nexus uses for the admitted Talk tenant. Both systems resolve the same
rtpbridge registry backend ID to the same running instance. Set
`fixedCarrierMedia: true` in the application's initial SIP answer. Include
`sharedMediaReturnUri` on `sip.transfer` and register that
URI as an inbound route. The transfer destination is the Talk tenant's SIP
interconnect URI. Talk phones blind-transfer the handed-off call to the user
part of the configured return URI.

On return, `sip.invite.sharedMedia` gives the application a prepared
`mediaSessionId`, the original `backendId` and `endpointId`, and the established
local `sdp`. Reply with an answer containing that SDP and
`sharedMediaSessionId` equal to the prepared media session ID. Wait for the
correlated `sip.answered` before starting any media work. The gateway retains
the carrier dialog and its initial SDP through both moves.
