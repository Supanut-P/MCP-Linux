# Baitonghub-Linux-mcp v1.0.0

The first stable Linux headless contract release.

- freezes the canonical MCP tool schemas and permission annotations;
- adds deterministic upgrade/rollback state-protection acceptance checks;
- adds secret-leak regression coverage for database and SSH providers;
- documents tunnel reconnect evidence and provides a repeatable soak recorder;
- hardens Linux package inspection and CI against Windows/GUI resources; and
- keeps Ubuntu 24.04 x64, registered roots, Secret Service, and explicit
  confirmation as the supported security boundary.

The soak recorder is an operator tool. A script being present does not claim
that a seven-day run has completed; attach its output as release evidence.
