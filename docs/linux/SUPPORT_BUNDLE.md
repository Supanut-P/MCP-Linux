# Sanitized support bundles (v1.9)

`support_bundle` creates a small diagnostic archive inside a registered
workspace. It is intended for troubleshooting a headless Ubuntu installation
without copying credentials, private keys, raw command arguments, or arbitrary
filesystem data to an operator.

## Safe flow

1. Call `support_bundle` with `dry_run: true`, a registered `workspaceId`, a
   relative `destination`, and one or more sections.
2. Review the returned member list, redaction policy, byte limits, and
   `previewHash`.
3. Repeat with the same input, that `previewHash`, and `userConfirmed: true`.
   The runtime performs the write-scoped permission check and records the
   non-secret approval receipt with the completed audit event.

Example request:

```json
{
  "workspaceId": "workspace-id",
  "destination": "diagnostics/support-1.9.tar.gz",
  "include": ["doctor", "health", "runtime", "audit-summary", "recent-errors", "package-files"],
  "dry_run": true
}
```

The archive contains `manifest.json` plus the selected section files:

- `doctor.txt` — sanitized runtime checks;
- `health.json` — capability availability and missing-dependency reasons;
- `runtime.json` — product, platform, architecture, and runtime metadata;
- `audit-summary.json` — bounded result-code counts and the latest timestamp;
- `recent-errors.json` — at most the newest 200 non-success audit events; and
- `package-files.txt` — package/runtime file names only.

The uncompressed content and final archive are each capped at 2 MiB. Temporary
files are created with mode `0700`, members with mode `0600`, and the temporary
directory is removed after archiving. The destination must remain inside the
registered workspace and symlink escapes are rejected.

Redaction uses the shared `audit-redactor-v1` policy and an additional
secret/token pattern pass. Secrets are not accepted as bundle input and are
not included in the result, archive filename, audit metadata, or stdout. A
provider failure becomes a sanitized `unavailable` entry; it is never copied
verbatim into the archive.

`support_bundle` is a dangerous write-scoped tool even though its contents are
diagnostic. Keep `dry_run` as the default and require explicit confirmation for
creation. The tool is available only in the headless Linux registry when the
runtime has a registered workspace and archive capability.
