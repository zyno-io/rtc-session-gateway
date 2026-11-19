# SIP Firewall

The gateway owns a bounded, in-memory SIP abuse score and block list. A separate
Linux sidecar applies complete snapshots to nftables in sipbridge's network
namespace. Both are included in this repository and work without Redis or a
database. Restarting the gateway discards scores, repeat-offender tiers and
runtime manual blocks.

The gateway stays unprivileged and portable. Only the sidecar needs Linux and
`NET_ADMIN`. CI publishes `ghcr.io/zyno-io/rtc-session-gateway-firewall-sidecar`
with `:main` and a seven-character commit SHA tag for builds from `main`. Release
builds use the Git tag, such as `:v0.1.0`. The highest stable release also gets
`:latest`. To build locally, run `yarn build:firewall-sidecar-image`.

The sidecar image contains the AGPL-3.0-only native dependency `nftables-napi`.
Operating the sidecar as a separate network service keeps the gateway's own
license unaffected. Review the AGPL terms before modifying and redistributing
the sidecar.

## Detection

The gateway scores the source IP of a fresh INVITE that it refuses on its own
authority: an unknown SIP host, or a destination with no route. Normal application
rejection, drain, capacity failures, webhook errors, outbound digest challenges
and established-dialog commands do not score. Decisions run on sipbridge's request
notification, before any owner webhook, media or call state exists, so a scan
creates no RTC call context.

Order for a fresh request:

1. A gateway that is draining, not connected or not admitting answers 503. This is never scored.
2. A banned source gets 403 for any request sipbridge presents to the gateway. It is not scored again and its ban is not extended. sipbridge answers OPTIONS itself, so OPTIONS never reaches this check; only the kernel ban stops an OPTIONS flood.
3. REGISTER and SUBSCRIBE get 405, requests for a forgotten dialog get 481, other unanswerable first requests are refused, and a flow change gets 403. None of these is scored.
4. An INVITE for an unknown host or without a route gets 404 and one observation for its source. With `SIP_FIREWALL_MODE=off` this check does not run at admission and the ordinary handler answers the 404.
5. Everything else proceeds to the normal owner decision.

A no-route 404 is returned but not scored while the gateway cannot know whether the
route should exist: when control routing is in use (no static routes, or owners have
connected) and no control owner is connected, and for `SIP_FIREWALL_ROUTE_GRACE_MS`
(default 300000, 5 minutes) after any control owner disconnects. Valid carrier traffic
for a DID whose owner is briefly away therefore does not earn bans. An unknown-host 404
is always scored.

Scores decay with a ten-minute half-life and ban at 10. Ordinary route failures
weigh 1, plausible North American numbers weigh 0.25 and suspicious international
dial prefixes weigh 2. Percent-escaped SIP user values are decoded for scoring.
Automatic bans last 15 minutes, then 1 hour, 6 hours and 24 hours. Tier memory
expires seven days after the last ban. This is an abuse detector, not a rate
limiter for otherwise valid calls.

Every fresh request sipbridge presents is its own observation. sipbridge absorbs
same-branch retransmissions, so one transaction is scored once, while a scanner that
reuses a Call-ID and CSeq with new tags or branches per target is scored per request.
Loopback sources are never scored or banned. IPv6 sources
are scored and banned per /64 so a scanner rotating inside its prefix still
accumulates.

The source is the address sipbridge observed on the SIP flow (`flow.sourceIp`,
`sourcePort`, `transport` of the request notification). SIP identity headers, HTTP
forwarded headers and caller numbers cannot choose the IP to block. Carrier and
infrastructure allowlists win at both the gateway and the sidecar. A manual CIDR
overlapping even one allowlisted address is refused.

Unknown-`Replaces` observations are opt-in (`SIP_FIREWALL_OBSERVE_UNKNOWN_REPLACES`,
default off). Malformed `Replaces` headers and `Replaces` from an address that is
neither peer of the matched call are scored normally; see
[external handoff](../development/sip-handoff-plan.md#referral-return-and-deduplication).

### The source IP must reach sipbridge

Everything depends on sipbridge seeing the real client address. Behind Kubernetes
Services use `externalTrafficPolicy: Local` (or a load balancer that preserves the
client source address); with SNAT, every caller looks
like the node or load balancer, the carrier-wide allowlist protects nobody and a
single scanner can ban the whole front end. Verify with a test INVITE to an
unrouted user: the gateway logs `No route for INVITE` (info) with `sourceIp`, and a
resulting ban logs `Firewall ban` with the banned address. The IP must be the caller's.

### Kernel scope

The sidecar drops **all inbound and forwarded traffic** from a blocked source to
the shared namespace, including existing TCP connections and signaling for active
calls from that address. Allowlist trusted carriers. Host networking is
unsupported. Packet logging is disabled; named kernel counters remain available.

## Deployment requirements

- **Dedicated shared namespace.** Run the sidecar in a network namespace shared only
  with sipbridge: a Kubernetes pod containing sipbridge and the sidecar, or Compose
  `network_mode: service:sipbridge`. Grant `NET_ADMIN` to the sidecar container only.
  The gateway and sipbridge stay unprivileged.
- **Protected CIDRs.** Set `FIREWALL_PROTECTED_CIDRS` on the sidecar (see below). It
  is a sidecar-local allowlist that snapshots cannot override. It must include the
  gateway's address (the sidecar's own receiver and sipbridge's control port sit in
  the namespace the ban applies to) and every probe, kubelet and node range that
  reaches the pod. Otherwise a ban of, or a mistaken snapshot entry for, one of
  those addresses would cut off health checks or the control session. Loopback is
  always protected. Bans and snapshots broader than IPv4 /8 or IPv6 /16 are rejected.
