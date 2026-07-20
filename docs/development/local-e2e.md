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

Drachtio runs in outbound-routing mode. Its HTTP lookup calls the gateway's `/drachtio/route` endpoint, and the gateway advertises the `rtc-session-gateway` application tag. This mirrors a shared Drachtio deployment where dynamic gateway routes are selected before the SIP request is delivered to the application connection.

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

## Debugging

If the run fails, the script prints compose logs before cleanup. The gateway HTTP API is exposed on `localhost:3001`, SIP on `localhost:5060`, Drachtio control on `localhost:9022`, and rtpbridge HTTP on `localhost:9100` and `localhost:9101` while the stack is running.

If port `3001` is already occupied, select another host port for both the compose mapping and the runner:

```sh
E2E_GATEWAY_PORT=13001 yarn e2e:compose
```
