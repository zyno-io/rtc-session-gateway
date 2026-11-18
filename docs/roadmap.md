# Roadmap

## Contract Hardening

- Publish JSON Schema for control commands and events.
- Publish OpenAPI for HTTP routes.
- Add explicit protocol version negotiation.
- Add typed client packages when the command surface stabilizes.

## Media

- Qualify the implemented [external SIP handoff and referral return](./development/sip-handoff-plan.md)
  against production carriers and call centers, including direct-media reachability,
  late offers, codec compatibility, and media security.
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

- Qualify the [SIP firewall](./guide/sip-firewall.md) against deployment carrier
  allowlists and traffic in shadow mode before enabling enforcement.
- Add Kubernetes manifests or Helm examples.
- Add metrics and dashboards.
- Document recommended sipbridge and rtpbridge sizing.
