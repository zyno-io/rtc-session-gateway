# Direct native discovery contract v2

This is the public endpoint-file contract consumed by the native RTC client.
The gateway consumes v2 and native sipbridge control. Source implementation and
local acceptance do not authorize a deployment or establish production qualification.

Download the [JSON Schema](/contracts/endpoint-catalog-v2.schema.json) and
[synthetic example](/contracts/endpoint-catalog-v2.example.json).

## Ownership and transport

A deployment supplies an atomically replaced file, using its own configuration
process or optional discovery publisher. RTC consumes `RTC_ENDPOINTS_FILE`. It
connects directly to sipbridge and rtpbridge; the sidecar never handles SIP/control
messages, routes, leases, tags or application tunnels. Each section has independent
revision and required expiry. IDs are unique within a section. Missing sections,
invalid documents and unknown versions fail admission; there is no SRF/DNS fallback.
A bad replacement cannot extend the previous valid document's original expiry.

Signaling uses WSS `/v1/control`, subprotocol `sipbridge.control.json.v1`, JSON text
frames and mutual TLS. Connect to the URL address while verifying `tlsServerName`;
never disable certificate validation. Mount `SIPBRIDGE_TLS_CERT_FILE`,
`SIPBRIDGE_TLS_KEY_FILE`, `SIPBRIDGE_TLS_CA_FILE` separately from discovery credentials.
Media keeps its existing endpoint entry shape and existing HMAC/CA file configuration. Catalogs
contain only public endpoint metadata, never credentials or private registry frames.

## Lifecycle and admission

Connect to a known fresh signaling entry even when `acceptNew=false`. Core admission
can remain false until RTC establishes its native session and reports application
status. Sending that status must depend on routes, media and application lifecycle,
not the core's Pod readiness, which would deadlock bootstrap. New calls require a
fresh eligible endpoint plus actual native session readiness. Expired discovery
withdraws new admission; it does not close retained native/media sessions or calls.
Expired metadata must never select a new backend for a new operation.

RTC owns hello, process identity/epoch, monotonic connection attempts, leases,
heartbeats, command correlation, route decisions, status and drain. The wire field
`hello.nexus` identifies the RTC process and does not require a Nexus service.
Use the canonical sipbridge protocol for exact frame validation and error handling.
A memory-core authority change invalidates old contexts; never replay uncertain
operations or migrate retained calls silently. Drain first withdraws new admission,
continues existing work, and waits for the configured shutdown budget before bounded cleanup.

## Application acceptance gate

Before activating an immutable native RTC image, verify v2 parsing,
independent section expiry, invalid replacement retention, verified native TLS/SNI,
hello/lease/heartbeat/reconnect, non-admitting bootstrap, route status/decisions,
media HMAC and recordings, stale-discovery admission, authority changes and drain.
Prove direct SIP/media operation against real native services; schema and registry
fixtures alone do not qualify a deployment or production. Consuming deployments
own their image selection, readiness, activation and acceptance gates.
