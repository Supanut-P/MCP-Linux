# Baitonghub-Linux-mcp v1.30.0

## Workflow preflight

v1.30 adds `workflow_preflight`, a read-only advisory tool for checking
whether a headless workflow has the runtime support it needs before starting.
It composes:

- the sanitized `environment_preflight` readiness matrix;
- the fixed-section `diagnostics_snapshot`; and
- optional regular-file usage for one explicitly registered workspace via
  `workspace_snapshot` `usage`.

The optional workspace `path` requires a registered `workspaceId`. Results are
bounded and report `ready`, `degraded`, or `unavailable` truthfully. The tool
does not authorize or execute work, write files, return file contents, expose
absolute paths, or include raw provider errors, credentials, or topology.

## Verification policy

The seven-day soak is waived for this development line and is not production
evidence. Build release artifacts only from a verified exact commit; record
Ubuntu 24.04 x64 test, package, provenance, and smoke results before any
external push, tag, or release.
