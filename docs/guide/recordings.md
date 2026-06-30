# Recordings

Recordings are created by rtpbridge and exposed through the gateway so clients do not need direct access to every rtpbridge backend.

## Start And Stop

Start:

```json
{
  "type": "request",
  "id": "rec-1",
  "method": "recording.start",
  "params": {
    "sessionId": "media-session-1",
    "endpointId": "webrtc-1",
    "filePath": "call_42__seg_0001.pcap"
  }
}
```

Stop:

```json
{
  "type": "request",
  "id": "rec-2",
  "method": "recording.stop",
  "params": { "recordingId": "recording-1" }
}
```

Use `endpointId` when recording should follow one side of a call, such as an agent-only segment.

## Listing And Download

```http
GET /recordings?startsWith=call_42
GET /recordings/rtpbridge-0/call_42__seg_0001.pcap
```

Recording paths are constrained to `RECORDINGS_PATH` and validated before proxying to rtpbridge.

## Ordered PCAP Merge

```http
POST /recordings/merge
Content-Type: application/json

{
  "targets": [
    { "backendId": "rtpbridge-0", "path": "call_42__seg_0001.pcap" },
    { "backendId": "rtpbridge-1", "path": "call_42__seg_0002.pcap" }
  ]
}
```

The gateway streams one merged PCAP:

- It writes the first global PCAP header once.
- It verifies every source segment has the same global header.
- It appends packet records in target order.

This is designed for continuity when an application intentionally records ordered raw PCAP segments. It does not currently sort packets by timestamp across targets.

## Delete

```http
DELETE /recordings/rtpbridge-0/call_42__seg_0001.pcap
```

Delete source segments only after the merged artifact is durably stored.
