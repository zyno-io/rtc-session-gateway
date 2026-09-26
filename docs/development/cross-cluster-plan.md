# Cross-Cluster Implementation Plan

Status: public interfaces implemented and covered by unit/Compose CI. The deployed
platform still needs its own protected adapter, identity/router configuration and
network acceptance. See [the maintained configuration and schema](../guide/cross-cluster.md).
Graceful gateway drain defaults to 30 minutes. This page records implementation
scope; deployment acceptance remains outstanding.

## Recommendation

Run the gateway on the application network with a dedicated Drachtio deployment on the edge network. Retain rtpbridge and TURN on edge; media-backend sharing is an independent choice. Let the deployment platform supply authenticated discovery and a fixed-purpose Drachtio transport adapter that relays reverse route lookups to the gateway. Give the public gateway a small endpoint catalog, strict backend affinity, an authenticated route-match API, and configurable TURN addresses.

Dedicated Drachtio is the recommended starting point: it separates SIP capacity, credentials, admission policy and maintenance from another application's SIP service. The existing platform router can help provision discovery, DNS and proxies without participating in gateway call routing. Sharing an existing Drachtio pool is an optional integration when reducing edge instances is worth coupling deployment and failure behavior. That option requires a common dispatcher which selects the application by the SIP Request-URI host and then its local route/tag.

Use a file catalog for the first integration. Keep ordinary Drachtio TCP and existing rtpbridge DNS configuration available for standalone deployments. Implement one gateway process per Drachtio relationship initially. An injected-stream interface and multiple Drachtio connections can follow when a deployment needs them.

This provides new-call redundancy and planned rolling deployment. Live calls remain owned by their original gateway and backend. Recovering a gateway process or media session after a crash requires a separate design.

## Ownership and Network Paths

| Responsibility | Public gateway | Deployment platform |
| --- | --- | --- |
| Drachtio | SRF authentication, application tag, SIP dialogs and lifecycle. | Protected fixed-target transport, workload authorization, endpoint selection. |
| Media discovery | Validate a generic catalog and select eligible backends. | Translate an authenticated registry into the catalog; optionally publish DNS. |
| Media affinity | Pin each call to a stable backend ID and retain existing clients. | Keep each backend ID associated with its storage identity and individually routable endpoint. |
| Inbound routing | Report whether a local application route matches and whether this instance admits it. | Apply common routing policy and choose an instance connected to the originating Drachtio. |
| Security | Bearer-protected APIs, TLS verification, backend HMAC, bounded inputs. | Certificates, secret mounts, firewall rules, proxies and identity allowlists. |
| Drain | Refuse new work and finish admitted work within the configured deadline. | Stop selecting the old instance and preserve its dependencies and owner access. |
| Media and files | Return configured ICE servers; download recordings from their exact backend. | Public media/TURN reachability, recording storage, an edge-reachable playback origin. |

| Connection | Initiator | Destination and constraints |
| --- | --- | --- |
| Application control | Application | Gateway HTTP/control WS on the application network. |
| Discovery | Application-side adapter | Protected edge registry; metadata only. |
| Drachtio signaling | Gateway, through its local adapter | One protected edge tunnel mapped to one loopback Drachtio admin socket. |
| Reverse INVITE lookup | Edge sends a frame on an established tunnel | Gateway's application-side adapter, or the common dispatcher when sharing Drachtio; no new edge-to-application connection. |
| Media control and recordings | Gateway | Exact per-backend WSS/HTTPS endpoints, with TLS and HMAC. |
| RTP/WebRTC/TURN | Remote peer | Public edge media addresses; media does not traverse the gateway. |
| Playback download | rtpbridge | Allowlisted storage or audio origin reachable from edge. |

See the [deployment map](../guide/cross-cluster.md) for the current paths. Creating DNS records does not provide transport, translate a framed tunnel into TCP, or make private playback URLs reachable.

## Phase 1: Endpoint Catalog and Backend Affinity

### Catalog Contract

Add `RTPBRIDGE_ENDPOINTS_FILE`. When set, the catalog is authoritative: an empty catalog, expired catalog, or missing backend must never trigger DNS or hostname fallback. When unset, retain the existing DNS discovery mode.

