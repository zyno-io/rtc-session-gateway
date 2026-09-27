# Configuration

Configuration is read from environment variables at startup.

| Variable | Default | Description |
| --- | --- | --- |
| `DRACHTIO_HOST` | `127.0.0.1` | Drachtio server host. |
| `DRACHTIO_PORT` | `9022` | Drachtio control port. |
| `DRACHTIO_SECRET` | unset | Drachtio shared secret. |
| `HTTP_PORT` | `3001` | HTTP and control WebSocket port. |
| `SHUTDOWN_MAX_WAIT_MS` | `1800000` | Maximum natural call/session drain after SIGTERM, SIGINT, `/drain`, or `/terminate` (30 minutes). |
| `SHUTDOWN_CLEANUP_TIMEOUT_MS` | `5000` | Additional maximum time for final SIP/media/socket cleanup before exit. |
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
| `RTPBRIDGE_TLS` | `false` | Use WSS for control and HTTPS for recordings. Accepts `true` or `false`. |
| `RTPBRIDGE_AUTH_HMAC_SECRET_FILE` | unset | Mounted key file matching rtpbridge's `auth_hmac_secret_file`; at least 32 bytes after trailing CR/LF removal. |
| `RTPBRIDGE_TLS_CA_FILE` | unset | PEM CA bundle for private rtpbridge certificates. Uses Node's default trust store when unset. |
| `RTPBRIDGE_TLS_SERVERNAME` | host | Certificate name and SNI override. Defaults to `RTPBRIDGE_HOST` for DNS names, including when discovery returns IPs or SRV targets. |
| `COTURN_AUTH_SECRET` | unset | Shared HMAC secret used by the coturn sidecar. When set, media-session and ICE-restart responses include credentials for the coturn instance cohosted with the selected rtpbridge backend. |
| `COTURN_CREDENTIAL_TTL_SECONDS` | `86400` | Lifetime of issued TURN credentials. Clients should renew before `expiresAt`. |
| `RECORDINGS_PATH` | `/var/lib/rtpbridge/recordings` | Recording root on rtpbridge backends. |
| `RECORDING_PATH_PREFIX` | unset | Optional server-enforced top-level recording filename prefix for a shared rtpbridge pool. Restricts starts, lists, downloads, merges and deletes to files with this prefix. |
| `ROUTES_JSON` | `[]` | Static HTTP route table. |
| `INVITE_HTTP_TIMEOUT_MS` | `15000` | Timeout for static HTTP INVITE webhooks. |
| `EVENT_HTTP_TIMEOUT_MS` | `15000` | Timeout for static HTTP follow-up events. |

## Authentication

Set `CONTROL_AUTH_TOKEN` in production. If `CONTROL_AUTH_MODE` is omitted and a token is present, bearer auth is enabled. If `NODE_ENV=production` or `APP_ENV=production`, startup fails unless bearer auth is configured or `CONTROL_AUTH_MODE=none` is set explicitly.

For secure rtpbridge backends, set `RTPBRIDGE_TLS=true` and mount the same HMAC key into the gateway and every selected backend. Set `RTPBRIDGE_AUTH_HMAC_SECRET_FILE` to the gateway's mounted path. The gateway signs each control WebSocket upgrade and each recording list, download, merge-source download, and delete request with rtpbridge's HMAC-SHA256 scheme. This key is separate from the gateway's `CONTROL_AUTH_TOKEN` and the coturn secret. Key and CA files are loaded at startup; restart the gateway after changing them.

TLS verifies the backend certificate. Use `RTPBRIDGE_TLS_CA_FILE` for a private CA and `RTPBRIDGE_TLS_SERVERNAME` when the certificate name differs from `RTPBRIDGE_HOST`. All discovered backends must present a certificate valid for that name. Behind a trusted TLS proxy, rtpbridge may explicitly allow plaintext on its protected upstream while retaining HMAC authentication.

## Playback Policy

Configure `file_download_origins` on each rtpbridge backend before playing HTTP audio. Entries must match the exact scheme, host, and port. Private or loopback destinations also require an entry in `file_download_networks`. For example:

```toml
file_download_origins = ["https://audio.example.com"]
file_download_networks = []
```

These are rtpbridge TOML settings. The gateway forwards the playback URL and headers; rtpbridge enforces the policy, including redirects.

## Static Routes

Static HTTP routes are useful for simple webhooks:

```json
[
  { "match": "exact", "value": "support", "url": "https://api.example.com/sip" },
  { "match": "userPrefix", "value": "dev-support-", "url": "https://dev.example.com/sip" }
]
```

Dynamic WebSocket route registration is preferred for applications that need connection ownership, session cleanup, and pre-media decisioning.

## Cross-cluster admission and discovery

| Variable | Default | Behavior |
| --- | --- | --- |
| `RTPBRIDGE_ENDPOINTS_FILE` | Unset | Authoritative, atomically replaced endpoint catalog; overrides DNS. |
| `RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT` | `false` | Permit WS/HTTP catalog endpoints for development. |
| `RTPBRIDGE_REQUIRED` | `false` | Require admitting media capacity for readiness and new-call routing. |
| `ROUTES_REQUIRED` | `false` | Require a registered/static application route before readiness. |
| `SIP_ALLOWED_DOMAINS_JSON` | Unset | Exact inbound Request-URI hosts admitted before user matching. |
| `COTURN_URLS_JSON` | Unset | Explicit deployment-wide ICE URLs; backend catalog URLs take precedence. |

See [cross-cluster deployment](./cross-cluster.md) for the schema, lifecycle and
protected transport boundary. TLS TURN needs an explicit URL matching its
certificate; the gateway no longer derives an infrastructure-specific hostname.
