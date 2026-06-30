# Testing

## Unit And Integration Tests

```sh
corepack enable
yarn install --immutable
yarn test
```

Coverage areas:

- SIP call ID normalization.
- Routing parse and match behavior.
- Control WebSocket auth, route registration, request ownership, and timeouts.
- Drachtio gateway inbound and outbound SIP behavior.
- HTTP command routes.
- rtpbridge backend selection and media session operations.
- Recording proxy, recording path validation, and PCAP merge.
- Shared command dispatcher validation.

## Build Checks

```sh
yarn build
yarn docs:build
```

## Test Data Rules

Tests should use generic route users, caller names, phone numbers, and recording prefixes. Do not encode customer-specific names, tenant identifiers, or local absolute paths.
