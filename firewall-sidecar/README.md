# SIP firewall sidecar

Separate image/package that applies firewall snapshots from the gateway to nftables.

License: `nftables-napi` is AGPL-3.0-only. It is deliberately isolated here and must not be
added to the root `package.json`, root `yarn.lock`, or the gateway production image.

Layout: `src/main.ts` (entry), `src/nftables-backend.ts` (only file importing `nftables-napi`).
`tsconfig.json` has `rootDir: ".."` and compiles the shared gateway modules it imports from `../src`
(`firewall-receiver`, `firewall-reconciler`, `firewall-contract`, `firewall-address`, `firewall-auth`,
`logger`). Output: `dist/firewall-sidecar/src/main.js`.

## Deployment and self-lockout protection

Run the sidecar in a DEDICATED network namespace shared with sipbridge (Kubernetes pod, or Compose
`network_mode: service:sipbridge`). Host networking is unsupported: drops apply to all traffic from
a banned source at the input/forward hooks, so a ban would affect every service on the host.

`FIREWALL_PROTECTED_CIDRS` (comma-separated) is a sidecar-local allowlist that snapshots cannot
override. `127.0.0.0/8` and `::1/128` are always protected. It must also include the gateway's
address and any probe/kubelet/node ranges, or a ban could cut the gateway or health checks off.
Bans (and snapshots) broader than IPv4 /8 or IPv6 /16 are rejected.

Build (repo root as context): `yarn build:firewall-sidecar-image`. Needs `CAP_NET_ADMIN` in the
network namespace being protected (see above).
