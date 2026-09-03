# Baitonghub-Linux-mcp v1.16.0

v1.16.0 adds explicit server-surface profiles for Linux headless deployments.
The default remains `full` for v1 compatibility.

## Included

- `core` keeps workspace/file/search/Git, process/shell, health/observability,
  context, and read-only diagnostic tools.
- `operator` adds local service, package, schedule, backup, database, and
  support/evidence tools.
- `fleet` adds registered `remote_host`, `remote_fleet`, and rollout tools.
- `full` exposes the complete provider-filtered v1 surface.
- Use `--server-profile` or `BAITONGHUB_LINUX_MCP_PROFILE`; invalid values fail
  closed and hidden tools cannot be reached through `tool_batch`.
- The selected server profile is included in sanitized health metadata.

## Compatibility and safety

Server profiles only filter `tools/list` and dispatch. Permission profiles,
confirmation rules, registered workspace roots, remote-host registration,
Secret Service, process ownership, audit, redaction, and Linux-only provider
filtering remain independently enforced. The v1 tool schemas and frozen v1
fixture are unchanged.

The seven-day soak remains waived for this development checkpoint. Package and
external release mutation require the explicit release gate.
