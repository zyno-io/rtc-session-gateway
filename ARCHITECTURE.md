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
- `sip-sdp.ts`, `sip-handoff-contract.ts`: pure SDP relay, `Replaces`/`Refer-To`
  parsing and the public handoff contract. In `sip-gateway.ts`, `transfer()`
  dials a late-offer destination, cuts the carrier over and then relays between two
  `NativeDialog`s (offerless re-INVITE answers arrive through sipbridge's
  `sip.reinvite-ack.v1`). The registry links the legs as one logical call; a leg
  with an uncertain native outcome is fenced and never commanded again. See the
  [handoff design](docs/development/sip-handoff-plan.md).
- `sip-firewall.ts`, `firewall-*.ts`: in-memory abuse score and block list, the
  operator/snapshot API and the optional snapshot publisher. `sip-gateway.ts`
  installs a source policy that sipbridge's request-decision path runs for each
  fresh request (banned source 403; unscored 503 when not admitting; scored 404
  for unknown host or unrouted INVITE). Sources are the flow addresses sipbridge
  observed.
- `firewall-sidecar/`: separate image (nftables-napi is AGPL-3.0-only and is never
  in the gateway) sharing sipbridge's dedicated network namespace. It applies
  complete snapshots through nftables; `FIREWALL_PROTECTED_CIDRS` keeps the gateway
  and probe ranges reachable. One gateway publishes to one sidecar.
- Control/HTTP and media components keep their existing public API ownership.

## Admission and retention

RTC opens a native session to every fresh signaling entry, including entries with
`acceptNew=false`, and reports its own admission status to sipbridge from local
routes, media and lifecycle. sipbridge can therefore become ready after RTC
connects without a readiness deadlock. RTC itself admits new calls only through a
connected, reconciled session to a fresh entry with `acceptNew=true`.

When the signaling section expires or an entry disappears, new calls are refused.
Sessions that still carry calls stay open until those calls end; sessions with no
retained calls are closed. Work is pinned to its original state authority, lease
term and RTC process. With Memory sipbridge, losing an established control session
expires that session's application term and sipbridge ends all of its calls
([memory-core](https://github.com/zyno-io/sipbridge/blob/main/docs/memory-core.md)
on control-session disconnect). RTC therefore ends every call it holds on that
sipbridge as soon as the session closes, and a reconnect admits only fresh calls
under a new term. Lifecycle events of an earlier term that sipbridge redelivers to
the new session are acknowledged and ignored; per-message errors never close the
session, because a close ends every call. RTC never migrates calls or replays
commands to a new authority or term.

A reconnect still inspects any context that remains locally, with at most eight
concurrent reads. Only an owned ended snapshot or a retirement proof from the
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
backoff are bounded; a full receipt table evicts its oldest receipts. Transport
violations (bad framing, a wrong-direction message, a mismatched heartbeat or
result) fail the session. An unsupported or invalid application message is dropped
without closing it, since closing ends every call of the session's term.

`/healthz` is process-local. `/readyz` requires an admitting native session (as
above) and a non-draining lifecycle, plus admitting media when `RTPBRIDGE_REQUIRED`
is set and a route when `ROUTES_REQUIRED` is set. Drain withdraws local admission
first, then waits for existing SIP, media and owner work; the native peer receives
the non-admitting status on the next refresh. Native sessions stay open
until retained calls finish or forced cleanup runs at the drain deadline. Existing
owner WebSockets stay connected during drain.

## Public integration boundary

RTC's runtime dependencies are sipbridge native control, rtpbridge media/recording
APIs and application-owner HTTP or WebSocket connections. The optional firewall
adds one outbound HTTPS push from the gateway to its sidecar receiver and no
other runtime dependency. It imports no
product-specific backend package and calls no registry or tunnel service. The
catalog file is a deployment input: an operator, supervisor or optional discovery
publisher can write it, and RTC never uses that publisher's credentials.
Deployment charts, registry access and product-specific adapters belong to the
consuming deployment.

The contract receipt in `dependencies/` pins the schema distributed by sipbridge and
the generated bindings matching its published receipt. The wire field `hello.controller`
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

## Shared rtpbridge SIP handoff

The application selects `fixedCallerMedia: true` in its initial answer.
RTC rejects later requests to renegotiate that caller dialog and uses shared
media for its SIP transfers. The destination dialog exchanges inactive SDP
and private handoff metadata. The gateway resolves the SIP next
hop and pins the outbound flow to a numeric address in the configured peer
subnet. In-dialog return requests require a source in that allowlist and the
matching peer dialog and handoff nonce. The gateway requires
a known rtpbridge registry backend ID and moves the original RTP endpoint into
the destination session on that backend after the destination has answered.
Recording finalization precedes the move. The destination verifies exact
endpoint inventory before connecting media.

A return REFER from the linked destination dialog resumes the saved
application route. The gateway validates the SIP Refer-To field and chooses
the current owner of the saved route. The gateway creates an empty session
owned by that application on the original backend. The return invite gives the application
that session ID, the original endpoint ID and the established local SDP. The
application prepares its binding and echoes the session ID. The gateway asks the
destination to move the endpoint by in-dialog INFO with a deadline
for starting the move. An exact inventory match commits the return. After an
ambiguous reply the gateway waits through the move window and checks inventory
again. A verified absence keeps the call on the peer. When ownership cannot
be verified, the gateway closes both dialogs to release the call. A successful
return registers the endpoint in the prepared session before publishing the
answer event and retiring the peer dialog. The peer dialog also refuses SDP
modifications. The application starts returned IVR work after the answer event.
