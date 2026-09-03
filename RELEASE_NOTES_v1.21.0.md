# Baitonghub-Linux-mcp v1.21.0

v1.21 adds `task_history`, a bounded read-only view of retained work owned by
the current client session.

Highlights:

- Covers durable shell tasks and remote rollout tasks with deterministic
  newest-first ordering.
- Supports state, ISO time-range, and redacted workspace-hash filters.
- Uses owner- and-filter-bound opaque cursors with a 500-entry retention cap
  and 100-entry pages.
- Returns only task ID, task kind, state, timestamps, workspace hash, result
  code, and bounded duration.
- Excludes command lines, working directories, output, environments, host
  identifiers, credentials, and provider errors.
- Adds Linux snapshot workspace hashes as redacted metadata for history
  filtering; no raw workspace IDs are returned.

The change is additive and keeps the frozen v1 compatibility contract,
registered-root, ownership, confirmation, audit, and Secret Service boundaries.
The seven-day soak remains waived and was not run; this note makes no
production-readiness claim. External push, tag, and GitHub release remain
human-gated.