The gateway owns this public schema. A private registry client translates its own canonical contracts into it; the gateway does not import that registry's packages or codecs.

```json
{
  "schemaVersion": 1,
  "revision": "publisher-42",
  "validUntil": "2026-09-26T18:00:30.000Z",
  "backends": [
    {
      "id": "media-0",
      "acceptNew": true,
      "control": {
        "url": "wss://10.20.0.40:9100/",
        "tlsServerName": "media-control.example.internal"
      },
      "recordings": {
        "url": "https://10.20.0.40:9100/",
        "tlsServerName": "media-control.example.internal"
      },
      "turn": {
        "urls": [
          "stun:turn-0.example.com:3478",
          "turn:turn-0.example.com:3478?transport=udp",
          "turns:turn-0.example.com:443?transport=tcp"
        ]
      }
    }
  ]
}
```

Use `id` as the public `backendId`. It identifies the backend/storage relationship, independently of its connection IP, port, or certificate name. Keep the existing shared HMAC key and CA bundle configuration for the first version; add per-endpoint TLS names, not a second credential-distribution system. `recordings` and `turn` are optional. Absent `recordings`, derive the HTTP(S) authority from the control endpoint. Initially require root URL paths and prohibit credentials, fragments, and query strings in catalog URLs; reverse proxies can expose the root backend interfaces without ambiguous path rewriting.

Require `validUntil` for dynamically published catalogs. A deliberately static catalog may omit it. A dynamic publisher should refresh every 5 seconds and advertise at most 30 seconds of validity, renewing only while its authenticated source remains current. The revision is an opaque diagnostic value, not an event log or ordered distributed counter. The publisher owns registry epoch/sequence validation.

### Loading and Failure Rules

The publisher writes a complete temporary file and atomically renames it within a shared volume. The gateway reads on startup and checks for replacement every second. Watch the containing directory only as an optimization; correctness must survive rename-based updates and missed file events.

Validate before replacing the current view: supported schema version, unique bounded IDs, boolean admission values, bounded backend count/file size, valid expiry, supported URL schemes, nonempty TLS names when supplied, and valid ICE URLs. Start with limits of 128 backends and 256 KiB per file. Catalog URLs require WSS/HTTPS by default; add `RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT=false`, with an explicit opt-in for local or protected-proxy deployments. The existing `RTPBRIDGE_TLS` setting continues controlling DNS mode. Do not silently downgrade.

On a missing or malformed replacement, retain the last valid view until its original expiry. Do not extend its validity. After expiry, refuse new backend allocation while preserving open clients and exact recording lookup against the last known addresses. At startup with no valid view, media admission stays unavailable; expose the reason separately from Drachtio connectivity. SIP-only configuration can remain usable. When media is configured as required for a deployment, its traffic-readiness policy must also require a valid media catalog and eligible capacity.

Keep two concepts separate: current eligibility for new sessions and exact addressability for an existing backend ID. An entry with `acceptNew: false` remains addressable for established session commands and recording requests. Full removal stops resolving that ID for fresh requests; established clients keep their captured endpoint until they close. A missing ID returns an explicit error. Retain recording-only entries with `acceptNew: false` for the storage retention period instead of accumulating an unbounded gateway history.

### Selection and Pinning

For an unpinned call, round-robin only across eligible entries in a valid catalog. Once selected, pin the call before a concurrent allocation can choose another backend. Release the pin on failed setup or final session release according to the call's ownership and outstanding references. Cover overlapping creation attempts explicitly; the current asynchronous selection can race before registration.

An explicit `backendId` or an existing call pin is a requirement, not a preference. If missing, fail with `MEDIA_BACKEND_NOT_FOUND`; if it cannot admit another session, fail with `MEDIA_BACKEND_UNAVAILABLE` and a bounded diagnostic reason. Do not allocate on a different backend. Strict pinning applies in both catalog and DNS modes; document the change for callers that previously relied on missing preferred IDs falling back. A call admitted before gateway drain may select an eligible backend for its first media session; gateway admission and backend admission are separate checks. Existing session operations continue over their existing client. A draining rtpbridge process may reject creation of additional sessions even for a pinned call.

