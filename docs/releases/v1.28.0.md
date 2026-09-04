# Baitonghub-Linux-mcp v1.28.0

v1.28.0 adds a read-only `workspace_snapshot` `diff` operation. Supply a
bounded manifest from an earlier snapshot and the runtime reports added,
removed, changed, and unchanged regular files.

The comparison stays inside the registered workspace root, rejects malformed
or escaping baseline paths, preserves optional SHA-256 metadata, and caps the
serialized result at 256 KiB. It never writes files, follows symlink escapes,
returns absolute paths, or exposes commands, credentials, or environment data.

The seven-day soak remains waived and is not production-readiness evidence.
