# Operations

## Deployment Shape

A production deployment needs:

- `rtc-session-gateway` HTTP/control port.
- Drachtio server reachable from the gateway.
- SIP carriers or SBCs reachable from Drachtio.
- rtpbridge backends reachable from the gateway when media is enabled.
- UDP media paths between rtpbridge and remote RTP/WebRTC peers.

See [cross-cluster deployment](./cross-cluster.md) for separate application/edge networks, external adapter responsibilities, and current discovery limitations.

When Drachtio uses outbound request routing, configure `DRACHTIO_APP_TAG` and point Drachtio's `INVITE` request handler at `/drachtio/route`. The route endpoint selects the gateway tag only for a currently registered gateway route. If `DRACHTIO_ROUTE_FALLBACK_URL` is configured, all other requests are forwarded to that existing router.

## Health

`GET /healthz` returns Drachtio connection health and active SIP call count. It retains its existing behavior while draining.

`GET /readyz` returns 200 only while Drachtio is connected and the gateway accepts new work. It returns 503 immediately when draining begins. Use `/readyz` to remove a draining instance from new traffic; a dependency-based readiness check should not restart a process with active calls.

## Security

- Use bearer auth for the control WebSocket and protected HTTP routes.
- Put the service behind a trusted load balancer or private network.
- Avoid exposing rtpbridge directly to application clients.
- Treat recording paths as sensitive. Download, merge, and delete routes should only be available to trusted services.

## Logging

The service uses Pino. Log records include namespace fields for gateway, control, media, and rtpbridge components.

## Shutdown

SIGTERM, SIGINT, authenticated `POST /drain`, and authenticated `POST /terminate` begin the same irreversible drain. The HTTP routes return 202 with `{"ok":true,"draining":true}`. Repeated requests or signals keep the original deadline.

During drain:

- Readiness becomes unavailable; new control WebSocket upgrades, inbound/outbound SIP calls, standalone media sessions, and route registrations are rejected. HTTP returns 503 and control commands return `SHUTTING_DOWN`.
- Existing control WebSockets and Drachtio/rtpbridge connections remain open. Existing session commands, media, re-INVITEs, recording operations, and teardown continue working.
- An INVITE or outbound call admitted before drain can finish setup. A new media session carrying the `callId` of an existing or reserved SIP call remains allowed so that admitted setup can allocate media.
- Owners receive `gateway.draining` with `reason` and `maxWaitMs`. Keep the old control connection open until its calls finish; open a separate connection to a replacement instance for new work.
- The gateway waits for SIP calls, reserved incoming calls, media sessions, in-flight commands/setup, and outgoing follow-up callbacks. Idle control connections do not hold the process open.

The gateway exits with code 0 when work finishes. The default natural drain deadline is 30 minutes (`SHUTDOWN_MAX_WAIT_MS=1800000`). At the deadline, it attempts SIP BYE/CANCEL and explicit media-session destruction, then closes control owners. Final cleanup is bounded by `SHUTDOWN_CLEANUP_TIMEOUT_MS` (5 seconds by default); unreachable peers can prevent acknowledgement, and surviving rtpbridge sessions then rely on the backend's orphan timeout. This is planned shutdown support; it does not recover calls after a crash or transfer them to another gateway.

Applications must delete media sessions when calls finish, including sessions created through HTTP. Closing a control owner still tears down its resources immediately; drain does not change that ownership rule.

### Rolling Deployments

Start replacement capacity before draining an old gateway. Use a distinct `DRACHTIO_APP_TAG` for each concurrently running instance and direct new INVITE route lookups to ready replacements. Sharing one tag across old and new instances can deliver a fresh INVITE to a draining SRF connection, which will reject it with 503.

Existing HTTP-owned calls need a stable route to their owning instance for commands during drain; a shared Service that removes that instance on readiness failure is insufficient. Persistent control WebSockets already retain that connection affinity, provided the load balancer preserves established connections when readiness changes. Application route registrations are local to each gateway, so register them on replacements before sending new calls there.

Set the platform's termination grace period longer than the natural drain plus cleanup budget, including any pre-stop hook time. For example:

```yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    spec:
      terminationGracePeriodSeconds: 1830
      containers:
        - name: gateway
          env:
            - name: SHUTDOWN_MAX_WAIT_MS
              value: "1800000"
            - name: SHUTDOWN_CLEANUP_TIMEOUT_MS
              value: "5000"
          readinessProbe:
            httpGet:
              path: /readyz
              port: 3001
```

Choose a longer drain window for long calls. Keep media backends, SIP routing, and any transport proxies alive throughout the gateway drain. Validate a rollout with the actual load balancer and route owner; local drain tests do not establish those infrastructure guarantees.

## Local Compose

`yarn e2e:compose` starts the complete local simulation stack and tears it down after the run. Set `RTPBRIDGE_IMAGE` to test a specific rtpbridge image, or `RTPBRIDGE_LOCAL_CHECKOUT` to build one from a local checkout.