- **Single gateway owner.** One gateway publishes to each sidecar. A new gateway
  instance starts with empty learned state and replaces the previous snapshot when
  its start time is later. Two gateways must not compete for one receiver.
- **Receiver reachability.** Keep the receiver off public SIP ingress. It requires
  TLS and a bearer token on non-loopback addresses. The sidecar never opens a
  connection to the gateway and holds no application credential.

## Gateway configuration

| Variable                                | Default                | Meaning                                                                                             |
| --------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `SIP_FIREWALL_MODE`                     | `shadow`               | `off`, `shadow` or `enforce`. Shadow scores without applying blocks.                                |
| `SIP_FIREWALL_ALLOWLIST_JSON`           | `[]`                   | Trusted IPv4/IPv6 addresses or CIDRs.                                                               |
| `SIP_FIREWALL_OBSERVE_UNKNOWN_REPLACES` | `false`                | Score unknown-dialog `Replaces` observations (opt-in).                    |
| `SIP_FIREWALL_ROUTE_GRACE_MS`           | `300000`               | Do not score no-route 404s while no owner is connected or for this long after an owner disconnects. |
| `SIP_FIREWALL_THRESHOLD`                | `10`                   | Positive integer score threshold.                                                                   |
| `SIP_FIREWALL_HALF_LIFE_MS`             | `600000`               | Score decay half-life.                                                                              |
| `SIP_FIREWALL_BAN_TTLS_SEC`             | `900,3600,21600,86400` | Positive, nondecreasing tiers, maximum 24 hours each.                                               |
| `SIP_FIREWALL_MAX_RECORDS`              | `100000`               | Maximum score/tier records and bounded transaction markers.                                         |
| `SIP_FIREWALL_MAX_BLOCKS`               | `10000`                | Maximum manual plus automatic candidates.                                                           |
| `SIP_FIREWALL_ADMIN_TOKEN`              | unset                  | Separate bearer for operator APIs; unset disables access.                                           |
| `SIP_FIREWALL_SNAPSHOT_TOKEN`           | unset                  | Read-only bearer for `/firewall/snapshot`.                                                          |
| `SIP_FIREWALL_PUBLISHER_URL`            | unset                  | Receiver URL ending in `/v1/snapshot`; unset leaves publication to an external agent.               |
| `SIP_FIREWALL_PUBLISHER_TOKEN`          | unset                  | Receiver bearer; required with the publisher URL.                                                   |
| `SIP_FIREWALL_PUBLISHER_CA_FILE`        | system trust           | CA for an HTTPS receiver.                                                                           |

Record capacity never evicts a live ban. Expired scores and markers are swept in
bounded batches; new observations are skipped when capacity is exhausted. Limits and
skipped counts are exposed by `/firewall/status`. Automatic bans use exact
addresses (a /64 for IPv6 sources); manual bans may use CIDRs. IPv4-mapped IPv6
normalizes to IPv4.

## Operator APIs

