# Baitonghub-Linux-mcp v1.10.0

## Resumable remote rollout recovery

- Added the additive `remote_rollout_resume` MCP tool.
- Preview/execute flow retries only failed or unattempted registered hosts.
- Confirmed-success hosts are never restarted during recovery.
- Fresh 15-minute previews, explicit confirmation, atomic claims, bounded
  attempts, and existing concurrency limits remain mandatory.
- Ambiguous remote outcomes are exposed as `unverified` and are not retried
  automatically.
- Resume previews are persisted in SQLite without credentials or connection
  metadata and remain covered by approval receipts and redacted audit events.

This local milestone is Linux headless only. Push, tag, and public release stay
behind the explicit human release gate after Ubuntu package verification.
