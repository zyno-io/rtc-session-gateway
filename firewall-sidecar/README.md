# SIP firewall sidecar

Separate image/package that applies firewall snapshots from the gateway to nftables.

License: `nftables-napi` is AGPL-3.0-only. It is deliberately isolated here and must not be
added to the root `package.json`, root `yarn.lock`, or the gateway production image.

Layout: `src/main.ts` (entry), `src/nftables-backend.ts` (only file importing `nftables-napi`).
`tsconfig.json` has `rootDir: ".."` and compiles the shared gateway modules it imports from `../src`
(`firewall-receiver`, `firewall-reconciler`, `firewall-contract`, `firewall-address`, `firewall-auth`,
`logger`). Output: `dist/firewall-sidecar/src/main.js`.

Build (repo root as context): `yarn build:firewall-sidecar-image`. Needs `CAP_NET_ADMIN` and the
host network namespace being protected.
