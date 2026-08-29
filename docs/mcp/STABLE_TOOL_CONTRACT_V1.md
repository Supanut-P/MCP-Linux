# Baitonghub-Linux-mcp Stable MCP Contract v1

Status: v1.0.0 contract. Scope: Ubuntu 24.04 x86_64, Linux headless runtime.

This document freezes the MCP boundary exposed by the headless server. The
canonical input schemas, permission class, and read-only/destructive hints are
recorded in [`tests/fixtures/tool-contract-v1.json`](../../tests/fixtures/tool-contract-v1.json).
The fixture is generated from the live `ToolRegistry` and is checked in CI by
`pnpm contract:v1`. Tool descriptions are intentionally informative and are
not compatibility keys.

## Compatibility rules

- Tool names, operation discriminators, required fields, enum values, and
  validation bounds are stable for the v1 major line.
- Removing or renaming a v1 field, changing an enum, weakening a registered
  root, or changing a permission/destructive classification requires a major
  version and a migration note.
- Additive optional fields and new read-only tools are compatible when they do
  not widen an existing authority boundary.
- Every response is a structured result. Errors use shared codes, including
  `CAPABILITY_UNAVAILABLE`, `CAPABILITY_CONSENT_REQUIRED`,
  `PLATFORM_UNSUPPORTED`, and `PERMISSION_REQUIRED`.
- Descriptions may be improved without changing the contract fixture.

## Tool contract fields

Each fixture entry contains:

| Field | Meaning |
| --- | --- |
| `name` | Public MCP tool name |
| `permission` | `READ`, `WRITE`, `EXECUTE`, or `DANGEROUS` |
| `annotations.readOnlyHint` | Whether the operation is intended to be read-only |
| `annotations.destructiveHint` | Whether the gateway treats it as side-effect capable |
| `inputSchema` | Canonical JSON Schema generated from the strict Zod schema |

The fixture is the exact list returned by the v1 registry, including opt-in
Codex delegation tools used by the catalog generator. The default runtime may
omit opt-in tools according to its explicit configuration.

## Authority and result guarantees

Filesystem, process, Git, archive, container, database, and remote-host
operations are bounded by registered roots or registered targets. Full profile
means full capability inside those registrations; it never means unrestricted
root access. State-changing operations require a preview where supported and
explicit user confirmation. Remote hosts require a pinned SSH fingerprint,
Secret Service reference, and registered remote roots.

Database credentials, tunnel keys, private keys, bearer tokens, and passwords
are never accepted as ordinary MCP fields or emitted in structured results,
logs, audit records, diagnostics, command arguments, or package metadata.

## Deprecation policy

Deprecated tools remain documented for one major line and return a structured
deprecation notice while their replacement is available. A removal is listed
in release notes, reflected in a new major fixture, and never silently aliases
to a more privileged operation.

## Verification

```sh
corepack pnpm@10.15.0 contract:v1
corepack pnpm@10.15.0 exec vitest run tests/acceptance/tool-contract-v1.test.ts
```

Do not hand-edit the JSON fixture. Regenerate it only after reviewing the
schema and permission change that caused the diff.
