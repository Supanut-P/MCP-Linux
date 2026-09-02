# Remote rollout (v1.8)

`remote_rollout` is a Linux-headless, registration-only service restart workflow. It does not accept an address, username, key, arbitrary shell, or arbitrary command from MCP input.

## Flow

1. `plan` takes a registered `workspaceId`, 1–20 registered `hostIds`, one `.service` unit, a canary count, and a concurrency limit (1–4).
2. Each host is dry-run checked through the existing pinned-SSH `remote_host` boundary. The runtime stores only host IDs, per-host preview hashes, the aggregate SHA-256, timestamps, and sanitized results.
3. `execute` requires the exact aggregate `previewHash`, an unexpired plan, and `userConfirmed: true`. The canary set runs first; a canary error stops later hosts.
4. Remaining hosts run in bounded batches. `status` returns progress and `cancel` stops scheduling new hosts and aborts active sessions where supported.

Per-host audit records contain only the rollout ID, host alias/registration ID, service unit, workspace ID, phase, result code, and duration. SSH addresses, fingerprints, key paths, credentials, raw provider errors, and command output are not returned or logged.

The feature is optional and is advertised only when the local runtime has both the registered `remote_host` capability and the durable rollout store. A real multi-host restart still requires an operator confirmation gate and should be exercised against a fake SSH runner before production use.
