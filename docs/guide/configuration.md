# Configuration

Configuration is read from environment variables at startup.

| Variable | Default | Description |
| --- | --- | --- |
| `DRACHTIO_HOST` | `127.0.0.1` | Drachtio server host. |
| `DRACHTIO_PORT` | `9022` | Drachtio control port. |
| `DRACHTIO_SECRET` | unset | Drachtio shared secret. |
| `HTTP_PORT` | `3001` | HTTP and control WebSocket port. |
| `CONTROL_WS_PATH` | `/control` | Control WebSocket path. |
| `CONTROL_AUTH_MODE` | inferred | `bearer` or `none`. Production requires bearer unless `none` is explicit. |
| `CONTROL_AUTH_TOKEN` | unset | Bearer token for WebSocket and protected HTTP command routes. |
| `CONTROL_MAX_PAYLOAD_BYTES` | `1048576` | Maximum WebSocket message payload. |
| `CONTROL_REQUEST_TIMEOUT_MS` | `15000` | Timeout for gateway-initiated control requests. |
| `RTPBRIDGE_HOST` | unset | rtpbridge DNS name or IP. Media commands require this. |
| `RTPBRIDGE_PORT` | `9100` | rtpbridge WebSocket port. |
| `RTPBRIDGE_SRV_PORT_NAME` | `ws` | SRV record service name for rtpbridge discovery. |
| `RTPBRIDGE_REQUEST_TIMEOUT_MS` | `10000` | rtpbridge JSON-RPC request timeout. |
| `RTPBRIDGE_CONNECTION_TIMEOUT_MS` | `5000` | rtpbridge WebSocket connection timeout. |
| `COTURN_AUTH_SECRET` | unset | Shared HMAC secret used by the coturn sidecar. When set, media-session and ICE-restart responses include credentials for the coturn instance cohosted with the selected rtpbridge backend. |
| `COTURN_CREDENTIAL_TTL_SECONDS` | `86400` | Lifetime of issued TURN credentials. Clients should renew before `expiresAt`. |
| `RECORDINGS_PATH` | `/var/lib/rtpbridge/recordings` | Recording root on rtpbridge backends. |
| `ROUTES_JSON` | `[]` | Static HTTP route table. |
| `INVITE_HTTP_TIMEOUT_MS` | `15000` | Timeout for static HTTP INVITE webhooks. |
| `EVENT_HTTP_TIMEOUT_MS` | `15000` | Timeout for static HTTP follow-up events. |

## Authentication

Set `CONTROL_AUTH_TOKEN` in production. If `CONTROL_AUTH_MODE` is omitted and a token is present, bearer auth is enabled. If `NODE_ENV=production` or `APP_ENV=production`, startup fails unless bearer auth is configured or `CONTROL_AUTH_MODE=none` is set explicitly.

## Static Routes

Static HTTP routes are useful for simple webhooks:

```json
[
  { "match": "exact", "value": "support", "url": "https://api.example.com/sip" },
  { "match": "userPrefix", "value": "dev-support-", "url": "https://dev.example.com/sip" }
]
```

Dynamic WebSocket route registration is preferred for applications that need connection ownership, session cleanup, and pre-media decisioning.
