# Baitonghub-Linux-mcp v1.7.0

## Standard MCP Tasks for durable shell work

v1.7 adds the MCP Tasks task-augmented `tools/call` path for `shell` only.
Clients can submit a long-running shell command with `task: { ttl }` and receive
a standard `CreateTaskResult`, then use `tasks/get`, `tasks/result`, `tasks/list`,
or `tasks/cancel` across reconnects and runtime replacement.

Safety and compatibility:

- Only `shell` with operation `run` accepts task creation; follow-up operations
  and other tools are rejected before dispatch.
- The existing permission, confirmation, ownership, audit, registered-workspace,
  and durable process-group cleanup paths remain authoritative.
- The response never exposes the shell resume token.
- Legacy `shell { execution: "background" }` calls and the existing tasks methods
  remain compatible.

## Verification

- Unit: `TaskCreationAdapter` 4/4 passed.
- HTTP integration: legacy task creation, capability metadata, and task lifecycle
  tests passed.
- Full Ubuntu 24.04 candidate suite for v1.6 passed before starting v1.7.

The v1.7.0 package/release gate is still local until a human approves push,
tag, and release publication.
