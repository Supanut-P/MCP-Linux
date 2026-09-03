# Baitonghub-Linux-mcp v1.14.0

v1.14.0 adds a Linux headless workspace change feed for agents that need to
resume file-change work without rescanning or receiving source contents.

## Included

- `workspace_changes` read-only MCP tool with `snapshot` and cursor-based `diff`
  operations.
- Per-workspace bounded journal (maximum 200 events) with monotonic sequences,
  duplicate coalescing, and truthful `WATCHER_NOT_RUNNING` errors.
- Native recursive directory watchers that work on Linux without Electron,
  Wayland, X11, or a desktop session.
- Relative-path normalization and symlink-safe directory traversal; event
  payloads never include file contents or absolute roots.

## Compatibility and safety

Existing MCP tools and schemas remain compatible. `workspace_changes` is
read-only and does not start a watcher implicitly. A caller must first invoke
`workspace_index_watch` for the registered workspace, then use the returned
sequence cursor with `diff`.

The seven-day soak remains waived for this development checkpoint. Package and
external release mutation require the explicit release gate.
