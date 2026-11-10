# RTC Session Gateway architecture

RTC owns application call/session policy and owner connections. sipbridge owns SIP
transactions, dialogs, timers, retransmission, ACK/CANCEL construction and physical
writes. rtpbridge owns media and recording storage. A deployment-owned catalog
file supplies endpoint metadata; it does not proxy control or grant call ownership.

## Components

- `endpoint-catalog.ts`: catalog v2 validation, independent signaling/media expiry
  and atomic-file consumption. An invalid, missing or unreadable replacement keeps
  the last valid document without extending its expiry. A configured catalog never
  falls back to DNS.
- `sipbridge/`: the pinned generated wire contract, strict canonical JSON
  validation and the bounded mTLS control client.
- `sipbridge-signaling.ts`: native session ownership, reconnect, retained-context
  inspection and per-context command serialization. sipbridge's store is the only
  protocol authority; cached snapshots are command references, not a second FSM.
- `sip-gateway.ts`: owner routing, inbound policy, the outbound API, the call
  registry, application events and cleanup. It delegates SIP semantics to sipbridge.
- Control/HTTP and media components keep their existing public API ownership.

## Admission and retention

RTC opens a native session to every fresh signaling entry, including entries with
`acceptNew=false`, and reports its own admission status to sipbridge from local
routes, media and lifecycle. sipbridge can therefore become ready after RTC
connects without a readiness deadlock. RTC itself admits new calls only through a
connected, reconciled session to a fresh entry with `acceptNew=true`.

When the signaling section expires or an entry disappears, new calls are refused.
Sessions that still carry calls stay open until those calls end; sessions with no
retained calls are closed. Retained work stays pinned to its original state
authority, lease term and RTC process. If a reconnect reports a different state
authority or lease term, RTC ends the affected local contexts and never migrates
calls or replays commands to the new authority.

Before readmitting new calls, a reconnect inspects retained contexts with at most
eight concurrent reads. Only an owned ended snapshot or a retirement proof from the
current authority retires a call; a lookup failure or absence without proof
leaves it fenced. Inspection never clears an uncertain-mutation fence.

Commands serialize per native context, carry the next sequence number and
command-time delivery admission, and are never retried. A lost reply or unknown
outcome fences the context and surfaces as `SIGNALING_UNKNOWN`. Incoming bytes,
flows and native references are accepted only from the verified native peer. RTC
does not parse SIP into a transaction/dialog FSM or construct SIP wire. Outbound
digest credentials stay in RTC memory and are released to sipbridge only through a
context-bound credential lookup; they never appear in the catalog or snapshots.

## Transport and lifecycle

Native control is WSS `/v1/control` with subprotocol `sipbridge.control.json.v1`,
mTLS and verification against the catalog's `tlsServerName`. Client certificate,
key and CA files are re-read for each new connection. The negotiated sipbridge
instance ID must equal the catalog entry ID. Framing is strict text JSON
preserving uint64 strings, bytes, oneofs and size bounds; compression and redirects
are disabled. Heartbeats, pending RPCs, write buffers, event receipts and reconnect
backoff are bounded. An unknown peer message fails the session.

`/healthz` is process-local. `/readyz` requires an admitting native session (as
above) and a non-draining lifecycle, plus admitting media when `RTPBRIDGE_REQUIRED`
is set and a route when `ROUTES_REQUIRED` is set. Drain withdraws local admission
first, then waits for existing SIP, media and owner work; the native peer receives
the non-admitting status on the next refresh. Native sessions stay open
until retained calls finish or forced cleanup runs at the drain deadline. Existing
owner WebSockets stay connected during drain.

## Public integration boundary

RTC's runtime dependencies are sipbridge native control, rtpbridge media/recording
APIs and application-owner HTTP or WebSocket connections. It imports no
product-specific backend package and calls no registry or tunnel service. The
catalog file is a deployment input: an operator, supervisor or optional discovery
publisher can write it, and RTC never uses that publisher's credentials.
Deployment charts, registry access and product-specific adapters belong to the
consuming deployment.

The contract receipt in `dependencies/` pins the schema distributed by sipbridge and
the generated bindings matching its published receipt. The wire field `hello.nexus`
names the calling application process; it does not identify an external service.

## Evidence

Unit tests cover catalog parsing and the native client's fencing logic. `yarn
test:native` runs the pinned sipbridge binary with memory state and synthetic
certificates. The Compose suite covers SIP, media, recordings and drain against
real sipbridge and rtpbridge containers. None of these qualify a deployment
network, delivered identities or production rollout; see
[testing](docs/development/testing.md).

## Staging acceptance owner

`acceptance/main.ts` is a separate, opt-in test-controller entry point, published
from this repository as an acceptance-controller image. It uses only RTC's public
owner WebSocket API, registers exact test routes on each discovered process, and
keeps ownership pinned to each connection. It has no Kubernetes API permissions,
backend SDK, discovery-reader credential or native-controller private key.
The normal gateway image/entry point does not launch it.

Owner requests, per-call media and receipts are bounded. A control disconnect
fails pending work and never replays a mutation; a replacement connection only
registers fresh routes. Reports contain counters and scenario outcomes, never SIP,
SDP, bearer tokens or raw upstream errors. Its HTTP listener binds loopback by
default; mutation/report access requires the configured owner token. Tests against
fixtures and its media smoke scenarios do not establish real audio/TURN/drain
acceptance; the deployment runner must collect those separately.