Do not retry `session.create` on another backend after an ambiguous transport timeout: the first backend may have created the session. Initial admission can reject an obviously unavailable backend before issuing a creation RPC; automatic retries need an explicit idempotency contract before they can cross that boundary.

### Recordings and Transport

Resolve every recording list/download/delete/merge source by its exact backend ID. Support separate control and recording ports and TLS names. Preserve the existing method-and-request-target HMAC format, sign after encoding the final URL, and continue refusing authenticated redirects. Reuse HTTPS agents by TLS identity with bounded cleanup; retire replaced agents only after their in-flight requests finish.

Backend removal must never turn a recording request into a request to another backend. Keeping a StatefulSet ordinal does not recover live media after its process restarts; preserving its recording volume only preserves stored files. Retiring an ordinal requires moving or retaining those files and their address mapping before deleting its catalog entry.

Implementation touches `src/config.ts`, a new catalog/provider module, `src/media-server-manager.ts`, `src/rtpbridge-transport.ts`, recording resolution in `src/media-session-service.ts`, and public error/configuration references. Use a small internal provider interface so DNS and file implementations share selection; a public plugin loader is unnecessary for this phase.

## Phase 2: Protected Drachtio Transport

### First Integration: External Adapter

Keep the gateway's existing `DRACHTIO_HOST`/`DRACHTIO_PORT` interface and point it at an adapter on the same pod's loopback interface. Each accepted local SRF socket gets one authenticated edge tunnel and one fixed Drachtio target. A replacement local connection gets a new tunnel; do not splice a broken connection into an existing SIP dialog or share one SRF stream across gateway instances.

The platform adapter handles framing, mutual TLS, exact workload authorization, heartbeat, bounded buffering, and upstream endpoint selection. It must use the platform's canonical tunnel codecs. Plain TCP forwarding into an application-framed WSS listener is insufficient. Require server identity verification and retain the ordinary Drachtio SRF secret inside the tunnel.

Use one gateway/adapter pair per Drachtio ordinal. Assign a distinct `DRACHTIO_APP_TAG` to every process that can overlap during deployment, within Drachtio's existing 32-character constraint. Bind the tag, instance identity, and Drachtio relationship in trusted deployment metadata. Never derive the tag solely from a stable ordinal that old and new processes share.

For dedicated Drachtio, the adapter carries both its gateway's SRF stream and reverse lookups for that deployment. Become route eligible only after the SRF tag is authenticated and the gateway is ready to handle its configured destinations. During drain, withdraw route eligibility while preserving the stream. The edge transport must support an independently authorized gateway dispatcher without requiring the other platform router or its application dependencies. If the current transport's readiness contract is specific to that router, generalize it in the platform's canonical shared contract and both peers before rollout.

For the optional shared-Drachtio mode, keep the existing platform router as the common route-dispatch policy owner and gateway adapters as signaling-only participants. Prove that the actual edge implementation permits SRF/heartbeat traffic without making those adapters route eligible. Alternatively every eligible adapter must call the same common dispatcher; a gateway-only lookup policy cannot join a general routing round-robin pool. Each mode has an explicit deployment policy; do not mix their eligible router pools.

Keep discovery and signaling out of the main router process's failure domain: a router restart should not close another gateway's SRF stream. Run the adapter beside the gateway or as an independently managed transport workload. Bind any local raw TCP listener to loopback, not a trusted-cluster Service.

### Later Option: Injected Stream

Only add an injected `Duplex`/connection factory when an external TCP adapter proves limiting. Keep raw TCP as the default, keep private framing outside this repository, and expose authenticated connection, draining, and terminal-close lifecycle hooks. Test both transports against the same SIP behavior. Multiple concurrent Drachtio relationships additionally require connection identity on calls and route decisions; that is a separate milestone.

## Phase 3: Inbound Routing and Instance Discovery

### SIP Host Admission

Add an optional `SIP_ALLOWED_DOMAINS_JSON` array of exact inbound SIP hostnames. Leave it unset for existing deployments; configure it explicitly for a service with its own SIP host. Normalize the Request-URI host using SIP parsing before dynamic/static user matching, and apply the same policy to incoming INVITEs and route lookups. This prevents a route registered for one user from admitting that user under an unrelated SIP domain. Unknown or missing hosts reject unless an explicitly configured listener/trunk admission mapping supplies ownership; From/To headers and HTTP Host are not substitutes. Start with exact hostnames rather than a wildcard policy language. Existing dialog requests continue through their owning dialog.

