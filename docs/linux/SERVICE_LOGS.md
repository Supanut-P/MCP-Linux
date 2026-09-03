# `service_logs` (Linux headless)

`service_logs` provides a bounded, read-only view of one systemd `.service`
unit. It is intended for ChatGPT/MCP clients that need to diagnose a service
without composing a shell command.

## Request

```json
{
  "operation": "read",
  "unit": "baitonghub-linux-mcp.service",
  "lines": 100,
  "maxBytes": 262144
}
```

Use `operation: "tail"` with the returned `nextCursor` to request records
newer than the previous response:

```json
{
  "operation": "tail",
  "unit": "baitonghub-linux-mcp.service",
  "cursor": "<opaque cursor from the same unit>",
  "lines": 100
}
```

The unit must match `[A-Za-z0-9_.@:-]{1,256}.service`. Lines are capped at 500
and serialized output is capped at 256 KiB. A cursor is opaque, contains no
credential, and is rejected when used with another unit or when malformed.

## Response and failure behavior

The response contains `unit`, `provider: "journalctl"`, sanitized `entries`,
optional `nextCursor`, and `truncated`. Journal fields whose names or values
look like credentials are redacted, and provider stderr is never returned.

- `CAPABILITY_UNAVAILABLE`: `journalctl` is missing or the provider failed.
- `PROCESS_TIMEOUT`: the request was cancelled before the provider completed.
- `INVALID_INPUT`: unit, cursor, or bounds are invalid.

The implementation always uses a resolved `journalctl` executable with
`shell:false`; it does not accept arbitrary journal predicates, shell text,
boot IDs, or paths.