These APIs require their own bearer even when application control allows anonymous
access. The snapshot token cannot issue application commands or mutate firewall
state. See the [HTTP API reference](../reference/http-api.md#firewall) for the list.

| Endpoint                                   | Credential | Behavior                                                                                                             |
| ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /firewall/status`                     | Admin      | Mode, instance, revision, counts, skip counters, publisher status.                                                   |
| `GET /firewall/blocks?offset=0&limit=100`  | Admin      | Candidate blocks with reasons, tiers and millisecond epoch expiry; limit at most 1000.                               |
| `POST /firewall/blocks`                    | Admin      | JSON `target`, `ttlSeconds`, `reason`. Requires enforce mode. TTL at most seven days; reason at most 128 characters. |
| `DELETE /firewall/blocks?target=192.0.2.1` | Admin      | Remove this exact manual/automatic target and its score/tier. Continued abuse can cause a new ban.                   |
| `GET /firewall/snapshot`                   | Snapshot   | Complete effective bans and allowlist.                                                                               |

Allowlist changes require configuration and a drained restart. Blocks are finite;
there is no durable audit or emergency suppression history. Record operator actions
externally when needed.

## Snapshot contract

The public contract is owned by `src/firewall-contract.ts`. A minimal snapshot:

```json
{
    "schemaVersion": 1,
    "instanceId": "gateway-process-uuid",
    "startedAt": "2026-10-07T00:00:00.000Z",
    "revision": 3,
    "generatedAt": "2026-10-07T00:00:05.000Z",
    "allowlist": ["192.0.2.10"],
    "blocks": [{ "target": "198.51.100.1", "expiresAt": "2026-10-07T00:15:00.000Z" }]
}
```

Full snapshots publish promptly on change and every five seconds. Publication
coalesces updates and never waits on the SIP path. The receiver admits at most two
bounded requests, each at most 2 MiB. Snapshot age must be at most one minute,
future timestamps at most five seconds, and expiries at most seven days after
generation. Same-instance revisions cannot go backward or change policy at the
same revision. A different instance must have a later startup timestamp;
synchronize replacement clocks.

The receiver validates a complete replacement before accepting it. Kernel apply is
asynchronous; HTTP 200 acknowledges desired state, not completed packet
enforcement. `GET /v1/status`, using the receiver bearer, reports receipt and apply
times, received and applied instance/revision, active mirror entries and apply
errors. Publication success alone is not proof of a successful kernel apply.

The sidecar diffs a serialized in-memory mirror, recreates changed-timeout entries
and reconciles every 30 seconds. Overlapping host/CIDR candidates install as their
outer active range to avoid native interval conflicts; retained narrower candidates
are reconsidered after its removal or expiry. The gateway's admission check stays
active during any reconciliation gap. Kernel TTLs never renew on snapshot refresh.

## Sidecar configuration and recovery

| Variable                                                   | Default        | Meaning                                                                              |
| ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `SIP_FIREWALL_LISTEN_HOST`                                 | `127.0.0.1`    | Snapshot receiver bind address.                                                      |
| `SIP_FIREWALL_LISTEN_PORT`                                 | `9098`         | Receiver port.                                                                       |
| `SIP_FIREWALL_RECEIVER_TOKEN`                              | unset          | Required publication/status bearer.                                                  |
| `SIP_FIREWALL_RECEIVER_TOKEN_FILE`                         | unset          | Read the receiver bearer from a mounted file instead.                                |
| `SIP_FIREWALL_TLS_CERT_FILE` / `SIP_FIREWALL_TLS_KEY_FILE` | unset          | Required together for non-loopback listeners.                                        |
| `SIP_FIREWALL_TABLE`                                       | `rtc_sipguard` | Owned IPv4 table; IPv6 appends `6`. Use a distinct name per namespace owner.         |
| `FIREWALL_PROTECTED_CIDRS`                                 | unset          | Comma-separated addresses/CIDRs never dropped; must include the gateway (see above). |

Direct publication requires HTTPS with peer verification, except loopback HTTP.
A bad or unavailable snapshot preserves the last valid state. Finite kernel bans
self-expire even with the sidecar stopped. On sidecar restart, its first valid
snapshot recreates only its owned tables and reapplies everything; this briefly
fails open and removes stale entries left by a lost mirror. A restart of the whole
sipbridge namespace also fails open until the next sync, which arrives with the gateway's next
periodic publication (every five seconds). An apply failure preserves
successful changes and retries. Firewall failure does not gate sipbridge or gateway
readiness. Receiver token and TLS replacements take effect on sidecar restart; the
gateway's publisher reads its CA on each publication.

## Validation

Run `yarn test` for state, snapshot, authentication and recovery coverage. The
native test suite (`yarn test:native`) drives real sipbridge for source
admission: a banned source is refused without owner calls, an unrouted INVITE is
scored once per transaction, and a scan creates no call context. Run
`yarn e2e:firewall` with Docker for an isolated packet test (Compose project with
sipbridge, gateway, the sidecar sharing sipbridge's namespace, an attacker and an
allowlisted carrier): IPv4 scans, actual UDP and TCP drops, carrier allowlisting,
manual bans, unblock, adjacent-range handling, timeout changes, kernel expiry with
the sidecar stopped, missed-update and restart recovery, gateway owner
replacement, and sipbridge namespace replacement. It creates disposable TLS
fixtures, needs `SIPBRIDGE_IMAGE` from `dependencies/sipbridge-runtime.json`, tears
down its own containers and network, and never touches the host firewall. IPv6 is exercised
with SIP over UDP and TCP from an attacker in a separate /64 to sipbridge's `[::]:5060`
listener (an automatic IPv6 ban covers a /64, which must not contain the gateway or a carrier). See the
[firewall plan](../development/sip-firewall-plan.md) for what each run covered.
