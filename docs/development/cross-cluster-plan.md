# Cross-cluster integration plan

The former SRF tunnel proposal is retired. The implemented transport is direct
native sipbridge WSS/mTLS and direct rtpbridge WSS/HTTPS. A deployment supplies public catalog v2 metadata. Its optional discovery publisher
may authenticate to private registries without involving RTC or proxying control/media.

The detailed implementation sequence, lifecycle invariants and validation plan
are in [native sipbridge plan](./native-sipbridge-plan.md). The owning
`ARCHITECTURE.md`, [native discovery contract](./native-discovery-contract.md)
and [deployment guide](../guide/cross-cluster.md) describe current behavior.

Activation still requires tested RTC/sipbridge/rtpbridge images, real owner routes,
verified delivered identities, staging native SIP/media/recording acceptance and
actual platform drain evidence. Local fixtures establish application behavior,
not production network qualification. Production activation requires its own rollout.
