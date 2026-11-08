# Native SIP dependency receipts

`sipbridge-contract.json` records the canonical schema owner/revision and hashes
of the copied schema, generated JSON TypeScript types/validation metadata and
canonical positive/negative wire fixtures. `yarn check:sipbridge-contract` fails
on drift. Update the schema in its owner first, regenerate there, then import a
matching receipt and generated files here. Do not hand-edit or format generated
files; `.oxfmtrc.json` excludes them and the canonical JSON test vectors.

`sipbridge-runtime.json` selects the immutable canonical GitLab image for required
native integration and Compose tests. The preparation script verifies the image
revision label and schema/generated-contract receipt before executing its binary.
No private source checkout, embedded Go snapshot or image mirror is needed.
The pinned runtime includes the memory outbound completion-capacity fix from
sipbridge MR16. Publication stays owned by the canonical GitLab pipeline.

CI pull credential scope, rotation and fork restrictions are documented in
`docs/development/local-e2e.md`. Receipts and catalogs contain no credentials.
