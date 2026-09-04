# Baitonghub-Linux-mcp v1.4.1

This patch release keeps the v1.4 headless Linux contract unchanged and makes
the durable-shell cancellation tests reliable on busy Linux CI runners.

## Included

- increased the lifetime of cancellation-test child processes so they remain
  alive while the parallel workspace test suite is running;
- no MCP tool, schema, permission, or runtime behavior changes; and
- the same Ubuntu 24.04 x86_64 headless packages and transport support as
  v1.4.0.

## Verification

- Ubuntu 24.04 x86_64 focused durable-shell suite: 12/12 passed;
- Ubuntu CI-equivalent gates: rebrand, lint, typecheck, full tests,
  integration, packaging, release-gate, tool catalog, v1 contract, and
  `git diff --check` passed; and
- the seven-day v1.5 soak remains a separate evidence gate and is not claimed
  by this release.
