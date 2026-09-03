# Baitonghub-Linux-mcp v1.20.0

v1.20 adds `policy_explain`, a read-only way for an MCP client or operator to
understand why a currently visible tool can run, needs a registered workspace,
is unavailable because a capability is not wired, or requires confirmation.

Highlights:

- Uses the live `ToolRegistry` surface, server profile, permission profile, and
  capability advertisement; there is no separate policy catalog to drift.
- Reuses the destructive-operation inspector used by dispatch, including
  shell/Git/browser/UI and remote mutation checks.
- Returns sanitized reason codes (`OK`, `TOOL_NOT_AVAILABLE`,
  `PROFILE_REQUIRES_APPROVAL`, `PROFILE_DENIES`, `CONFIRMATION_REQUIRED`,
  `CAPABILITY_UNAVAILABLE`, and `REGISTERED_ROOT_REQUIRED`).
- Never dispatches the named tool, grants authority, reveals hidden tool
  metadata, or returns paths, commands, credentials, or provider output.
- Adds contract/catalog coverage and unit tests for approval, capability,
  registered-root, hidden-tool, and confirmation decisions.

Compatibility remains within the frozen v1 MCP contract. The server is still
Linux headless for Ubuntu 24.04 x64 and keeps registered-root, ownership,
confirmation, audit, and secret-redaction boundaries.

The seven-day soak was waived by the product owner and was not run; this note
does not claim production-soak evidence. External push, tag, and GitHub release
remain a human-gated operation.
