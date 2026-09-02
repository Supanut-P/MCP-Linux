# Baitonghub-Linux-mcp v1.8.0

v1.8 adds a bounded, durable `remote_rollout` workflow for restarting one fixed systemd service across registered Linux SSH hosts.

Highlights:

- dry-run plan with per-host and aggregate SHA-256 preview hashes;
- expiry and explicit confirmation before any restart;
- canary-first execution with maximum four concurrent sessions;
- durable SQLite state, cancellation, restart-safe status, and sanitized per-host results;
- per-host audit evidence without SSH credentials, addresses, fingerprints, key paths, or command output;
- no arbitrary remote shell and no expansion of the existing registered-host/root boundaries.

The v1.8 release remains local until the Ubuntu package gate and the external push/tag/release human gate are approved. A real multi-host rollout is not claimed by unit tests.
