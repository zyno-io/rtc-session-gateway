# Local E2E

Run:

```sh
export SIPBRIDGE_IMAGE=$(node -p 'require("./dependencies/sipbridge-runtime.json").image')
yarn e2e:compose
```

The runner:

- Builds the gateway image.
- Starts pinned sipbridge with memory state and fresh synthetic mTLS identities.
- Starts two rtpbridge backends with verified TLS and HMAC authentication, plus cohosted coturn servers.
- Registers a WebSocket route.
- Drives SIP over TCP through sipbridge.
- Exercises media commands through HTTP and WebSocket command paths.
- Validates sustained audio in both directions over RTP and SDES-SRTP, rejects plaintext on SRTP endpoints, checks inactive/resumed media and silence after unbridge, and exercises WebRTC playback, ICE restart, and relay-only TURN connectivity.
- Bridges a real SIP call to WebRTC with two-way Opus/PCMU transcoding, including decoded tone checks on the SIP side. FFmpeg generates the Opus fixture inside the E2E image; no host installation is needed.
- Decodes PCMU recordings to check tone frequency, amplitude, duration, stream descriptors, and exact PCAP merge output.
- Exercises SIP cancellation and re-INVITE, control-owner disconnect, concurrent teardown, and backend death and recovery with pending media actions.
- Drains a gateway on repeated SIGTERM while live SIP/RTP continues, finishes an admitted INVITE, rejects new work, and verifies successful process exit. Also checks deadline-driven SIP/media cleanup and a fresh gateway restart.
- Tears the compose project down after success or failure.

Native SIP uses the canonical private image pinned in
`dependencies/sipbridge-runtime.json`. Docker must be authenticated to
`gcr.s24.dev` with a project-scoped `read_registry` deploy token. `yarn test:native`
extracts the binary from that exact image and verifies its canonical schema
receipt before driving real SIP peers. Do not copy private Go source into CI.
Native control remains verified mTLS in both media modes.

## rtpbridge Image Selection

Default:

```sh
RTPBRIDGE_IMAGE=ghcr.io/zyno-io/rtpbridge:main
```

Use a local checkout:

```sh
RTPBRIDGE_LOCAL_CHECKOUT=/path/to/rtpbridge yarn e2e:compose
```

Use a specific image:

```sh
RTPBRIDGE_IMAGE=ghcr.io/zyno-io/rtpbridge:branch-test yarn e2e:compose
```

An explicit `RTPBRIDGE_IMAGE` takes precedence. Otherwise, `RTPBRIDGE_LOCAL_CHECKOUT` always builds the requested checkout, even when a cached `:main` image exists. An invalid checkout path fails immediately. With neither override, the runner pulls the current `:main` image.

## Backend Configuration

The runner creates a temporary fixture directory in the repository, using `scripts/rtpbridge.e2e.toml` as its base configuration. By default it removes the development exceptions, adds TLS using the test certificate and key, and generates a fresh HMAC secret. It checks that unsigned HTTP and WebSocket requests and incorrect signatures fail against the real backends. The test certificate is trusted explicitly; certificate verification stays enabled. These credentials are test fixtures; see [Configuration](../guide/configuration.md) for deployment settings.

Run the same suite with plaintext, unauthenticated development backends:

```sh
E2E_SECURE=false yarn e2e:compose
```

The configuration allows HTTP playback from `http://gateway:18080` at `10.89.42.20`. The audio fixtures use that fixed port to match rtpbridge's exact-origin download policy. Each backend shares its network namespace with a coturn server. The TURN scenario uses the gateway's generated credentials, requires relay candidates, and verifies that the selected ICE pair uses the relay while receiving sustained playback. A separate direct-peer scenario checks rotated credentials and resumed media after ICE restart.

## Continuous Integration

The `CI` workflow runs offline unit/build/docs checks on all pull requests. Native integration and both E2E transport modes run on same-repository pull requests and trusted pushes/workflow calls. Fork pull requests have no registry credentials and must receive a trusted native run before acceptance. Each E2E job checks out and builds the latest `zyno-io/rtpbridge` `main`, printing the backend commit for reproducibility. Native tests and both modes must pass before publishing the gateway's `main` image. The release workflow calls the same checks before publishing tagged images.

E2E jobs have a 30-minute timeout, retain runner and Compose logs, a JSON result, and the validated merged recording, and remove the Compose stack on failure as well as success. To retain those artifacts locally:

```sh
E2E_ARTIFACTS_DIR=e2e-artifacts yarn e2e:compose
```

## Debugging

If the run fails, the script prints Compose logs before cleanup. The gateway HTTP API is exposed on `localhost:3001`, SIP on `localhost:5060`, native admin health on `localhost:18800`, and rtpbridge HTTPS on `localhost:9100` and `localhost:9101` while the stack is running. Set `KEEP_E2E_STACK=1` to preserve the stack and its generated fixture directory for debugging. The suite uses a fixed Docker subnet and SIP/backend ports, so run the two transport modes sequentially on a local machine.

If port `3001` is already occupied, select another host port for both the compose mapping and the runner:

```sh
E2E_GATEWAY_PORT=13001 yarn e2e:compose
```

The stack uses an authoritative file catalog with two backend IDs on distinct
control ports. Both CI transport modes validate atomic admission removal,
strict call affinity and recording access while a backend is non-admitting. Secure
mode uses endpoint TLS names even when the global default differs. Docker Desktop
file propagation is synchronized through the observed catalog revision.

CI uses GitHub secrets `SIPBRIDGE_REGISTRY_USERNAME` and
`SIPBRIDGE_REGISTRY_TOKEN`, from a sipbridge project deploy token with only
`read_registry`. The current token expires 2027-11-08; rotate it in GitLab and
replace both GitHub secrets before expiry. These credentials only pull images;
publication remains owned by sipbridge's GitLab pipeline. Fork code must never
run with these secrets through `pull_request_target`.
