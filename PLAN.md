# rtc-session-gateway Project Plan

This plan tracks the reusable gateway as a standalone Zyno Consulting project. It intentionally excludes application-specific migration details. Application integrations should live in the consuming application's repository or in separate integration guides.

## Product Boundary

`rtc-session-gateway` is responsible for:

- SIP ingress and egress through Drachtio.
- Destination-URI route ownership through WebSocket registrations or static HTTP route tables.
- Pre-media inbound call decisioning before rtpbridge allocation.
- SIP-less WebRTC session creation, teardown, ICE restart, and failure notification.
- RTP media sessions, bridge/unbridge operations, playback, DTMF, gather, and leave-message workflows.
- rtpbridge backend selection and per-call backend pinning.
- Recording proxy routes and ordered raw PCAP segment merging.
- Deterministic recording retrieval using explicit `{backendId, path}` targets returned by recording commands.
- A generic public control protocol usable by multiple applications.

It is not responsible for:

- Application queueing, agent presence, CRM workflows, billing, or user identity.
- Application-specific client protocols.
- Hosted media storage beyond proxying and merging rtpbridge recording segments.
- Answering machine detection. AMD remains deferred until there is a chosen efficient open-source implementation or rtpbridge-native primitive.

## Organization

Current source layout is intentionally compact:

- `src/config.ts`: environment parsing and defaults.
- `src/drachtio-gateway.ts`: SIP ingress, outbound origination, re-INVITE, BYE, and follow-up events.
- `src/control-*`: WebSocket protocol, connection ownership, route registration, and gateway-initiated requests.
- `src/http-*`: HTTP webhook contract, HTTP client, and management API.
- `src/media-*` and `src/rtpbridge-client.ts`: rtpbridge backend selection, sessions, endpoints, playback, gather, leave-message, recording, and merge behavior.
- `src/session-commands.ts`: shared command dispatcher used by WebSocket and HTTP surfaces.
- `test/`: focused unit/integration tests for SIP, routing, control, HTTP, media, recording, and commands.
- `scripts/`: local automated E2E probes and compose orchestration.
- `docs/`: VitePress documentation.
- `.github/workflows/`: CI, release image publishing, and docs publishing.

Refactor trigger: split `src/` into `sip/`, `control/`, `http/`, `media/`, and `shared/` directories once any one concern grows beyond two or three cohesive modules. Do not split only for aesthetics while the service remains easy to navigate.

## Documentation Plan

The VitePress documentation should become the authoritative public contract for integrators and operators. Initial scaffold:

- Overview and quick start.
- Configuration reference.
- Control WebSocket guide.
- HTTP API guide.
- SIP routing guide.
- Media sessions guide.
- Recording proxy and PCAP merge guide.
- PCAP decoding guide that links to rtpbridge `pcap2audio`.
- Operations guide.
- Control protocol reference.
- HTTP endpoint reference.
- Event reference.
- Error reference.
- Development testing and local E2E guide.
- Roadmap.

Planned additions:

- Sequence diagrams for inbound SIP answer/reject, outbound SIP origination, SIP-less WebRTC, bridge/unbridge, recording segment rollover, and leave-message.
- Full JSON schema examples for every command, event, and HTTP body.
- Compatibility matrix for Drachtio, Node, Yarn, Docker, and rtpbridge versions.
- Security hardening guide for bearer auth, trusted networks, reverse proxies, and recording access.
- Production deployment guide with Kubernetes examples.
- Troubleshooting guide for SIP final responses, ICE failures, rtpbridge backend health, and recording merge failures.
- Versioning policy for the control protocol and HTTP routes.

See `docs/documentation-plan.md` for the detailed documentation backlog and acceptance criteria.

## CI/CD Plan

GitHub Actions workflows:

- `ci.yml`: on `main` push and pull request, enable Corepack, install with Yarn Berry, run tests, build TypeScript, build docs, and build the Docker image without pushing.
- `release-image.yml`: on tag push, build and publish the Docker image to GHCR.
- `docs.yml`: on `main` push, build VitePress and publish to GitHub Pages.

The workflows use `yarn install --immutable` and the package-pinned Yarn Berry version from `packageManager`.

## Testing Plan

Keep tests close to behavior:

- Route parsing and matching tests for exact and prefix routing.
- Control WebSocket tests for auth, registration, request ownership, timeout, and disconnect cleanup.
- SIP gateway tests for unmatched INVITE, control-routed answer/reject, HTTP webhook fallback, outbound SIP, re-INVITE, and BYE.
- HTTP API tests for command validation, auth, media endpoints, recording proxy, and recording merge.
- Media service tests for rtpbridge backend pinning, endpoint lifecycle, bridge constraints, VAD-backed leave-message behavior, PCAP path safety, and merge validation.
- Compose E2E tests for Drachtio, rtpbridge, SIP probes, RTP packet flow, WebRTC setup, recordings, merge, and media actions.

Before release:

- `yarn test`
- `yarn build`
- `yarn docs:build`
- `yarn e2e:compose` when Docker and the rtpbridge image are available.

## Near-Term Work

- Finish expanding docs from scaffold to exhaustive reference.
- Add generated JSON schema or TypeScript declaration output for command/event payloads.
- Add OpenAPI documentation for HTTP routes.
- Add protocol conformance tests that run the same scenarios over WebSocket and HTTP.
- Add CI path for optional compose E2E when Docker services are available in the runner.
- Decide whether recording merge should support time-sorted packet merge in addition to ordered concatenation.
