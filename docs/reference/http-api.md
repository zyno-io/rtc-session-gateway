# HTTP API Reference

## Public Health

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | Drachtio connection health and active SIP call count. |
| `GET` | `/readyz` | Readiness for new work; 503 during drain or Drachtio disconnection. |

## Adapter Routing

These routes use the configured HTTP bearer authentication. Configure bearer mode
when exposing them to a transport adapter. They never call an application webhook
or fallback router.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/routing/status` | Admission/drain state, process tag, route count and media catalog revision/expiry/eligible count/reload error. |
| `POST` | `/routing/lookup` | Side-effect-free route match; body `{destinationUri, destinationUser?}`, response `{matched, acceptNew, tag?}`. |

Lookup bodies are limited to 16 KiB. URI/user lengths are bounded to 2048/256
characters. A match retains `matched=true` during drain or dependency loss but
returns `acceptNew=false` without a tag. See [cross-cluster deployment](../guide/cross-cluster.md).

## Calls

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/calls` | List active SIP calls. |
| `GET` | `/calls/:callId` | Get one SIP call. |
| `POST` | `/calls` | Create outbound SIP call. |
| `POST` | `/calls/:callId/reinvite` | Send SIP re-INVITE. |
| `POST` | `/calls/:callId/bye` | Send SIP BYE. |

## Sessions

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/sessions` | List media sessions. |
| `GET` | `/sessions/:sessionId` | Get one media or SIP session. |
| `POST` | `/sessions` | Create media session. |
| `DELETE` | `/sessions/:sessionId` | Delete media session or hang up SIP session. |

## WebRTC And RTP

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/sessions/:sessionId/webrtc/offers` | Create WebRTC offer. |
| `POST` | `/sessions/:sessionId/webrtc/from-offer` | Create WebRTC answer from offer. |
| `POST` | `/endpoints/:endpointId/webrtc/answer` | Accept WebRTC answer. |
| `POST` | `/endpoints/:endpointId/webrtc/offer-answer` | Accept WebRTC offer and return answer. |
| `POST` | `/endpoints/:endpointId/webrtc/ice-restart` | Create ICE restart offer. |
| `POST` | `/sessions/:sessionId/rtp/offers` | Create RTP offer. |
| `POST` | `/sessions/:sessionId/rtp/from-offer` | Create RTP answer from offer. |
| `POST` | `/endpoints/:endpointId/rtp/answer` | Accept RTP answer. |
| `POST` | `/endpoints/:endpointId/rtp/reinvite` | Renegotiate RTP endpoint. |

## Media

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/sessions/:sessionId/media/play` | Play media source. |
| `POST` | `/sessions/:sessionId/media/bridge` | Bridge two sessions. |
| `POST` | `/media/bridges/:endpointId/unbridge` | Remove bridge endpoint. |
| `DELETE` | `/media/bridges/:endpointId` | Remove bridge endpoint. |
| `POST` | `/sessions/:sessionId/media/gather` | Gather DTMF digits. |
| `POST` | `/sessions/:sessionId/media/play-and-gather` | Play prompt and gather digits. |
| `POST` | `/sessions/:sessionId/media/leave-message` | Wait for silence and play message. |
| `POST` | `/media/endpoints/:endpointId/dtmf` | Inject DTMF. |
| `POST` | `/media/endpoints/:endpointId/direction` | Update endpoint direction. |
| `DELETE` | `/media/endpoints/:endpointId` | Stop and delete endpoint. |

## Recordings

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/sessions/:sessionId/recordings` | Start recording. |
| `POST` | `/recordings/:recordingId/stop` | Stop recording. |
| `GET` | `/recordings` | List recordings across backends. Best for diagnostics and recovery; production archival should use deterministic filenames plus the `backendId` returned by recording commands. |
| `GET` | `/recordings/:backendId` | List recordings for one backend. |
| `GET` | `/recordings/:backendId/*` | Stream one recording. |
| `POST` | `/recordings/merge` | Stream ordered merged PCAP. |
| `DELETE` | `/recordings/:backendId/*` | Delete one recording. |

Decoded audio is not served by this API. Use rtpbridge `pcap2audio` for PCAP-to-WAV conversion: <https://zyno-io.github.io/rtpbridge/protocol/recording.html#decoding-pcap2audio>.

## Process

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/drain` | Begin bounded graceful shutdown; returns 202 and uses normal command-route authentication. |
| `POST` | `/terminate` | Alias for `/drain`. |
