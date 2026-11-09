# Errors Reference

Control errors use this shape:

```json
{
  "type": "response",
  "id": "request-id",
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "sessionId is required"
  }
}
```

## Common Codes

| Code | Meaning |
| --- | --- |
| `BAD_MESSAGE` | WebSocket message envelope was invalid. |
| `BAD_REQUEST` | Command or HTTP body failed validation. |
| `NOT_FOUND` | Call, session, endpoint, backend, or recording was not found. |
| `CONFLICT` | The requested state transition is invalid. |
| `ROUTE_CONFLICT` | A `route.register` route duplicates one already registered. |
| `NOT_IMPLEMENTED` | The command is recognized but not implemented. HTTP uses 501. |
| `MEDIA_UNAVAILABLE` | Media is not configured, the catalog is unavailable or expired, or no suitable rtpbridge backend admits the session. HTTP uses 503. |
| `RECORDING_PROXY_ERROR` | A proxied rtpbridge recording request failed. HTTP uses the mapped backend status. |
| `SIGNALING_UNKNOWN` | A native SIP command's outcome is unknown. Do not replay it; the affected call accepts no further native commands. HTTP uses 503. |
| `SIGNALING_UNAVAILABLE` | No usable native sipbridge session for the command or new call. HTTP uses 503. |
| `SHUTTING_DOWN` | Gateway is draining and cannot admit new work. HTTP command responses use 503 with `Retry-After: 1`. |
| `INTERNAL_ERROR` | Unexpected server error. |

HTTP routes return JSON error bodies for command failures:

```json
{ "error": "sessionId is required" }
```

Streaming recording routes may return backend status codes when proxied rtpbridge requests fail.
