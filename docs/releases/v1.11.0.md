# Baitonghub-Linux-mcp v1.11.0

## Task-augmented remote rollout progress

- Added standard MCP Tasks creation for confirmed `remote_rollout` execute
  requests.
- Rollout task IDs are durable rollout IDs and can be polled after reconnect by
  the same client/session actor.
- Added owner isolation for `tasks/get`, `tasks/list`, `tasks/result`, and
  `tasks/cancel`; other actors receive not-found behavior.
- Persisted sanitized per-host progress events with a hard cap of 200 entries.
- Background execution retains the existing preview hash, workspace, explicit
  confirmation, bounded concurrency, audit redaction, and `unverified` outcome
  safety rules.

This is a Linux headless milestone. No arbitrary remote shell authority,
credential storage, or automatic host registration was added. Push, tag, and
public release remain behind the explicit human release gate after Ubuntu
verification.
