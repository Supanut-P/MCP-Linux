# Configured-host SSH key test — 2026-10-02

The user supplied the key label `codex-vm103-mcp-20260825` for an access test.
Filename discovery and the earlier operator history located its private-key
file. No private-key contents were printed or copied, and no credentials or
SSH configuration were changed.

Native OpenSSH verified the key fingerprint:
`SHA256:7yEjUOqfuI6YKq8pLBIvRyAoqWRI3pxxrU7RVEu4+G8` (Ed25519).
The key is accepted for **root** on the user-confirmed configured test host;
the same key was refused for adminops. Both attempts used BatchMode,
IdentitiesOnly, strict host-key checking, the existing known-hosts file, and
a 10-second connection timeout.

The successful read-only SSH command returned exit 0:

```sh
id -un
dpkg-query -W baitonghub-linux-mcp
systemctl is-active baitonghub-linux-mcp@adminops.service baitonghub-linux-mcp-tunnel@adminops.service
```

Results: root identity, installed package **1.36.0**, both services **active**.
No installation, restart, profile edit, or deployment was performed.

The earlier authentication blocker is resolved by this root-key access path.
The application's persistent goal still reports `blocked`; the assistant's
goal tools cannot change a blocked goal back to active. Candidate 1.37 tunnel
acceptance remains open, and this access test does not prove that gate.
