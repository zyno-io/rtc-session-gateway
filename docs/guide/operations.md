# Operations

## Deployment Shape

A production deployment needs:

- `rtc-session-gateway` HTTP/control port.
- Drachtio server reachable from the gateway.
- SIP carriers or SBCs reachable from Drachtio.
- rtpbridge backends reachable from the gateway when media is enabled.
- UDP media paths between rtpbridge and remote RTP/WebRTC peers.

When Drachtio uses outbound request routing, configure `DRACHTIO_APP_TAG` and point Drachtio's `INVITE` request handler at `/drachtio/route`. The route endpoint selects the gateway tag only for a currently registered gateway route. If `DRACHTIO_ROUTE_FALLBACK_URL` is configured, all other requests are forwarded to that existing router.

## Health

`GET /healthz` returns process health and active call count.

## Security

- Use bearer auth for the control WebSocket and protected HTTP routes.
- Put the service behind a trusted load balancer or private network.
- Avoid exposing rtpbridge directly to application clients.
- Treat recording paths as sensitive. Download, merge, and delete routes should only be available to trusted services.

## Logging

The service uses Pino. Log records include namespace fields for gateway, control, media, and rtpbridge components.

## Shutdown

The `/terminate` route triggers process exit. Prefer platform-native graceful shutdown where available. Closing a control WebSocket tears down its owned media sessions and SIP dialogs; HTTP-owned resources should be explicitly torn down by their application before shutdown.

## Local Compose

`yarn e2e:compose` starts the complete local simulation stack and tears it down after the run. Set `RTPBRIDGE_IMAGE` to test a specific rtpbridge image, or `RTPBRIDGE_LOCAL_CHECKOUT` to build one from a local checkout.
