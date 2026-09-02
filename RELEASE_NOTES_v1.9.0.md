# Baitonghub-Linux-mcp v1.9.0

v1.9 adds two operator-facing safety features for the headless Linux runtime:

- stable, non-secret approval receipts attached to dangerous-call audit events;
- confirmation-gated `support_bundle` diagnostics inside registered workspaces.

Support bundles use the shared `audit-redactor-v1` policy, cap recent errors at
200 events, cap both uncompressed content and the final archive at 2 MiB,
reject path escapes, and return only a registered relative path, SHA-256, size,
member count, and receipt ID. Provider failures are sanitized to an
`unavailable` entry.

This release remains local until Ubuntu package evidence and the explicit
external push/tag/release gate are approved. It does not claim a seven-day
soak.
