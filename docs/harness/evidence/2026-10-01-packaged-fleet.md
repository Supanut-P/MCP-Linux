# Packaged fleet acceptance follow-up — 2026-10-01

Status: **Ubuntu package and native MCP fleet checks passed; configured-tunnel
candidate gate remains OPEN.** v1.38 has not started.

The existing approved disposable Ubuntu test VM remains available for
candidate fleet acceptance while the configured tunnel host requires corrected
operator authentication. These are separate targets and evidence boundaries.

The retained candidate DEB SHA-256 is
`1a01ef081970d34d19831163e2877d8e57435e1ff1de47bb98f9db4604902de5`;
its source snapshot is `bbd47e10c0575f9ddb9312d8c61e752f1a8858c9`.
The previous snapshot and artifact receipt remain historical and separate.

## Launcher regression and new source binding

The documented public launcher did not dispatch `remote-host` or `database`
to its existing admin implementation. The two-file repair adds those routes
and preserves quoted arguments and unknown-command refusal. The Linux
regression first reproduced remote-host refusal (1 failed, 7 passed), then
passed 8/8 after the repair. An earlier fixture run failed on CRLF and was
corrected before treating RED as product evidence. Windows focused checks
passed 7 with this Linux-only case skipped; focused ESLint passed.

The isolated follow-up Git snapshot is clean and contains only these two
product changes relative to the earlier snapshot. Its full tracked manifest
contains 580 files, including two historical local receipts that the previous
selected 578-file manifest excluded. Manifest SHA-256:
`c216a5486d7dd6a1a800850bc6e79c309675a07d3f9b2d9d0a709e2e2486dac8`.
The root upstream checkout was not committed or branched.

All 14 Ubuntu source/package gates returned exit 0: unit 684 passed/1
Windows-only skip, integration 3, packaging 16, release gate 10, and v1
acceptance 5. Catalog/contract remain 227 tools. Extracted DEB/tar package
inspection, provenance, SBOM, and upgrade/rollback preflight passed.
Linux tar SHA-256:
`fc6ec46e95ef66da496498c413a4105878921133abe55b7415af5de3680c1a14`.

## Installed artifact and fleet acceptance

- Actual install → upgrade → rollback → uninstall → reinstall passed, leaving
  the repaired 1.37 candidate installed on the disposable VM. SQLite owner is
  baitong; its hash remained
  `2e70514589997f56cc076f607e59166c9cdac17bfd6cd3cf3302cb79a9ace674`.
- Installed launcher, bundled Node, and all three bundles compare byte-for-byte
  with the new snapshot's build output. Service-template ownership was checked;
  active service runtime was not inferred from template checks.
- Installed STDIO and HTTP smoke passed with 221 provider-filtered tools while
  system Node was absent from PATH. The first STDIO fixture omitted Git; its
  failed log was retained, required Git/ripgrep were added to the isolated PATH,
  and the rerun passed. Diagnostics/preflight remain qualified as degraded.
- Native installed HTTP MCP initialization reports 1.37.0. Registered journal
  success, invalid unit/lines, forbidden command/hostname fields, unregistered
  refusal, and deterministic partial failure passed. Partial failure took
  391 ms; successful journal output was 228 bytes. The forced SSH command log
  contains exactly two fixed journal commands, proving irrelevant path data
  was not forwarded. No raw journal was copied into this public receipt.
- The fixture used real Secret Service and pinned loopback OpenSSH, isolated
  XDG/registry state, and throwaway keys. It stopped owned processes and removed
  its temporary directory. Independent Sol review found no remaining fixture
  or product-patch defect by inspection; the lead executed the runtime checks.

Archive: `dist/v1.37.0-local-20260930/launcher-followup-evidence.tar.gz`;
SHA-256 `aaec3ec8db1760eb5e8af4009eec6b555186563d5d16ba3891712be79ea5fa01`.
After download, the archive, source manifest, and all 36 retained log/artifact
hashes were verified. See the [machine receipt](2026-10-01-packaged-fleet.json).

## Native credential-provider preparation

- Installed `gnome-keyring` with `apt-get install -y --no-install-recommends
  gnome-keyring`, exit 0, on the approved disposable VM. No PAM integration
  package was requested and system D-Bus restart was deferred.
- Runtime versions: GNOME Keyring 46.1-2ubuntu0.2, D-Bus 1.14.10-4ubuntu4.1,
  libsecret-tools 0.21.4-1build3.
- Retained log: `dist/v1.37.0-local-20260930/fleet-secret-service-install.log`.
  SHA-256: `e76b1d008ec652bd30fc91c8a4dc11c6bc9524c800287ca429b57b07e6f36bc8`.
- An isolated lab HOME/XDG and `dbus-run-session` successfully initialized
  Secret Service, stored a fixture marker through `secret-tool`, checked its
  lookup, and cleared it. Exit 0, `NATIVE_SECRET_SERVICE_PREFLIGHT_OK`.
  No real credential was read or stored in this preflight.

## Remaining boundary

This proves the installed MCP → native provider → Secret Service → pinned
loopback SSH path. It does not prove external-host fleet behavior, saturation,
or secret-canary redaction. The configured connector host still runs 1.36 and
its authorized password attempt failed; candidate install and tunnel reconnect
require corrected authentication. The seven-day soak is waived, not passed.
No model/auth/cancellation, token-savings, publication, or v2 completion claim
is made. Final publication must bind the approved final source and artifacts.
