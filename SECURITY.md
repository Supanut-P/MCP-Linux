# Security Policy

## Supported versions

Security fixes are prioritized for the latest published Baitonghub-Linux-mcp
release and the current `main` branch.

The v1.0 stable contract is defined in
[`docs/mcp/STABLE_TOOL_CONTRACT_V1.md`](docs/mcp/STABLE_TOOL_CONTRACT_V1.md).
Report compatibility or authority changes against the exact contract fixture
and release commit.

## Report a vulnerability privately

Do **not** open a public issue for a suspected credential exposure, workspace
escape, permission bypass, destructive-action bypass, process-ownership bypass,
or tunnel authentication issue.

Use the repository Security tab and private vulnerability reporting. If that
option is unavailable, contact the repository owner through GitHub and request
a private channel before sharing exploit details.

Include:

- affected version or commit;
- Ubuntu version and installation type;
- affected MCP transport and capability;
- registered-root and permission-profile context;
- minimal reproduction steps and expected versus actual behavior; and
- impact and proposed mitigation, when known.

Remove tokens, tunnel IDs, credentials, private paths, file contents, and
unrelated machine data from all evidence.

## Security boundaries

Baitonghub-Linux-mcp exposes powerful local development capabilities only within
documented boundaries. A useful security report demonstrates behavior outside
one of these boundaries:

- an operation escapes an explicitly registered root;
- a symlink reaches data outside the root;
- a hard-blocked machine operation runs;
- an unowned process is terminated;
- a destructive action bypasses confirmation;
- a secret appears in logs, audit, diagnostics, command arguments, or Git; or
- an unauthenticated client reaches a protected HTTP MCP endpoint.

The `support_bundle` diagnostic path uses the shared redaction policy, a 2 MiB
archive cap, a 200-event cap, registered-root path checks, and explicit
dry-run confirmation.

v1 operational evidence should also include the package verifier output,
contract snapshot result, upgrade/rollback test result, and (when claiming
runtime stability) the output from `scripts/soak-linux-headless.sh`. The soak
script records evidence but does not by itself certify a completed seven-day
run.

Only test machines, accounts, repositories, and data you own or are explicitly
authorized to assess.
