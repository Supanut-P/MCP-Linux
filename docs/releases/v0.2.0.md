# Baitonghub-Linux-mcp v0.2.0

This release adds Linux-only, headless observability tools while preserving the
registered-root and confirmation boundaries from v0.1.0.

## Included

- `system_info`: summary, CPU, memory, disk, process, and listener inspection.
- `journal`: bounded systemd journal reads with unit validation and secret
  redaction.
- `network`: interfaces, routes, DNS, listeners, and connectivity checks.
- Fixed executable/argv-only command execution with `shell:false`, bounded
  output, and cancellation support.
- CLI doctor checks for `journalctl`, `ip`, `ss`, `df`, and `/proc` readiness.

## Safety

All v0.2 observability operations are read-only. Missing Linux dependencies
return structured `CAPABILITY_UNAVAILABLE` results. Provider stderr and
credential-shaped values are never returned through MCP.

Supported release target: Ubuntu 24.04 x86_64 headless runtime.
