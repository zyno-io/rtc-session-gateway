# Staging acceptance controller

The optional acceptance owner is built from this repository. It uses RTC's public
owner WebSocket API; it has no platform SDK, Kubernetes token, native controller
key or discovery-reader identity. The normal gateway entry point never starts it.
The `acceptance-controller` Docker target includes the repository's test probes;
CI publishes it as `ghcr.io/zyno-io/rtc-session-gateway:acceptance-main`. Deploy by
immutable digest. The normal final Docker target remains `production`.

## Configure and run

```sh
RTC_ACCEPTANCE_CONTROL_URL=ws://gateway-instances:3001/control \
RTC_ACCEPTANCE_RESOLVE_INSTANCES=true \
RTC_ACCEPTANCE_TOKEN_FILE=/run/owner-token/CONTROL_AUTH_TOKEN \
node dist/acceptance/main.js
```

The token file is required and re-read for each new owner connection. The URL
must have no embedded credentials, query or fragment. Use `wss:` and
`RTC_ACCEPTANCE_CA_FILE` where owner control crosses an untrusted network. With
instance resolution enabled, the owner connects to each IPv4 address of the
headless Service (maximum 16). That Service must publish not-ready addresses so
routes can be registered before RTC admission becomes ready.

`RTC_ACCEPTANCE_ROUTE` defaults to `rtc-acceptance`. Only exact test routes are
registered: that name answers with media allocated through RTC, and the name
with `-reject` appended rejects with 486 before media allocation. No wildcard or
product route is registered. Calls remain pinned to the original owner connection;
unknown operations are never replayed. A request timeout closes the owner connection
so RTC can reclaim its resources, rather than leaving uncertain media allocated.

The controller binds `127.0.0.1:3002` by default. Use `RTC_ACCEPTANCE_BIND` and
`RTC_ACCEPTANCE_PORT` explicitly for Pod probes. There is no public ingress.

- `GET /healthz`: process health.
- `GET /readyz`: at least one owner connection has registered test routes; this
  does not prove that RTC's native signaling/media admission is ready.
- `GET /report`: bearer-authenticated counters and bounded scenario results.
- `POST /run`: bearer-authenticated body `{"scenario":"media"}`, `outbound` or
  `cancel`. Outbound scenarios require an explicit `RTC_ACCEPTANCE_OUTBOUND_URI`
  pointing at a controlled SIP responder. Never point it at a carrier or real user.

The media smoke checks RTP/WebRTC offer creation and recording start/stop/delete.
It does not prove audio. Reports identify this limited evidence scope and contain
no SDP, SIP bodies, caller identities or credentials. On shutdown, the controller
withdraws its routes where possible, terminates its calls and closes its owner
connections; RTC's owner-disconnect cleanup is the final resource boundary.
Keep the controller running, on a fixed image, while testing a gateway drain.

## Real network probe

Run the same image with a different entry point, supplying the owner token and a
routable address for the probe's UDP media sockets:

```sh
RTC_ACCEPTANCE_GATEWAY_URL=http://gateway-instance:3001 \
RTC_ACCEPTANCE_TOKEN_FILE=/run/owner-token/CONTROL_AUTH_TOKEN \
RTC_ACCEPTANCE_SIP_HOST=sip.example.test \
RTC_ACCEPTANCE_SIP_DOMAIN=sip.example.test \
RTC_ACCEPTANCE_ADVERTISE_IP=192.0.2.20 \
RTC_ACCEPTANCE_REPORT_FILE=/tmp/acceptance-report.json \
node scripts/staging-acceptance.mjs
```

Use a specific gateway instance that has this controller's route, preserving HTTP
command affinity. SIP uses verified TLS on port 5061 by default. A private server
CA can be supplied with `RTC_ACCEPTANCE_SIP_CA_FILE`; the domain is the verified
server name and SIP Request-URI host. `RTC_ACCEPTANCE_SIP_PORT` selects another port.
`RTC_ACCEPTANCE_SIP_PLAINTEXT=true` is only for isolated local fixtures.

The probe checks reject/answer/ACK, bidirectional decoded PCMU RTP, remote
re-INVITE, a source-specific decoded recording, BYE and cleanup. It uses the
shared SIP peer and media validators also used by Compose. No backend control
credential is needed. Exit status and the JSON report must both indicate success.

The expanded Compose suite explicitly gives its memory core a 2 GiB accounting
budget to cover all retained groups before replay cutoffs expire. This is a test
fixture budget; it changes neither the service's default nor deployment sizing.

WebRTC/TURN connectivity, SRTP, outbound authentication/cancellation, discovery
expiry, authority changes, wrong identities, owner loss and the configured long
drain window still need separate evidence on the actual deployment network.
Local unit/Compose results do not qualify that network or production.
