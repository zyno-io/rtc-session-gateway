# Native SIP dependency receipts

`sipbridge-contract.json` records the sipbridge repository and revision, plus hashes
of the schema (`sipbridge-control.proto`), the generated TypeScript types and JSON
validation metadata under `src/sipbridge/generated/`, and the canonical
positive/negative wire fixtures (`sipbridge-json-cases.json`). `yarn
check:sipbridge-contract`, which also runs as part of `yarn test`, fails on drift.

Protocol changes start in sipbridge. To update, import the schema, generated files
and receipt hashes that sipbridge publishes for one revision. Do not hand-edit or
reformat generated files; `.oxfmtrc.json` excludes them and the JSON test vectors.

`sipbridge-runtime.json` pins the immutable sipbridge image, by revision tag and
digest, used by `yarn test:native` and the Compose E2E suite.
`scripts/prepare-sipbridge-runtime.mjs` pulls that image and checks its revision
label and embedded schema receipt against these files before the binary is used.
`yarn test:native` and CI run this check; `yarn e2e:compose` uses `SIPBRIDGE_IMAGE`
as given. No sipbridge source checkout is needed. sipbridge's own pipeline
publishes the image.

Registry pull credentials for CI are described in
[local E2E](../docs/development/local-e2e.md#continuous-integration). Receipts and
catalogs contain no credentials.
