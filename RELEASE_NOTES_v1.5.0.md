# Baitonghub-Linux-mcp v1.5.0

This operational release keeps the v1.4.2 Linux headless MCP contract and
documents the product-owner decision to continue development without waiting
for a seven-day soak.

## Included

- explicit, machine-checked seven-day soak waiver;
- retained VM103 soak process as non-gating observational evidence;
- no MCP tool removals, schema changes, permission widening, or production
  evidence claim; and
- the same Ubuntu 24.04 x86_64 DEB and Linux tarball delivery path.

## Evidence boundary

The clean-machine install/upgrade/rollback/reinstall evidence remains valid.
The seven-day production soak was waived on 2026-09-01 to unblock continued
version work. This release therefore makes **no production-readiness claim**.
The waiver is recorded in
[`docs/linux/evidence/v1.5.0/SEVEN_DAY_SOAK_WAIVER.md`](docs/linux/evidence/v1.5.0/SEVEN_DAY_SOAK_WAIVER.md).

## Verification

Run the standard Linux release gates, package inspection, and contract checks
from the release checklist. A future production release may remove the waiver
only after an operator supplies the completed seven-day evidence artifacts.
