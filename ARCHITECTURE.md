# RTC Session Gateway architecture

RTC owns application call/session policy and owner connections. sipbridge owns SIP
transactions, dialogs, timers, retransmission, ACK/CANCEL construction and physical
writes. rtpbridge owns media. Discovery supplies authenticated endpoint metadata;
it neither proxies control nor grants call ownership. Runtime activation and real
acceptance evidence remain distinct from source implementation.

## Components

- `endpoint-catalog.ts`: public catalog v2 validation, independent signaling/media
  expiry and atomic-file consumption. Invalid replacements cannot extend prior
  expiry. Configured catalog discovery never falls back to DNS or SRF.
- `sipbridge/`: a pinned, generated canonical JSON wire contract, strict validation
  and bounded mTLS sessions. No private Talk package is a runtime dependency.
- `sipbridge-signaling.ts`: native session/reconnect ownership and application
  context references. RTC process epoch is unpredictable, connection attempts are
  monotonic, and commands are never replayed after uncertainty. The native store
  is the only protocol authority; cached snapshots are command references, not FSMs.
- `sip-gateway.ts`: owner routing, inbound policy, outbound API, call registry,
  application events and cleanup. It delegates all native SIP semantics.
- Existing control/HTTP and media components retain their public API ownership.

## Admission and retention

Connect to known fresh signaling entries even while `acceptNew=false`. Native
status reflects local routes, media and lifecycle, independently of core Pod
readiness, so controller bootstrap cannot deadlock. New calls require fresh
signaling/media metadata and an eligible native session. Missing/expired discovery
withdraws admission without closing existing control/media sessions or calls.
Retained work remains pinned to its original context authority and RTC process.
A core authority change invalidates affected application contexts; never migrate
calls or replay a command to a new authority. Lease/session failures are distinct
from terminal native proof. No uncertain write is reported as successful.

Commands serialize per native context and use current sequence, lease term and
command-time delivery admission. Incoming bytes, physical flows and native
references come only from the verified native peer. RTC does not parse SIP into a
second transaction/dialog FSM or construct arbitrary SIP wire for native output.
Network origination is an explicit owner command, with transient credential
references; credentials never enter retained catalog/snapshot/log artifacts.

## Transport and lifecycle

Native control is WSS `/v1/control`, `sipbridge.control.json.v1`, with mTLS and
verified endpoint SNI. Load projected client/trust files for each new connection.
Only the RTC controller identity is used here; discovery reader credentials remain
in the external sidecar. Strict text JSON framing preserves uint64 strings, bytes,
oneof, Unicode, nesting and size bounds. Binary/compressed/redirected control is
not accepted. Heartbeat, pending RPCs, writes, replay markers and reconnects are
bounded. Unknown peer messages fail the session; timeouts never retry mutations.

`/healthz` is process-local. `/readyz` requires local application admission, fresh
catalog sections, admitting media and an eligible native session. Drain publishes
non-admission before waiting for existing SIP/media/owner work. The native session
stays alive until retained calls finish or bounded forced cleanup expires. HTTP
and WebSocket command surfaces preserve owner affinity during drain. SRF, Drachtio
shared secrets, tags, route callbacks and fallback transports are removed.
