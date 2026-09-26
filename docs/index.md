# rtc-session-gateway

`rtc-session-gateway` is a standalone service for backend-controlled real-time communication. It accepts SIP through Drachtio, exposes a generic WebSocket and HTTP control surface, and uses rtpbridge for WebRTC, RTP, media actions, and raw PCAP recordings.

## What It Does

- Routes inbound SIP `INVITE`s by destination URI.
- Lets the owning backend answer or reject before media resources are allocated.
- Creates outbound SIP calls.
- Creates SIP-less WebRTC and RTP media sessions.
- Bridges and unbridges endpoints.
- Plays media, gathers digits, injects DTMF, and runs leave-message flows.
- Starts, stops, lists, downloads, deletes, and merges PCAP recordings.

## Start Here

- [Getting Started](./guide/getting-started.md)
- [Control WebSocket](./guide/control-websocket.md)
- [HTTP API](./guide/http-api.md)
- [Media Sessions](./guide/media-sessions.md)
- [Recordings](./guide/recordings.md)

## Integration Shape

Most production applications should keep a long-lived control WebSocket open. The gateway sends inbound SIP work to that connection, and the application responds with SIP decisions and media commands on the same channel.

HTTP remains available for static webhooks, management, recording access, and simple integrations that do not need a persistent control plane.
