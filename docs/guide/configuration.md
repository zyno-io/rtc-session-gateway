# Configuration

Configuration is read from environment variables at startup. The service exits
at startup unless `RTC_ENDPOINTS_FILE` and all three `SIPBRIDGE_TLS_*` files are
configured.

| Variable                          | Default                         | Description                                                                                                                                                                                |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RTC_ENDPOINTS_FILE`              | required                        | Authoritative catalog v2 for signaling and media. See [cross-cluster deployment](./cross-cluster.md#endpoint-catalog-and-identity).                                                        |
| `SIPBRIDGE_TLS_CERT_FILE`         | required                        | Controller client certificate PEM, with a URI SAN that sipbridge authorizes.                                                                                                               |
| `SIPBRIDGE_TLS_KEY_FILE`          | required                        | Controller private key PEM.                                                                                                                                                                |
| `SIPBRIDGE_TLS_CA_FILE`           | required                        | Trusted native server CA PEM bundle.                                                                                                                                                       |
| `SIPBRIDGE_INSTANCE_ID`           | `POD_UID`, else `rtc-<uuid>`    | Native application process instance name. Each startup also gets a fresh random epoch.                                                                                                     |
| `HTTP_PORT`                       | `3001`                          | HTTP and control WebSocket port.                                                                                                                                                           |
| `SHUTDOWN_MAX_WAIT_MS`            | `1800000`                       | Maximum natural call/session drain after SIGTERM, SIGINT, `/drain`, or `/terminate` (30 minutes).                                                                                          |
| `SHUTDOWN_CLEANUP_TIMEOUT_MS`     | `5000`                          | Additional maximum time for final SIP/media/socket cleanup before exit.                                                                                                                    |
| `CONTROL_WS_PATH`                 | `/control`                      | Control WebSocket path.                                                                                                                                                                    |
| `CONTROL_AUTH_MODE`               | inferred                        | `bearer` or `none`. Production requires bearer unless `none` is explicit.                                                                                                                  |
| `CONTROL_AUTH_TOKEN`              | unset                           | Bearer token for WebSocket and protected HTTP command routes.                                                                                                                              |
| `CONTROL_MAX_PAYLOAD_BYTES`       | `1048576`                       | Maximum WebSocket message payload.                                                                                                                                                         |
| `CONTROL_REQUEST_TIMEOUT_MS`      | `15000`                         | Timeout for gateway-initiated control requests.                                                                                                                                            |
| `RTPBRIDGE_HOST`                  | unset                           | DNS/SRV media discovery. Ignored when `RTC_ENDPOINTS_FILE` is set, so the shipped service always uses catalog media. See [DNS media discovery](#dns-media-discovery).                     |
| `RTPBRIDGE_PORT`                  | `9100`                          | rtpbridge WebSocket port for DNS discovery.                                                                                                                                                |
| `RTPBRIDGE_SRV_PORT_NAME`         | `ws`                            | SRV record service name for DNS discovery.                                                                                                                                                 |
| `RTPBRIDGE_REQUEST_TIMEOUT_MS`    | `10000`                         | rtpbridge JSON-RPC request timeout.                                                                                                                                                        |
| `RTPBRIDGE_CONNECTION_TIMEOUT_MS` | `5000`                          | rtpbridge WebSocket connection timeout.                                                                                                                                                    |
| `RTPBRIDGE_TLS`                   | `false`                         | DNS discovery only: use WSS for control and HTTPS for recordings. Catalog entries take the scheme from their URLs.                                                                         |
| `RTPBRIDGE_AUTH_HMAC_SECRET_FILE` | unset                           | Mounted key file matching rtpbridge's `auth_hmac_secret_file`; at least 32 bytes after trailing CR/LF removal.                                                                             |
| `RTPBRIDGE_TLS_CA_FILE`           | unset                           | PEM CA bundle for private rtpbridge certificates. Uses Node's default trust store when unset.                                                                                              |
| `RTPBRIDGE_TLS_SERVERNAME`        | unset                           | Default rtpbridge certificate name and SNI. Catalog entries without `tlsServerName` use it. In DNS discovery with `RTPBRIDGE_TLS=true` it defaults to a DNS-name `RTPBRIDGE_HOST`.        |
| `COTURN_AUTH_SECRET`              | unset                           | Shared coturn REST secret. Required when any TURN URL is returned; media-session and ICE-restart responses then include expiring TURN credentials.                                         |
| `COTURN_CREDENTIAL_TTL_SECONDS`   | `86400`                         | Lifetime of issued TURN credentials. Clients should renew before `expiresAt`.                                                                                                              |
| `RECORDINGS_PATH`                 | `/var/lib/rtpbridge/recordings` | Recording root on rtpbridge backends.                                                                                                                                                      |
| `RECORDING_PATH_PREFIX`           | unset                           | Optional server-enforced top-level recording filename prefix for a shared rtpbridge pool. Restricts starts, lists, downloads, merges and deletes to files with this prefix.                |
| `ROUTES_JSON`                     | `[]`                            | Static HTTP route table.                                                                                                                                                                   |
| `INVITE_HTTP_TIMEOUT_MS`          | `15000`                         | Timeout for static HTTP INVITE webhooks.                                                                                                                                                   |
| `EVENT_HTTP_TIMEOUT_MS`           | `15000`                         | Timeout for static HTTP follow-up events.                                                                                                                                                  |

## Authentication

Set `CONTROL_AUTH_TOKEN` in production. If `CONTROL_AUTH_MODE` is omitted and a token is present, bearer auth is enabled. If `NODE_ENV=production` or `APP_ENV=production`, startup fails unless bearer auth is configured or `CONTROL_AUTH_MODE=none` is set explicitly.

For secure rtpbridge backends, use `wss://` and `https://` catalog URLs and mount the same HMAC key into the gateway and every backend. Set `RTPBRIDGE_AUTH_HMAC_SECRET_FILE` to the gateway's mounted path. The gateway signs each control WebSocket upgrade and each recording list, download, merge-source download, and delete request with rtpbridge's HMAC-SHA256 scheme. This key is separate from the gateway's `CONTROL_AUTH_TOKEN` and the coturn secret. The rtpbridge HMAC key and CA files are loaded at startup; restart the gateway after changing them. Native sipbridge identity files are re-read for each new connection instead.

