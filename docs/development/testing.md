# Testing

## Unit And Integration Tests

```sh
corepack enable
yarn install --immutable
yarn test
```

`yarn test` first runs `yarn check:sipbridge-contract`, then the offline suites.

Coverage areas:

- SIP call ID normalization.
- Routing parse and match behavior.
- Control WebSocket auth, route registration, request ownership, and timeouts.
- SIP gateway inbound and outbound behavior against a stubbed native signaling layer.
- Native JSON codec, uncertainty fencing and reconnect inspection.
- Endpoint catalog v2 parsing, expiry and media affinity.
- HTTP command routes.
- rtpbridge backend selection and media session operations.
- Recording proxy, recording path validation, and PCAP merge.
- Shared command dispatcher validation.

## Native Integration Tests

```sh
yarn test:native
```

This pulls the sipbridge image pinned in `dependencies/sipbridge-runtime.json`,
verifies its revision label and schema receipt, and runs
`test/sipbridge-native.test.ts` against the extracted binary with memory state and
synthetic certificates. It covers inbound and outbound calls, CANCEL, re-INVITE,
BYE, non-admitting bootstrap, stale signaling, TLS name and client URI
rejection, reconnect without replay, state-authority change and digest
authentication. `yarn test` skips this file. Registry access is described in
[local E2E](./local-e2e.md).

These suites and the [Compose E2E](./local-e2e.md) run real sipbridge and
rtpbridge processes on one host. They do not qualify a deployment network,
delivered identities or a production rollout.

## Build Checks

```sh
yarn build
yarn docs:build
```

## Test Data Rules

Tests should use generic route users, caller names, phone numbers, and recording prefixes. Do not encode customer-specific names, tenant identifiers, or local absolute paths.
