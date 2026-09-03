# Baitonghub-Linux-mcp v1.33.0

## Workspace checkpoint compare

v1.33 extends `workspace_checkpoint` with a bounded `compare` operation. An
agent can compare two saved owner-isolated manifests without rescanning the
filesystem or sending either manifest through the client.

- The operation accepts only `checkpointId`, `otherCheckpointId`, and an
  optional `maxEntries` cap.
- Both records must belong to the same owner, registered workspace, and
  relative path; cross-scope comparisons fail closed.
- Results reuse the metadata-only snapshot diff shape with added, removed,
  changed, unchanged, and truthful `truncated` fields.

## Verification policy

The seven-day soak is waived for this development line and is not production
evidence. Build release artifacts only from a verified exact commit; record
Ubuntu 24.04 x64 test, package, provenance, and smoke results before any
external push, tag, or release.
