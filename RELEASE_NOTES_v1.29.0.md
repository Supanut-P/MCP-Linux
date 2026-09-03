# Baitonghub-Linux-mcp v1.29.0

v1.29.0 extends the read-only `workspace_snapshot` tool with a `usage`
operation. It reports regular-file count, byte total, scanned-entry count, and
truthful truncation for a registered root without reading file contents or
returning absolute paths.

Usage reuses the existing canonical-root, symlink-escape, special-file,
cancellation, and 50,000-entry scan boundaries. Unsafe byte totals saturate at
the JSON-safe maximum and set `truncated: true`; no write, process, remote, or
secret authority is added.

The seven-day soak remains waived and is not production-readiness evidence.
