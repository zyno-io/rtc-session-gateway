# Local E2E

Run:

```sh
yarn e2e:compose
```

The runner:

- Builds the gateway image.
- Starts Drachtio.
- Starts two rtpbridge backends.
- Registers a WebSocket route.
- Drives SIP over TCP through Drachtio.
- Exercises media commands through HTTP and WebSocket command paths.
- Validates RTP packet flow, WebRTC media receipt, recordings, and PCAP merge.
- Tears the compose project down after success or failure.

## rtpbridge Image Selection

Default:

```sh
RTPBRIDGE_IMAGE=ghcr.io/zyno-io/rtpbridge:latest
```

Use a local checkout:

```sh
RTPBRIDGE_LOCAL_CHECKOUT=/path/to/rtpbridge yarn e2e:compose
```

Use a specific image:

```sh
RTPBRIDGE_IMAGE=ghcr.io/zyno-io/rtpbridge:branch-test yarn e2e:compose
```

## Debugging

If the run fails, the script prints compose logs before cleanup. The gateway HTTP API is exposed on `localhost:3001`, SIP on `localhost:5060`, Drachtio control on `localhost:9022`, and rtpbridge HTTP on `localhost:9100` and `localhost:9101` while the stack is running.
