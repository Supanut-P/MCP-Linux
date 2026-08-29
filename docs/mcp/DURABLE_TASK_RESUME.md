# Durable shell task resume (v1.1)

`shell` background tasks are restart-safe. A successful durable `shell` run
returns a one-time `resume_token` alongside `task_id`. The token is an opaque
32-byte base64url capability; only its SHA-256 digest is stored in the task
metadata. It is never included in status, logs, result, list, audit, or error
output.

After an MCP transport reconnect, call:

```json
{
  "operation": "resume",
  "workspaceId": "<same workspace>",
  "task_id": "<task id>",
  "resume_token": "<token returned by run>"
}
```

Resume requires the same authenticated client and exact workspace that created
the task. Only the transport session identifier is rebound. A successful resume
rotates the token, so the previous token cannot be reused. Incorrect, reused,
cross-client, or cross-workspace tokens return `PERMISSION_DENIED` without
signaling or changing the task process.

The normal `status`, `logs`, `result`, `wait`, and `cancel` operations continue
to require the current owner session. Resume does not grant filesystem or
process authority outside the task's original registered workspace.
