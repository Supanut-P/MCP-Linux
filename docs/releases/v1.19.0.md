# Baitonghub-Linux-mcp v1.19.0

## Task Events

v1.19 adds `task_events`, a read-only, reconnect-safe lifecycle stream for
owned durable shell tasks and remote rollouts.

- Monotonic sequence numbers with bounded cursor pagination.
- Optional bounded wait for reconnect polling.
- Session/task ownership checks on every cursor.
- Sanitized state, timestamps, phases, attempts, and result codes only.
- No command lines, paths, output, environment values, host keys, or secrets.

The feature is additive; existing v1 tools and schemas remain compatible.
This release has no seven-day production soak claim. External push, tag, and
GitHub release operations remain a separate human approval gate.