### Public Route-Match API

Add authenticated `POST /routing/lookup`, with a bounded body containing `destinationUri` and optional `destinationUser`. Reuse the current destination parsing and dynamic-before-static route matching. Matching must be side-effect free: no application INVITE request, route registration, outbound call, or fallback-router HTTP request.

Proposed successful response:

```json
{
  "matched": true,
  "acceptNew": true,
  "tag": "session-gw-0-7d61a3"
}
```

An unmatched response is `{"matched":false,"acceptNew":false}`. A matching but disconnected or draining instance reports `matched: true`, `acceptNew: false`. Only return a dispatchable tag when admission is available and a tag is configured. Distinguish invalid input (400), failed authentication (401), an internal lookup failure (5xx), and an ordinary unmatched result (200).

Factor a shared local lookup function so this API and `/drachtio/route` agree. Preserve the existing Drachtio callback and fallback behavior for standalone deployments. The new endpoint does not call that fallback. Blindly probing each gateway's existing `/drachtio/route` can invoke another router and create loops or duplicate decisions.

Publish the HTTP contract with this backend's API documentation/schema. Private adapter-to-router messages belong to the platform's canonical shared package. Neither private message types nor cluster names belong in the public API.

### Platform Routing Policy

The platform maintains a bounded directory of gateway instances, their trusted HTTP addresses, tags, and Drachtio relationships. Use its existing deployment discovery or short-lived leases; do not introduce a call-state database or an unbounded event history. A directory record nominates a candidate; authenticated lookup confirms its current local match and admission.

In dedicated mode, the adapter/dispatcher serves only the gateway's Drachtio deployment. It never delegates unrelated destinations to another product's router. Each ready gateway/adapter pair can answer its own reverse lookups; if a shared dispatcher selects among several instances, it must retain the same exact-Drachtio association.

