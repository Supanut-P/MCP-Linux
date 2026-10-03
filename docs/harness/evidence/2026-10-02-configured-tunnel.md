# v1.37 configured tunnel acceptance — 2026-10-02

The user-specified `codex-vm103-mcp-20260825` SSH identity successfully
accessed the approved existing test VM as root. The host is Ubuntu 24.04
x86_64; MCP and tunnel services continue to run as adminops.

## Candidate and recovery point

Installed the previously verified DEB for source snapshot
`bbd47e10c0575f9ddb9312d8c61e752f1a8858c9`, SHA-256
`1a01ef081970d34d19831163e2877d8e57435e1ff1de47bb98f9db4604902de5`.
Both the candidate and retained 1.36 rollback package passed remote checksum
checks. Before installation, stopped both services and copied the installed
program and SQLite state into a root-only rollback directory on the test VM.
Backups, credentials, profile contents and runtime database were not downloaded.

Executed `bash vm39-candidate-install.sh` over pinned native OpenSSH, exit 0.
Installed version changed from 1.36.0 to 1.37.0. Pre/post SQLite integrity
checks returned `ok`; the database owner remains adminops. Profile, two known
credential files, and the effective `/etc` tunnel service override stayed
byte-identical. Both services returned active; `/healthz` and `/readyz`
returned HTTP 200. Eight installed launchers/bundles/scripts compare
byte-for-byte with the exact candidate DEB.

## Native connector and reconnect

Called `health(check_all)`, `workspace_list`, and bounded `read_file` through
the existing native connector after upgrade, then explicitly restarted
`baitonghub-linux-mcp-tunnel@adminops.service`. Readiness returned HTTP 200;
all three connector calls succeeded again at 2026-10-02 16:40:39 UTC.
The registered workspace and its read capability survived the upgrade.
Its historical checkout reports 1.11.0; this is distinct from the installed
runtime 1.37.0 and is not used as runtime-version evidence.

## Credential observations

Executed `python3 vm39-runtime-check.py`, exit 0. It compared only the two
existing known credential values and encoded forms internally, printing
counts and package hashes rather than content. Zero matches appeared in:

- Profile YAML and the two service process groups' arguments.
- Bounded startup stdout/stderr journal: 8 MCP lines and 56 tunnel lines.
- 12 MCP audit records since the upgrade observation boundary.
- Installed `status` and `doctor` stdout/stderr; both commands exited 0.

Additionally executed `python3 vm39-incident-check.py`, exit 0, against the
service's existing configured HTTP bind using its existing bearer internally.
MCP initialization reported runtime version 1.37.0; `diagnostics_snapshot`
succeeded. Its bounded response (1,735 serialized bytes) contained zero matches
for the two known credentials, the existing HTTP bearer, and encoded forms.
Only counts/version were retained. The initial loopback probe failed with
connection refused; inspecting the two non-secret bind settings corrected the
probe without changing service configuration.

This is bounded evidence for known credentials after upgrade. It does not
establish absence of every possible secret or seven-day stability.
Synthetic redaction/boundary tests remain covered by
the source-gate receipt; a soak waiver remains a waiver.

## Retention and boundary

The [machine receipt](2026-10-02-configured-tunnel.json) binds scripts, retained
sanitized logs, package and source hashes. Raw safe receipts are retained under
ignored `dist/v1.37.0-local-20260930/`. The rollback point remains on the VM;
automatic failure rollback was prepared but not triggered. Actual package
rollback evidence is separately recorded in the
[disposable Ubuntu receipt](2026-10-01-packaged-fleet.md).

This closes the previously missing configured-candidate and reconnect proof.
Independent Sol QA re-reviewed the receipts and resolved incident-diagnostic
and stale-roadmap findings; no remaining material findings were reported.
Together with the accumulated source/package/lifecycle/fleet receipts, v1.37
milestone verification is closed. The reviewer inspected evidence and did not
execute the runtime checks; the lead executed them.
No credential changes, Git publication, production-readiness, provider/model
readiness, token savings or v2 completion are claimed. The roadmap goal is
active again; historical authentication-blocked reports remain historical.
