# Roadmap

## Contract Hardening

- Publish JSON Schema for control commands and events.
- Publish OpenAPI for HTTP routes.
- Add explicit protocol version negotiation.
- Add typed client packages when the command surface stabilizes.

## Media

- Keep `media.leaveMessage` backed by existing rtpbridge VAD behavior.
- Defer standalone public VAD commands until the activation and notification contract is finalized.
- Defer AMD and beep detection until there is a selected efficient implementation or rtpbridge-native primitive.
- Add more codec and SRTP compatibility tests.

## Recordings

- Keep ordered PCAP segment concatenation for continuity.
- Consider optional timestamp-sorted merge for advanced archival workflows.
- Add retention and storage integration examples.
- Keep `GET /recordings` positioned as a diagnostic/recovery API rather than the preferred production archival path.

## Operations

- Add Kubernetes manifests or Helm examples.
- Add metrics and dashboards.
- Add optional compose E2E in CI.
- Document recommended Drachtio and rtpbridge sizing.
