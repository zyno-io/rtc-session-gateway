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
| `NOT_FOUND` | Call, session, endpoint, route, or recording was not found. |
| `CONFLICT` | The requested state transition is invalid. |
| `SERVICE_UNAVAILABLE` | Required backend such as rtpbridge is not configured or unavailable. |
| `INTERNAL_ERROR` | Unexpected server error. |

HTTP routes return JSON error bodies for command failures:

```json
{ "error": "sessionId is required" }
```

Streaming recording routes may return backend status codes when proxied rtpbridge requests fail.
