# Baitonghub-Linux-mcp v1.4.2

This patch release keeps the v1.4 headless Linux contract unchanged and makes
the full workspace test gate deterministic on constrained CI runners.

## Included

- serialized root workspace test execution to avoid process-group tests racing
  with other workspace packages under runner CPU/process pressure;
- retained the durable-shell cancellation test margin introduced in v1.4.1;
- no MCP tool, schema, permission, or runtime behavior changes; and
- the same Ubuntu 24.04 x86_64 headless packages and transport support as
  v1.4.0.

## Verification

- Ubuntu 24.04 x86_64 serialized workspace suite: all 17 test-bearing packages
  passed, including capabilities 115/115 and MCP server 174/174;
- local release gates: rebrand, lint, typecheck, integration, packaging,
  release-gate, tool catalog, v1 contract, and `git diff --check` passed; and
- the seven-day v1.5 soak remains a separate evidence gate and is not claimed
  by this release.
