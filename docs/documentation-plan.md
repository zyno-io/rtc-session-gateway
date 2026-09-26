# Documentation Plan

This page tracks the VitePress documentation expansion. The goal is a public-quality documentation set for application developers, telephony engineers, and operators.

## Audiences

- Application integrators need command examples, lifecycle diagrams, and error semantics.
- Telephony engineers need SIP routing, Drachtio behavior, SDP ownership, re-INVITE behavior, and recording details.
- Frontend/WebRTC engineers need browser signaling, ICE restart, endpoint lifecycle, and failure notification docs.
- Operators need deployment, health, logging, security, rollback, and troubleshooting docs.
- Maintainers need test strategy, local E2E, release, and compatibility docs.

## Information Architecture

- Guide: concept-first pages that explain how to use the gateway.
- Reference: exact protocol, route, event, error, and payload contracts.
- Development: local setup, tests, E2E simulation, contribution rules, and release mechanics.
- Roadmap: explicit deferred work and compatibility commitments.

## Required Pages

Initial scaffold:

- Getting Started
- Configuration
- Control WebSocket
- HTTP API
- SIP Routing
- Media Sessions
- Recordings
- Operations
- Control Protocol Reference
- HTTP API Reference
- Events Reference
- Errors Reference
- Testing
- Local E2E
- Roadmap

Next expansion:

- Inbound SIP sequence: INVITE, control request, reject, answer, ACK, BYE.
- Outbound SIP sequence: command, UAC dialog, answer SDP, termination.
- SIP-less WebRTC sequence: session create, offer/answer, ICE restart, delete.
- Bridge sequence: agent session, remote SIP or RTP session, bridge/unbridge, cleanup.
- Recording sequence: start segment, stop segment, download, ordered merge, delete.
- Leave-message sequence: update media direction, VAD silence wait, playback, terminate.

## Reference Quality Bar

Every command and route should document:

- Purpose.
- Authentication requirements.
- Request body.
- Successful response.
- Error responses.
- Idempotency expectations.
- Ownership and cleanup rules.
- Example WebSocket request.
- Equivalent HTTP route when one exists.
- Related events.

Every event should document:

- Producer.
- Delivery channel.
- Ordering and `sequence` behavior.
- Required acknowledgements, if any.
- Retry or drop behavior.
- Example payload.

## Examples

Maintain examples for:

- Minimal inbound route backend.
- Outbound SIP caller.
- Browser WebRTC signaling.
- RTP endpoint bridge.
- Gather digits IVR step.
- Leave-message action.
- Recording merge client.
- Health-checking and graceful shutdown.

Examples should be generic and avoid application-specific names, tenant identifiers, phone numbers, or file naming conventions.

## Generated Artifacts

Planned generated docs:

- JSON Schema for control commands and events.
- OpenAPI spec for HTTP routes.
- TypeScript declaration excerpts for published payload types.
- Mermaid sequence diagrams checked into docs.

## Acceptance Criteria

The docs are ready for first public use when:

- A new integrator can run the service locally from the docs alone.
- A backend engineer can implement inbound SIP answer/reject without reading source.
- A browser engineer can implement SIP-less WebRTC signaling without reading source.
- An operator can deploy with Drachtio and rtpbridge and understand required network paths.
- Recording access and merge behavior are precise enough to build archival storage safely.
- All examples pass a docs smoke test or are covered by tests in `test/` or `scripts/`.
