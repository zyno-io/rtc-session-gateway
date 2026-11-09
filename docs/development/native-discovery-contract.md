# Direct native discovery contract v2

This is the endpoint-file contract the gateway reads from `RTC_ENDPOINTS_FILE` to
reach sipbridge native control and rtpbridge. Operator-facing setup is in
[cross-cluster deployment](../guide/cross-cluster.md).

Download the [JSON Schema](/contracts/endpoint-catalog-v2.schema.json) and
[synthetic example](/contracts/endpoint-catalog-v2.example.json).

## Ownership and transport

The deployment supplies an atomically replaced file, through its own configuration
process or an optional discovery publisher. RTC only reads the file and connects
directly to sipbridge and rtpbridge. The publisher never handles SIP or control
messages, routes, leases or tunnels. Each section has its own revision and required
expiry, and IDs are unique within a section. Missing sections, invalid documents
and unknown versions are rejected, with no DNS fallback. A bad or missing
replacement cannot extend the previous valid document's expiry.

Signaling uses WSS `/v1/control`, subprotocol `sipbridge.control.json.v1`, JSON text
frames and mutual TLS. RTC connects to the URL address and verifies the server
certificate against `tlsServerName`, and requires sipbridge's negotiated instance
ID to equal the entry `id`. The controller identity comes from
`SIPBRIDGE_TLS_CERT_FILE`, `SIPBRIDGE_TLS_KEY_FILE` and `SIPBRIDGE_TLS_CA_FILE`, never
from publisher credentials. Media entries keep the existing rtpbridge
control/recordings/TURN shape and the existing HMAC/CA file configuration.
Catalogs contain only endpoint metadata, never credentials or registry frames.

## Lifecycle and admission

RTC connects to a fresh signaling entry even when it has `acceptNew=false`.
sipbridge may withhold its own admission until RTC has connected and reported
application status. RTC derives that status from local routes, media and
lifecycle, never from sipbridge's readiness, which avoids a bootstrap deadlock.
New calls require a fresh entry with `acceptNew=true` and a reconciled native
session. Expired signaling refuses new calls; sessions carrying calls stay open,
and idle sessions close. Expired media never selects a backend for new work.

RTC owns hello, process identity and epoch, monotonic connection attempts, lease
use, heartbeats, command correlation, route decisions, status and drain. The wire
field `hello.nexus` identifies the RTC process; it does not name an external
service. Frame validation follows the pinned sipbridge contract. A sipbridge
state-authority change ends old contexts; RTC never replays uncertain operations
or migrates retained calls. Drain withdraws new admission, continues existing work
until it finishes or `SHUTDOWN_MAX_WAIT_MS` expires, then runs bounded cleanup.

## Application acceptance gate

The repository tests cover v2 parsing, independent section expiry, invalid
replacement retention, verified native TLS/SNI and client URI rejection,
reconnect without replay, non-admitting bootstrap, stale-signaling admission,
authority changes, media HMAC and recordings, and drain. They run against real
sipbridge and rtpbridge processes with synthetic credentials; see
[testing](./testing.md). These tests do not qualify a deployment. Consuming
deployments own image selection, readiness, activation and their own acceptance
on the target network.
