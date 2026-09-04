# Baitonghub-Linux-mcp v1.32.0

## Workspace checkpoint diff

v1.32 extends `workspace_checkpoint` with a bounded `diff` operation. An agent
can compare the current registered workspace with a saved owner-isolated
checkpoint without sending the stored manifest back through the client.

- The service loads only the caller's checkpoint ID and uses its stored
  workspace/path; callers cannot select a different workspace or baseline.
- Results reuse the metadata-only `workspace_snapshot` diff shape with added,
  removed, changed, unchanged, and truthful `truncated` fields.
- Missing, expired, or foreign checkpoints return `FILE_NOT_FOUND`; scanner
  failures remain structured and sanitized.

## Verification policy

The seven-day soak is waived for this development line and is not production
evidence. Build release artifacts only from a verified exact commit; record
Ubuntu 24.04 x64 test, package, provenance, and smoke results before any
external push, tag, or release.
