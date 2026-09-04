# Baitonghub-Linux-mcp v1.6.0

## Target discovery and registry lifecycle

This release adds the read-only `target_catalog` MCP tool. A connected client
can now discover registered database and SSH target aliases without receiving
host addresses, usernames, database names, roots, fingerprints, secret
references, or secret values.

The local headless administrator can replace or remove a target with an exact
ID confirmation:

```text
baitonghub-linux-mcp database replace <id> <driver> <host> <port> <database> <username> <secret-ref>
baitonghub-linux-mcp database remove <id> --confirm <id>
baitonghub-linux-mcp remote-host replace <id> <host> <port> <username> <secret-ref> <fingerprint> <root[,root...]>
baitonghub-linux-mcp remote-host remove <id> --confirm <id>
```

Replacement validates the complete registration before changing the existing
row. Removal is fail-closed and reports whether the target existed.

## Safety and compatibility

- Linux headless scope remains Ubuntu 24.04 x64 with registered roots and
  registered remote hosts only.
- Database registrations remain explicitly `readOnly=true`.
- Secret Service references are never returned by MCP or written to logs.
- Existing v1 tools and schemas remain compatible; `target_catalog` is only
  advertised when its registry service is wired.
- The seven-day soak waiver from v1.5.0 remains in force and this release does
  not make a production-readiness claim.

## Verification

The release candidate must pass the repository lint, typecheck, full tests,
integration, packaging, release-gate, tool-catalog, v1-contract, and Ubuntu
package install/upgrade/rollback checks before an external tag or release is
created.
