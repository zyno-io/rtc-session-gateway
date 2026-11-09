# Cross-cluster integration plan

Status: retired. The earlier proposal connected RTC to Drachtio through an SRF
transport adapter and a reverse route-lookup API. The implemented design connects
RTC directly to sipbridge over WSS/mTLS and to rtpbridge over WSS/HTTPS, using a
deployment-supplied catalog v2. Any discovery publisher may authenticate to its
own registries without involving RTC or proxying control or media.

Current behavior is documented in:

- [Cross-cluster deployment](../guide/cross-cluster.md): catalog, identity, bootstrap and drain.
- [Native discovery contract](./native-discovery-contract.md): the endpoint-file contract.
- [Native sipbridge implementation notes](./native-sipbridge-plan.md): design decisions and test evidence.
- [Operations](../guide/operations.md): health, readiness and rolling deployment.

## Outcome of the original proposal

Carried into the implementation:

- An authoritative, atomically replaced endpoint file with independent expiry and
  no DNS fallback. Invalid replacements cannot extend the last valid view.
- Stable media backend IDs with strict call pinning: a missing or non-admitting
  pinned backend fails instead of moving the call, and recordings resolve only by
  exact backend ID.
- Separate control and recording URLs and TLS names per media backend.
- Explicit TURN URLs (`COTURN_URLS_JSON`, catalog `turn.urls`) in place of a
  derived TLS hostname.
- `SIP_ALLOWED_DOMAINS_JSON`, `RTPBRIDGE_REQUIRED`, `ROUTES_REQUIRED` and
  readiness-based drain.

Dropped: the SRF transport adapter, application tags, `/drachtio/route`,
`/routing/lookup`, shared-Drachtio dispatch and catalog v1.

## Design rationale still in force

- Do not retry `session.create` on another backend after an ambiguous timeout;
  the first backend may already have created the session.
- Keeping a backend ID does not preserve live media across an rtpbridge restart.
  Retiring a backend requires keeping its recordings, and its catalog entry with
  `acceptNew=false`, for as long as recording access is needed.
- Run the catalog publisher so it outlives the gateway during termination, for
  example as a Kubernetes native sidecar. Set the termination grace period above
  `SHUTDOWN_MAX_WAIT_MS` plus `SHUTDOWN_CLEANUP_TIMEOUT_MS`.
- Draining the gateway does not drain sipbridge or rtpbridge. Each dependency
  needs its own admission withdrawal and drain budget.