TLS verifies the backend certificate. Use `RTPBRIDGE_TLS_CA_FILE` for a private CA. Each catalog entry's `tlsServerName` sets the expected certificate name, falling back to `RTPBRIDGE_TLS_SERVERNAME`. Behind a trusted TLS proxy, rtpbridge may explicitly allow plaintext on its protected upstream while retaining HMAC authentication.

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

| Variable                              | Default                        | Behavior                                                                                    |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `RTC_ENDPOINTS_FILE`                  | required                       | Catalog v2 with independently expiring signaling/media sections; overrides DNS.             |
| `RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT` | `false`                        | Permit WS/HTTP media catalog endpoints for development. Native control always requires WSS. |
| `RTPBRIDGE_REQUIRED`                  | `false`                        | Require admitting media capacity for readiness and new-call admission.                      |
| `ROUTES_REQUIRED`                     | `false`                        | Require a registered/static application route for readiness and new-call admission.         |
| `SIP_ALLOWED_DOMAINS_JSON`            | Unset                          | Exact inbound Request-URI hosts admitted before user matching; others receive 404.          |
| `COTURN_URLS_JSON`                    | Unset                          | Explicit deployment-wide ICE URLs; backend catalog URLs take precedence.                    |

See [cross-cluster deployment](./cross-cluster.md) for the catalog, lifecycle and
deployment boundary. TLS TURN needs an explicit URL matching its certificate; the
gateway does not derive a TURN hostname.

The first `SIP_ALLOWED_DOMAINS_JSON` entry is also the host of the `From` URI
built from `callingNumber` on outbound calls; without it the host is `rtc.invalid`.

## DNS media discovery

The media layer still supports `RTPBRIDGE_HOST` DNS/SRV discovery: SRV target
names, the configured `RTPBRIDGE_PORT` and shared TLS name, and round-robin
selection. It applies only when `RTC_ENDPOINTS_FILE` is unset. The native SIP
client requires the catalog, so the shipped service does not currently start in
this mode.

## Native protocol and migration

Native client identity/trust files are read for every new connection. The gateway
verifies the catalog's `tlsServerName` even when the URL contains an IP. Any
credentials a catalog publisher uses are separate from the controller identity
and must not be reused for it.

`DRACHTIO_*` variables and `RTPBRIDGE_ENDPOINTS_FILE` fail configuration
validation. There is no shared-secret SRF connection, application tag, reverse
HTTP route callback or catalog v1 fallback. `/drachtio/route` and
`/routing/lookup` are no longer served; sipbridge delivers inbound requests over
the authenticated native session. `/routing/status` remains a local
admission/route/media status view.

Native command outcomes that are unknown return `SIGNALING_UNKNOWN` (HTTP 503);
callers must not replay them. An unavailable native session returns
`SIGNALING_UNAVAILABLE`. A context with an uncertain mutation accepts no further
commands until native terminal evidence or a state-authority change retires it.