In shared mode, classify the initial INVITE by its normalized Request-URI host before application-local user matching. An exact gateway host must take precedence over any broader product wildcard. Validate the host at the application admission boundary too; matching only a username would not isolate SIP domains. DNS resolution and TLS SNI do not substitute for SIP destination classification. Drachtio supplies the Request-URI domain to its callback and supports routing to registered application tags; see the [server routing documentation](https://drachtio.org/docs/drachtio-server).

On an incoming lookup:

1. Establish whether the destination belongs to the gateway's configured SIP host and explicit route policy. In dedicated mode reject unowned destinations. In shared mode preserve ordinary platform routing outside gateway ownership; exact host rules precede wildcards.
2. Restrict candidates to gateway instances connected to the exact Drachtio process that originated the lookup.
3. Query a bounded candidate set with a total deadline shorter than the edge callback timeout. Start with at most 8 candidates and a 1-second total deadline, adjusted to the existing platform timeout before implementation.
4. Choose one matching, admitting instance and return its tag on the original reverse lookup channel. Multiple matches for the same application should use a documented balancing policy; conflicting application ownership is a configuration error.
5. For a gateway-owned destination with no healthy candidate, reject with 503. Do not reinterpret a failed gateway lookup as permission to send the call to another application. A definitely unmatched, non-owned destination can follow the ordinary platform policy.

Selection and INVITE dispatch are not atomic. If the selected process starts draining before receiving the INVITE, its existing admission guard rejects the new call with 503. Test this race; lookup success must not reserve a call or promise migration. Retry only the side-effect-free lookup within its budget, never blindly replay an already dispatched INVITE.

In shared mode, all route-eligible platform-router replicas must apply this delegation policy before enabling destinations. Roll out the policy disabled first, then enable it only after the eligible replica set is updated. The selected gateway's tag can differ from the tunnel session that returned the route result if the platform protocol explicitly permits it; validate this in the platform suite. Dedicated mode must work without that router running.

### Application Ownership

Applications register routes on replacements before making them eligible. Existing control WebSockets stay attached to their owner during drain; a new connection handles new work. HTTP-owned calls require a retained instance-specific endpoint, not only a Service that removes unready pods. Keep owner commands available until natural completion or the forced deadline. Directory expiry removes new-call eligibility without immediately deleting that owner address.

## Phase 4: TURN, Playback and Recording Storage

Replace the hardcoded TURN TLS hostname convention with explicit configuration. Prefer per-backend `turn.urls` in catalog mode and a global `COTURN_URLS_JSON` option for DNS-mode deployments with a shared TURN pool. Per-backend URLs take precedence. Generate the existing expiring coturn HMAC credentials only for TURN URLs, keep STUN entries credential-free, and return the same ICE response shape.

Use the existing advertised media IP to construct non-TLS cohosted STUN/TURN defaults only when that behavior is explicitly selected. Do not emit a TLS URL without a configured, certificate-valid hostname. This removes the current deployment-specific domain from the default implementation; document the migration for existing coturn users. Credential TTL and renewal remain separate from the gateway's drain deadline.

Serve playback through object storage or a narrowly scoped audio origin reachable from edge. Configure rtpbridge's exact origin/network allowlists and test redirects and expired signed URLs. Do not make the media backend connect into the trusted application network to retrieve arbitrary application URLs.

Persist recordings per backend or move them to an existing durable collector. The endpoint catalog provides addressability, not retention or archive indexing. The application must retain the returned backend ID/path when it needs retrieval after gateway replacement. A collector can download while the backend is still addressable and publish its own durable storage reference.

## Phase 5: Deployment Lifecycle and Observability

### Startup and Drain Order

Startup: acquire valid discovery and credentials, connect the fixed-target adapter, authenticate/register the gateway SRF tag, connect application owners and register routes, then make the instance eligible for route selection. Readiness of the pod alone does not prove an application's route is registered.

Rollout: start replacement capacity and its application registrations before draining the old gateway. Drain immediately withdraws new-work admission. Keep the old SRF stream, media clients, owner command endpoint, credential validity, and adapter alive for the remaining calls. The default budget is 30 minutes plus up to 5 seconds of cleanup; use a platform termination grace of at least 1,830 seconds without a long pre-stop hook. Add any hook duration and adapter shutdown allowance to that budget.

On Kubernetes, prefer native sidecars (`initContainers` with `restartPolicy: Always`) for the adapter and catalog publisher so they terminate after the gateway. Require cluster support and test the rendered deployment. On another supervisor, configure the same ordering explicitly. An ordinary pair of application containers can receive termination independently and close the transport too soon. Native sidecar termination ordering is documented by [Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/).

Never roll a Drachtio process, rtpbridge process, or adapter carrying live calls solely because the gateway became unready. Backend and Drachtio deployments need their own admission withdrawal, natural drain, and termination budgets. Gateway draining does not make a StatefulSet process restart preserve its sessions. Drain each dependency cohort independently, with replacement capacity and a platform-tested maintenance sequence.

### Failure Behavior

| Event | New work | Existing work |
| --- | --- | --- |
| Catalog publisher/registry unavailable | Continue only until the last catalog's original expiry, then refuse media allocation. | Preserve established clients; exact known recording targets remain usable. |
| Malformed catalog replacement | Keep the last valid view within its expiry; report rejected update. | Do not interrupt clients or substitute destinations. |
| Backend marked non-admitting | Select other eligible backends for unpinned calls. | Preserve sessions and recording access on that backend. |
| Pinned backend removed or unavailable | Fail allocation requiring that ID explicitly. | Keep surviving clients; lost media is not recreated elsewhere automatically. |
| Gateway starts draining | Remove it from new control/SIP/media admission. | Continue owner commands, media and admitted setup up to the deadline. |
| Other product's router restarts | Dedicated gateway routing remains available. Shared mode needs another common-dispatch replica. | Independently hosted gateway adapters stay connected. |
| Gateway/adapter/Drachtio process crashes | Route to replacement capacity after detecting failure. | Affected dialogs can be lost; no crash recovery is claimed. |
| Route lookup times out | Reject within the callback deadline. | Established dialogs do not need a fresh route lookup. |
| Gateway drain deadline expires | Remain non-admitting. | Attempt BYE/CANCEL/media destruction, then exit within the cleanup budget. |

Expose structured status for catalog revision/age/expiry, eligible backend count, failed catalog reloads, and Drachtio connection/admission. Log backend selection failures with stable IDs, route lookup latency/outcome, drain start/deadline/remaining counts, and forced cleanup outcome. The platform logs instance-to-ordinal association, tunnel identity/health, route delegation, and stale directory entries. Never log HMAC keys, client private keys, TURN credentials, or signed playback URLs.

Certificate renewal must not restart active adapters or edge sidecars. Reload leaf material for new handshakes and retain existing authenticated connections. Existing gateway HMAC/CA settings load at startup, so rotate those using overlap and drained gateway replacements. Do not claim zero-disruption HMAC rotation until backend overlap behavior is explicitly supported and tested.

## Delivery and Acceptance

Each milestone should ship its own implementation, documentation, tests, and explicit supported/deferred behavior. Catalog/affinity work and the transport proof can proceed independently; production routing depends on both.

| Milestone | Deliverable | Completion evidence |
| --- | --- | --- |
| 0 | Protected transport proof using one gateway, adapter and dedicated Drachtio. | Real SRF authentication, inbound/outbound call, reverse lookup without the other product's router, heartbeat, wrong-identity rejection, no raw admin exposure. |
| 1 | File catalog, per-endpoint TLS/recording URLs and strict affinity. | Tests for expiry, atomic reload, concurrent pinning, missing ID, non-admitting backend, separate ports/SNI and exact recording targeting. |
| 2 | Authenticated route-match API and dedicated adapter routing. | Same local matching as existing routing; no fallback side effects; host ownership and originating ordinal remain correct. Shared-router delegation is optional. |
| 3 | Configurable TURN and file paths. | Relay-only WebRTC, valid TURN TLS hostname, edge playback, recordings retained across gateway rollout. |
| 4 | Deployment integration and drain validation. | Replacement takes new calls while old SIP/RTP/owner commands remain usable; adapter outlives gateway drain. |
| 5 | Canary and expanded production capacity. | Successful rollback by withdrawing new admission, monitored failures, repeatable multi-ordinal rollout. |

Public CI keeps plaintext and secure Compose suites. Extend secure E2E with two individually addressable rtpbridge backends, different ports/TLS names, a catalog publisher fixture, wrong CA/name/HMAC cases, catalog expiry/removal, concurrent call pinning, and recording downloads after backend admission withdrawal. Add route-match authentication, no-fallback, and drain-race checks. Add configurable TURN coverage using a real local coturn service and a relay-only client.

The platform's private suite tests its actual registry codec, tunnel framing, client URI-SAN allowlist, dedicated route policy, ordinal binding, and deployment rendering. If it enables shared Drachtio, additionally test exact-host-before-wildcard dispatch and common policy across router replicas. Public CI must not require a private checkout or copy the private tunnel protocol. A generic transport fixture can exercise public TCP behavior; support for a specific protected tunnel is established by its owning platform suite.

Before production acceptance, block edge-initiated trusted connections and prove inbound routing still works over existing tunnels. Exercise two Drachtio ordinals and two media backends, owner access through actual load balancers, router restart without gateway tunnel loss, catalog outage, backend admission withdrawal, recording retention, and leaf renewal. Confirm packets use the intended control/media paths. Run normal completion and forced gateway drain with short explicit test budgets; assert the 30-minute default separately instead of making every CI run wait 30 minutes.

Canary the gateway's dedicated SIP host on its own Drachtio ordinal with existing product endpoints untouched. Expand only after the acceptance matrix passes. Rollback withdraws gateway destination admission, retains old owner and transport paths until calls finish, and restores new-call routing to a prior gateway deployment when available. Do not send the gateway's SIP host to another product merely because its gateway is unavailable, and do not reconnect or reassign live calls as part of rollback.

## Deferred Scope

Transparent crash recovery, live dialog transfer, media-session migration, multiple Drachtio connections in one gateway process, a public private-registry client, a bundled DNS operator, dynamic plugin loading, per-tenant backend credentials, and a new recording archive are separate work. The first release should prove the supported network and rolling-deployment behavior before extending those boundaries.
