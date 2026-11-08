# Cross-cluster integration plan

The former SRF tunnel proposal is retired. The implemented transport is direct
native sipbridge WSS/mTLS and direct rtpbridge WSS/HTTPS. Platform-specific
registry authentication stays in a discovery sidecar, which publishes public
catalog v2 metadata without proxying signaling or media.

The detailed implementation sequence, lifecycle invariants and validation plan
are in [native sipbridge plan](./native-sipbridge-plan.md). The owning
`ARCHITECTURE.md`, [native discovery contract](./native-discovery-contract.md)
and [deployment guide](../guide/cross-cluster.md) describe current behavior.

Activation still requires immutable RTC/discovery images, real owner routes,
verified delivered identities, staging native SIP/media/recording acceptance and
actual platform drain evidence. Local fixtures establish application behavior,
not production network qualification. Production activation requires its own rollout.
