# MCP-Linux harness state

The authoritative [v2 roadmap](../superpowers/plans/2026-09-30-mcp-linux-v2-roadmap.md)
defines the accepted product and model-routing policy. Root `AGENTS.md` routes
to three compact repo-local skills; it does not install global configuration or
grant execution authority.

## Current milestone

The disposable Ubuntu source and package gates for v1.37.0 passed, including
install, upgrade, rollback, and reinstall checks. The
[configured candidate receipt](evidence/2026-10-02-configured-tunnel.md) now
records installation on the approved existing tunnel VM, native connector
calls before/after restart, and bounded known-credential checks including
incident diagnostics. Independent QA found no remaining material findings;
v1.37 milestone verification is closed. Publication remains unapproved.
v1.38 milestone verification is also closed after independent QA under the
[native workflow contract](contracts/v1.38-native-workflow.md).
The [native round receipt](evidence/2026-10-03-v1.38-native-flow.md) records the
caller-native worker/QA bugfix round; the [Ubuntu acceptance receipt](evidence/2026-10-03-v1.38-ubuntu.md)
records full gates, package lifecycle and installed STDIO/HTTP/native connector
checks. The configured VM now runs 1.38.0. Publication remains unapproved.
v1.39 implementation is active under the
[context packet contract](contracts/v1.39-context-packets.md). Independent
implementation review approved the bounded reader, packet state, discovery and
transport integration after the final Sol repair. Focused packet checks passed
29 tests; full Ubuntu/package and independent closure gates remain open.

The [2026-10-01 tunnel follow-up](evidence/2026-10-01-existing-tunnel.md)
verified the previously configured host through the native connector: MCP and
tunnel services are active, health/readiness endpoints return 200, and
workspace read works. Its installed package remains 1.36.0; this does not
close candidate 1.37 acceptance. The [2026-10-02 SSH key test](evidence/2026-10-02-ssh-key-access.md)
now verifies root access using the user-specified key. The authentication
blocker is resolved; no candidate installation or restart was performed in
that access test. The roadmap goal has since resumed and is active; the new
candidate receipt records the subsequent authorized installation and restart.

The [new packaged fleet receipt](evidence/2026-10-01-packaged-fleet.md) records
a public-launcher routing repair, full Ubuntu gates, install/rollback, and
installed MCP → native Secret Service → pinned loopback SSH proof. This new
snapshot and its hashes supersede the earlier candidate for future acceptance;
the earlier receipts remain historical. External fleet and canary/saturation
claims are outside this fixture's scope.

See the [local receipt](evidence/2026-09-30-v1.37-local.md) and separate
[Ubuntu receipt](evidence/2026-09-30-v1.37-ubuntu.md). They bind to different
source snapshots and must remain distinct. Ubuntu artifacts and raw logs are
retained in the ignored `dist/v1.37.0-local-20260930/` directory. Subsequent
document edits are not part of the verified Ubuntu source snapshot.
## Verification and authority

Evidence must name its source snapshot, command, exit status, artifacts, and
boundary. Do not equate Windows tests with Ubuntu behavior, fixture tests with
live SSH, byte savings with token savings, or CLI installation with provider
authentication/model selection/cancellation. A soak waiver is not a pass.

Use a disposable Ubuntu 24.04 x64 target for package install/upgrade/rollback;
obtain explicit authorization before preparing or mutating infrastructure or
a remote target. Existing v1.36 artifacts are historical evidence only.



