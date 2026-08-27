# Security Policy

## Supported versions

Security fixes are prioritized for the latest published Baitonghub-Linux-mcp
release and the current `main` branch.

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

Only test machines, accounts, repositories, and data you own or are explicitly
authorized to assess.
