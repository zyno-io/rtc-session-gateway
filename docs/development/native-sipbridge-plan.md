# Native sipbridge implementation notes

Status: implemented. This page records the design decisions behind RTC's native
sipbridge client and how they are tested. [ARCHITECTURE.md](https://github.com/zyno-io/rtc-session-gateway/blob/main/ARCHITECTURE.md),
the [discovery contract](./native-discovery-contract.md) and the
[deployment guide](../guide/cross-cluster.md) own current behavior. Source,
protocol integration tests and deployment acceptance are separate evidence
scopes; nothing here qualifies a deployment.

## 1. Pinned native contract

RTC imports sipbridge's schema and generated TypeScript JSON types/field metadata
at one recorded revision, with hashes in `dependencies/sipbridge-contract.json`
(see [dependency receipts](https://github.com/zyno-io/rtc-session-gateway/blob/main/dependencies/README.md)).
The client keeps strict canonical JSON validation, uint64 bigint handling,
byte/base64 preservation, correlation and bounded mTLS transport within this
repository. Protocol changes start in sipbridge; RTC does not maintain a second
message catalog.

## 2. Catalog v2

The whole document is validated: both independently expiring sections, unique
bounded IDs, the native control path, TLS names and the existing
media/recording/TURN shapes. Missing initial data means unavailable. The last
valid document is kept only until its original section expiries; malformed,
deleted or stale replacements cannot renew it. Endpoint identity is retained for
established calls and recording access. A configured catalog has no DNS or v1
fallback.

## 3. Native session ownership

Each startup creates a random process epoch; connection attempts increase
monotonically. Reconnect backoff starts at 250 ms and is capped at 5 seconds.
Client key, certificate and CA files are re-read for each handshake. The hello
must negotiate the required capabilities, a matching instance ID, the state
authority, lease and heartbeat bounds. RTC bootstraps against non-admitting
entries and reports status from routes, media and lifecycle rather than
sipbridge readiness. Session loss fails pending RPCs without ending retained calls
or replaying commands; a changed state authority or lease term ends affected
contexts.

## 4. SIP/application boundary

RTC implements typed ingress decisions, exact-context ingest, request and event
receipts, application probes, flow-adoption receipts and ephemeral credential
lookup. It keeps only local context ownership, reference, sequence and policy
state, and rejects unknown contexts and unsupported methods. sipbridge keeps
transaction, dialog, ACK, CANCEL, timer and write semantics.

Commands serialize per context with command-time delivery admission. UNKNOWN
results, disconnects and timeouts are uncertain and never replayed. Native
terminal proof and authority changes drive local cleanup. Request and event
receipts are deduplicated by fingerprint, so duplicate deliveries run owner
policy once. A native CANCEL ends a pending inbound call even while owner policy
is still running, and an outbound cancel requested before the native context
exists is sent as soon as the context is returned.

## 5. Application APIs

`sip-gateway.ts` replaced the Drachtio gateway and preserves inbound pre-media
owner decisions, static HTTP routing, outbound originate/cancel, caller identity
and proxy/auth inputs, re-INVITE, BYE, owner events, reservations and disconnect
cleanup. `CallRegistry` holds a native dialog reference. Media/control commands,
owner affinity and recording-prefix fencing are unchanged. `drachtio-srf`,
Drachtio configuration, tagged route/fallback HTTP endpoints and SRF fixtures were
removed; see [configuration migration](../guide/configuration.md#native-protocol-and-migration).

## 6. Health, admission and shutdown

Health is process-only. Readiness requires an admitting native session and no
drain, plus media and routes when `RTPBRIDGE_REQUIRED` and `ROUTES_REQUIRED` are
set; see [operations](../guide/operations.md#health). Local admission withdraws
when those conditions fail; native status reflects the change on the next refresh.
Retained native and media work continues across discovery loss and planned drain.
Planned shutdown keeps native control open for retained calls until they end or
forced cleanup runs.

## 7. Verification

| Area | Evidence |
| --- | --- |
| Catalog parsing, expiry, invalid replacement, affinity | `test/endpoint-catalog.test.ts` |
| Canonical JSON, uncertainty fencing, reconnect inspection | `test/sipbridge-codec.test.ts` |
| Inbound/outbound calls, CANCEL, re-INVITE, BYE, bootstrap, stale signaling, TLS name and client URI rejection, duplicate ingress, owner disconnect, reconnect, authority change, digest auth | `test/sipbridge-native.test.ts` via `yarn test:native` (pinned sipbridge, memory state, synthetic certificates) |
| Two-backend media/HMAC, audio, TURN/WebRTC, recordings, teardown and drain over native signaling | `yarn e2e:compose`, in both media modes |

No dedicated tests cover heartbeat deadlines or certificate reload on reconnect.

## 8. Deployment handoff

A deployment selects tested RTC, sipbridge and rtpbridge images by digest,
configures owner routes, and supplies catalog v2 and the native controller
identity. Any catalog publisher belongs to the deployment; RTC needs no adapter
image or private backend service. Verify native SIP, media, recordings and full
drain on the target network before activation.
