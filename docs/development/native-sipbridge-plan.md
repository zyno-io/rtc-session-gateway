# Native sipbridge application implementation plan

This plan implements the application half of the already merged discovery/platform
work. It does not enable production. Source code, protocol integration tests and
real media acceptance are separate evidence scopes.

## 1. Pin the public native contract

Import the canonical schema and its generated TypeScript JSON types/field metadata
at a recorded source revision matching sipbridge's schema receipt. Keep strict
canonical JSON validation, uint64 bigint handling, byte/base64 preservation,
correlation and bounded mTLS transport independent of private Talk packages.
Add a local provenance/hash check; protocol changes start in the schema owner.
Do not hand-maintain a second message catalog or modify the native Go reducers.

## 2. Consume public catalog v2

Validate the whole document, both independently expiring sections, unique bounded
IDs, direct native control paths, TLS names and existing media/recording/TURN
shapes. Missing initial data is unavailable. Preserve the last valid document only
until its original section expiries; malformed/deleted/expired replacement data
cannot renew it. Retain endpoint identity for established calls/recording access.
A configured catalog has no host/DNS or v1 compatibility fallback. Keep explicit
media-only standalone configuration where no catalog is configured.

## 3. Implement native session ownership

RTC creates one startup process epoch and monotonically increasing connection
attempt per signaling endpoint. Maintain bounded reconnect/backoff and re-read
client key/certificate/CA files for new handshakes. Validate native hello version,
capabilities, identity, state authority, lease and bounds. Bootstrap against fresh
non-admitting endpoints. Publish status from routes/media/lifecycle, never from
core readiness; new-call selection additionally requires native and catalog
eligibility. Heartbeat/session loss fails pending RPCs without ending retained
calls or replaying commands. Authority changes fence old contexts explicitly.

## 4. Native SIP/application boundary

Implement typed ingress decisions, exact-context ingest, request/event receipts,
application probes, context flow-adoption receipts and ephemeral credential lookup.
Maintain only local context ownership/reference/sequence and policy state. Reject
unknown retained contexts and unsupported methods without inventing authority.
Sipbridge retains transaction/dialog/ACK/CANCEL/timer/write semantics.

Serialize commands per context with command-time directory/delivery admission.
Treat UNKNOWN, disconnect and timeout as uncertain; never replay a mutation.
Native terminal proof and process authority changes drive bounded local cleanup.
Protect event ordering/deduplication and command/event races, particularly cancelled
INVITE while backend policy is pending and outbound CANCEL before a context exists.

## 5. Preserve RTC application APIs

Replace `drachtio-gateway.ts` with SIP application orchestration using the native
signaling layer. Preserve inbound owner pre-media decisions, static HTTP routing,
outbound originate/cancel, caller identity and proxy/auth inputs, remote/local
re-INVITE, BYE, owner events, reservations and disconnect cleanup. Use a native
dialog reference in CallRegistry; expose no SRF types. Keep media/control commands,
owner affinity and recording-prefix fencing unchanged. Remove drachtio-srf,
Drachtio configuration, tagged route/fallback HTTP endpoints and SRF fixtures.

## 6. Health, admission and shutdown

Make health process-only and readiness independently require application routes,
configured media, fresh discovery and eligible native connectivity. Publish
non-admission immediately on drain, route withdrawal, media loss or source expiry.
Continue retained native/media operations across discovery loss and planned drain.
Keep the configured two-hour platform drain and bounded forced cleanup; do not
close native sessions before retained application work has finished.

## 7. Verification

- Catalog: independent expiry, invalid replacement retention, duplicate IDs,
  malicious endpoints, no credentials/fallback, retained endpoints and recordings.
- Sessions: real mTLS/SNI/URI authorization, strict JSON/capability/lease checks,
  heartbeat deadlines, certificate reload, bounded reconnect and late replies.
- Native calls: real sipbridge memory service with synthetic certificates and
  SIP peers; inbound accept/reject, outbound answer/CANCEL/non-2xx, re-INVITE,
  BYE, duplicate native events, uncertain operations, owner disconnect and drain.
- Compose: replace Drachtio with independently pinned sipbridge; secure native
  control in both media test modes. Exercise existing two-backend media/HMAC,
  audio, TURN/WebRTC, recording and teardown scenarios against native signaling.
- Run build, unit/integration tests, both media E2E profiles and documentation
  build. Report actual evidence and any remaining environment constraints.

## 8. Handoff and deployment

Publish the reviewed RTC image and adapter image by immutable digest. Configure
real application-owner routes. Select them and enable the Trusted workload in
staging only after native acceptance. Verify delivered controller/server leaves,
core bootstrap, native SIP/media/recording and full drain. Production activation
remains a separate reviewed rollout. Do not treat test fixtures as production
qualification, and do not enable a workload with the old SRF image.
