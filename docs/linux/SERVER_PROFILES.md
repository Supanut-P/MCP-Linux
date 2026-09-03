# Headless server profiles

Baitonghub-Linux-mcp supports an explicit server surface profile for clients
that prefer a smaller `tools/list` response. Set it with the CLI flag
`--server-profile` or `BAITONGHUB_LINUX_MCP_PROFILE`:

| Profile | Adds to the core surface |
| --- | --- |
| `core` | Workspace/file/search/Git, process and shell work, health/observability, context, and read-only diagnostics |
| `operator` | `core` plus service, package, schedule, backup, support evidence, database and local operator tools |
| `fleet` | `core` plus registered `remote_host`, `remote_fleet`, and rollout tools |
| `full` | The complete v1 surface (default, preserving existing clients) |

The server profile only filters advertisement and dispatch. It does not change
permission profiles (`safe`, `balanced`, `full`, `custom`), confirmation rules,
registered workspace roots, remote-host registration, Secret Service, process
ownership, audit, or redaction. A hidden tool is rejected as an unknown tool;
it cannot be reached through `tool_batch`.

Invalid values fail closed at headless startup with an `INVALID_INPUT`
diagnostic. The selected profile is included in sanitized `health` metadata.
Windows-only tools and capabilities remain absent on Linux regardless of the
server profile.
