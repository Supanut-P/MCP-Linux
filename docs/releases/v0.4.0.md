# Baitonghub-Linux-mcp v0.4.0

v0.4 adds bounded developer operations to the headless Linux MCP runtime.

## Added

- Compose-scoped Docker-first container operations with Podman fallback.
- Explicit confirmation for container lifecycle mutations.
- Registered-root validation of Compose bind mounts and conservative rejection
  of host-authority Compose features.
- Bounded tar, tar.gz, and zip listing, extraction planning, extraction, and
  archive creation with traversal, symlink, device, size, and member limits.
- Read-only dependency audit for pnpm, npm, Python, and Cargo lockfiles.
- Normalized findings for common npm/pnpm/Cargo provider response formats.
- Project snapshot metadata for Compose files, lockfiles, and developer tools.

## Safety behavior

- Container commands always execute through a registered Compose file; direct
  host-wide Docker/Podman operations are not exposed.
- Archive mutations require explicit confirmation and unsafe paths fail closed.
- Dependency auditing never upgrades packages or changes lockfiles.
- Provider output is bounded and sensitive key/value fields are redacted.

## Platform

Ubuntu 24.04 LTS, amd64/x86_64, headless Linux. This release does not add GUI,
Windows, ARM64, or RPM support.
