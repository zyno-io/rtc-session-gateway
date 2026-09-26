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

Applications create outbound SIP calls with `sip.createOutbound` on the control WebSocket or `POST /calls` over HTTP. The application supplies the request URI and local SDP offer. The gateway creates a Drachtio UAC dialog and returns the remote SDP answer.

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

Answered, re-INVITE, BYE, and terminated events are delivered to the owning WebSocket connection or to the HTTP receiver URL selected during the INVITE response.
