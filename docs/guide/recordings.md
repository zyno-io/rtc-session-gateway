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

`GET /recordings` queries rtpbridge recording indexes. When the gateway has multiple rtpbridge backends, an all-backend list request fans out across each configured backend and combines the results. Use it for diagnostics, operator browsing, and recovery/backfill workflows.

Production call-finalization flows should avoid prefix scans. Generate deterministic segment filenames in the application. If the application chooses the `filePath`, it already knows the `recordingPath`; in multi-backend deployments it should also persist the returned `backendId`. Use those known `{ backendId, path }` targets directly for download, merge, and delete operations.

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

## Decoding PCAP

The gateway stores and merges raw rtpbridge PCAP recordings. Decode merged or downloaded files with rtpbridge `pcap2audio`.

See [rtpbridge Recording: Decoding (pcap2audio)](https://zyno-io.github.io/rtpbridge/protocol/recording.html#decoding-pcap2audio).

## Delete

```http
DELETE /recordings/rtpbridge-0/call_42__seg_0001.pcap
```

Delete source segments only after the merged artifact is durably stored.
