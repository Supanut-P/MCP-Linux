# baitonghub-linux-mcp Tool Contract

Status: God-Tier Wave 0–8 additive contract snapshot for `v4.0.0`.

This is the compatibility contract for the current MCP surface. The runtime
advertises the JSON Schema for every input through `tools/list`; the TypeScript
Zod schemas in `packages/mcp-server/src/tools/` are the implementation source
of truth. The existing human-oriented catalog remains useful for field details,
while this document records the primitive/core contract, preserves the earlier
compatibility baseline, and records policy class, annotations, and schema source.
The full configurable v4 registry contains 214 tools; the default runtime advertises 208 because the six `codex_*` delegation tools are opt-in. The additive v4 entries are defined
in `packages/mcp-server/src/upgrade-catalog.ts` and the exact runtime order is
verified by `packages/mcp-server/src/tool-registry.test.ts`.

<!-- BEGIN GENERATED TOOL REGISTRY -->
## Generated live ToolRegistry index

This block is generated from the built `ToolRegistry`. Current count: **198 tools**.
Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.

| # | Tool | Permission | Read-only | Destructive |
| ---: | --- | --- | :---: | :---: |
| 1 | `workspace_list` | READ | yes | no |
| 2 | `workspace_register` | WRITE | no | no |
| 3 | `workspace_info` | READ | yes | no |
| 4 | `workspace_tree` | READ | yes | no |
| 5 | `project_snapshot` | READ | yes | no |
| 6 | `read_file` | READ | yes | no |
| 7 | `read_files` | READ | yes | no |
| 8 | `search_files` | READ | yes | no |
| 9 | `search_text` | READ | yes | no |
| 10 | `git_status` | READ | yes | no |
| 11 | `git_diff` | READ | yes | no |
| 12 | `git_log` | READ | yes | no |
| 13 | `git` | EXECUTE | no | yes |
| 14 | `write_file` | WRITE | no | no |
| 15 | `apply_patch` | WRITE | no | no |
| 16 | `move_file` | WRITE | no | no |
| 17 | `copy_file` | WRITE | no | no |
| 18 | `delete_file` | DANGEROUS | no | yes |
| 19 | `restore_deleted_file` | WRITE | no | no |
| 20 | `process_start` | EXECUTE | no | no |
| 21 | `process_list` | READ | yes | no |
| 22 | `process_status` | READ | yes | no |
| 23 | `process_logs` | READ | yes | no |
| 24 | `process_stop` | EXECUTE | no | no |
| 25 | `project_dev` | EXECUTE | no | no |
| 26 | `project_test` | EXECUTE | no | no |
| 27 | `project_lint` | EXECUTE | no | no |
| 28 | `project_typecheck` | EXECUTE | no | no |
| 29 | `project_build` | EXECUTE | no | no |
| 30 | `codex_status` | READ | yes | no |
| 31 | `codex_run` | EXECUTE | no | no |
| 32 | `codex_task_list` | READ | yes | no |
| 33 | `codex_task_status` | READ | yes | no |
| 34 | `codex_task_logs` | READ | yes | no |
| 35 | `codex_stop` | EXECUTE | no | no |
| 36 | `shell` | EXECUTE | no | yes |
| 37 | `dom_cdp` | DANGEROUS | no | yes |
| 38 | `accessibility` | DANGEROUS | no | yes |
| 39 | `input_event` | DANGEROUS | no | yes |
| 40 | `vision` | READ | yes | no |
| 41 | `vision_annotated_capture` | READ | yes | no |
| 42 | `ui_target_action` | DANGEROUS | no | yes |
| 43 | `window` | DANGEROUS | no | yes |
| 44 | `health` | READ | yes | no |
| 45 | `system_info` | READ | yes | no |
| 46 | `journal` | READ | yes | no |
| 47 | `network` | READ | yes | no |
| 48 | `notification` | EXECUTE | no | no |
| 49 | `file_dialog` | EXECUTE | yes | no |
| 50 | `clipboard` | DANGEROUS | no | no |
| 51 | `web_fetch` | DANGEROUS | yes | no |
| 52 | `skills_list` | DANGEROUS | no | yes |
| 53 | `skills_read` | DANGEROUS | no | yes |
| 54 | `mcp_list` | DANGEROUS | no | yes |
| 55 | `mcp_describe` | DANGEROUS | no | yes |
| 56 | `mcp_call` | DANGEROUS | no | yes |
| 57 | `workspace_context` | READ | yes | no |
| 58 | `workspace_context_continue` | READ | yes | no |
| 59 | `workspace_full_scan` | READ | yes | no |
| 60 | `workspace_full_scan_continue` | READ | yes | no |
| 61 | `workspace_snapshot` | READ | yes | no |
| 62 | `search_all` | READ | yes | no |
| 63 | `read_many_files` | READ | yes | no |
| 64 | `read_file_page` | READ | yes | no |
| 65 | `read_file_page_continue` | READ | yes | no |
| 66 | `workspace_index` | READ | yes | no |
| 67 | `workspace_index_status` | READ | yes | no |
| 68 | `workspace_index_watch` | READ | yes | no |
| 69 | `workspace_index_stop` | READ | yes | no |
| 70 | `session_handoff` | READ | yes | no |
| 71 | `verify_incremental` | EXECUTE | no | no |
| 72 | `symbol_search` | READ | yes | no |
| 73 | `find_definition` | READ | yes | no |
| 74 | `find_references` | READ | yes | no |
| 75 | `find_implementations` | READ | yes | no |
| 76 | `call_hierarchy` | READ | yes | no |
| 77 | `import_graph` | READ | yes | no |
| 78 | `dependency_graph` | READ | yes | no |
| 79 | `module_graph` | READ | yes | no |
| 80 | `type_search` | READ | yes | no |
| 81 | `trace_symbol` | READ | yes | no |
| 82 | `context_ranking` | READ | yes | no |
| 83 | `debug_context` | READ | yes | no |
| 84 | `review_context` | READ | yes | no |
| 85 | `change_context` | READ | yes | no |
| 86 | `symbol_context` | READ | yes | no |
| 87 | `test_context` | READ | yes | no |
| 88 | `dependency_context` | READ | yes | no |
| 89 | `git_context` | READ | yes | no |
| 90 | `frontend_context` | READ | yes | no |
| 91 | `backend_context` | READ | yes | no |
| 92 | `route_intent` | READ | yes | no |
| 93 | `recipe_list` | READ | yes | no |
| 94 | `recipe_describe` | READ | yes | no |
| 95 | `recipe_run` | EXECUTE | no | no |
| 96 | `dry_run` | READ | yes | no |
| 97 | `review_changes` | READ | yes | no |
| 98 | `changed_symbols` | READ | yes | no |
| 99 | `affected_modules` | READ | yes | no |
| 100 | `git_history_context` | READ | yes | no |
| 101 | `git_blame_context` | READ | yes | no |
| 102 | `discover_tests` | READ | yes | no |
| 103 | `run_affected_tests` | EXECUTE | no | no |
| 104 | `test_failures` | READ | yes | no |
| 105 | `coverage_context` | READ | yes | no |
| 106 | `test_history` | READ | yes | no |
| 107 | `cache_stats` | READ | yes | no |
| 108 | `cache_clear` | WRITE | no | no |
| 109 | `cache_invalidate` | WRITE | no | no |
| 110 | `hook_list` | READ | yes | no |
| 111 | `hook_register` | WRITE | no | no |
| 112 | `hook_remove` | WRITE | no | no |
| 113 | `skill_match` | READ | yes | no |
| 114 | `skill_load` | READ | yes | no |
| 115 | `plugin_install` | DANGEROUS | no | yes |
| 116 | `plugin_list` | READ | yes | no |
| 117 | `plugin_enable` | WRITE | no | no |
| 118 | `plugin_disable` | WRITE | no | no |
| 119 | `plugin_remove` | DANGEROUS | no | yes |
| 120 | `session_context` | READ | yes | no |
| 121 | `session_checkpoint` | WRITE | no | no |
| 122 | `session_resume` | READ | yes | no |
| 123 | `session_history` | READ | yes | no |
| 124 | `response_mode` | READ | yes | no |
| 125 | `inspect_web_app` | READ | yes | no |
| 126 | `debug_ui` | READ | yes | no |
| 127 | `capture_ui_state` | READ | yes | no |
| 128 | `form_context` | READ | yes | no |
| 129 | `network_context` | READ | yes | no |
| 130 | `console_context` | READ | yes | no |
| 131 | `browser_debug_context` | READ | yes | no |
| 132 | `service_context` | READ | yes | no |
| 133 | `process_context` | READ | yes | no |
| 134 | `port_context` | READ | yes | no |
| 135 | `installed_runtime_context` | READ | yes | no |
| 136 | `path_context` | READ | yes | no |
| 137 | `startup_context` | READ | yes | no |
| 138 | `mcp_discover` | READ | yes | no |
| 139 | `mcp_health` | READ | yes | no |
| 140 | `mcp_resources` | READ | yes | no |
| 141 | `task_create` | EXECUTE | no | no |
| 142 | `task_status` | READ | yes | no |
| 143 | `task_cancel` | EXECUTE | no | no |
| 144 | `task_result` | READ | yes | no |
| 145 | `task_list` | READ | yes | no |
| 146 | `delegate` | EXECUTE | no | no |
| 147 | `delegate_status` | READ | yes | no |
| 148 | `delegate_cancel` | EXECUTE | no | no |
| 149 | `delegate_result` | READ | yes | no |
| 150 | `parallel_delegate` | EXECUTE | no | no |
| 151 | `permission_check` | READ | yes | no |
| 152 | `permission_profile` | READ | yes | no |
| 153 | `live_logs_query` | READ | yes | no |
| 154 | `live_logs_status` | READ | yes | no |
| 155 | `telemetry_dashboard` | READ | yes | no |
| 156 | `context_economy_stats` | READ | yes | no |
| 157 | `execution_plan` | READ | yes | no |
| 158 | `repo_map` | READ | yes | no |
| 159 | `context_expand` | READ | yes | no |
| 160 | `recovery_status` | READ | yes | no |
| 161 | `tool_schema_list` | READ | yes | no |
| 162 | `tool_schema_register` | WRITE | no | no |
| 163 | `capabilities` | READ | yes | no |
| 164 | `tool_search` | READ | yes | no |
| 165 | `tool_dynamic_filter` | READ | yes | no |
| 166 | `tool_describe` | READ | yes | no |
| 167 | `tool_categories` | READ | yes | no |
| 168 | `tool_function_find` | READ | yes | no |
| 169 | `tool_aliases` | READ | yes | no |
| 170 | `mcp_hub` | READ | yes | no |
| 171 | `dev_context` | READ | yes | no |
| 172 | `recipe_catalog` | READ | yes | no |
| 173 | `capture_screenshot` | READ | yes | no |
| 174 | `compare_screenshot` | READ | yes | no |
| 175 | `dom_snapshot` | READ | yes | no |
| 176 | `layout_metadata` | READ | yes | no |
| 177 | `visual_context` | READ | yes | no |
| 178 | `inspect_pdf` | READ | yes | no |
| 179 | `compare_pdf_pages` | READ | yes | no |
| 180 | `project_profile_get` | READ | yes | no |
| 181 | `project_profile_set` | WRITE | no | no |
| 182 | `handoff_context` | READ | yes | no |
| 183 | `benchmark_run` | EXECUTE | no | no |
| 184 | `regression_report` | READ | yes | no |
| 185 | `lsp_diagnostics` | READ | yes | no |
| 186 | `lsp_rename` | WRITE | no | no |
| 187 | `debug_attach` | EXECUTE | no | no |
| 188 | `debug_step` | EXECUTE | no | no |
| 189 | `git_worktree_spawn` | DANGEROUS | no | yes |
| 190 | `git_worktree_remove` | DANGEROUS | no | yes |
| 191 | `db_inspect` | READ | yes | no |
| 192 | `db_query` | DANGEROUS | no | yes |
| 193 | `pdf_extract_tables` | READ | yes | no |
| 194 | `self_heal_plan` | READ | yes | no |
| 195 | `self_heal_apply` | DANGEROUS | no | yes |
| 196 | `skills_import` | WRITE | no | no |
| 197 | `agent_swarm_run` | EXECUTE | no | no |
| 198 | `tool_batch` | DANGEROUS | no | yes |
<!-- END GENERATED TOOL REGISTRY -->

## Protocol and result rules

- Tool names and registry order are deterministic.
- Every request is schema-validated before the application service runs.
- Every result is structured JSON-compatible MCP content; errors use the
  repository error/result mapping and do not expose secrets or raw stack traces.
- `readOnlyHint` is advisory metadata for clients. It never grants permission.
- `destructiveHint` is advisory metadata for clients. Permission policy and hard
  blocks remain authoritative.
- A bounded result must report truncation, continuation, or a bounded-window
  contract. A new compound tool cannot hide data that a primitive tool can read.
- `workspaceId` is required where the operation is workspace-scoped unless an
  explicitly normalized absolute path is accepted by that tool's schema.

## Permission classes

| Class | Meaning | Existing profile behavior |
| --- | --- | --- |
| `READ` | No intentional mutation; inspection or local diagnostics | allowed by Safe/Balanced/Full |
| `WRITE` | Changes workspace files or registration state | prompts in Safe; allowed in Balanced/Full |
| `EXECUTE` | Starts/controls an owned command, process, project, or Codex task | prompts in Safe; allowed in Balanced/Full |
| `DANGEROUS` | Destructive, interactive, external, or full-access meta capability | denied in Safe; prompts in Balanced; allowed in Full subject to hard blocks |

Desktop uses its configured local permission profile. Packaged stdio keeps `full` as the backward-compatible default but accepts `safe|balanced|full|custom` through the launcher, environment, or Desktop STDIO policy settings. Optional strict-root mode suppresses automatic whole-drive registration and exposes only explicit canonical allowed roots. These controls do not disable ownership checks, realpath/reparse-point guards, secret policy, or hard blocks, and strict roots are not an OS sandbox.

Destructive operations still require explicit chat confirmation by default. The only configurable exception is the scoped `delete_file` tool when **AI File Delete Policy** is explicitly enabled; arbitrary shell deletion remains confirmation-gated.

## Core primitive runtime catalog

The table below records the core primitive layer. The full **214-tool** configurable runtime
index is generated from `ToolRegistry` in the project README so it cannot be
mistaken for this smaller primitive table. The `schema` column identifies the
authoritative implementation file and the number of top-level input properties
observed from the live `tools/list` response. The exact optional/default/enum
constraints are the Zod schema in that file and the MCP JSON Schema returned at
runtime; changing either requires a contract test and a catalog update.

| # | Tool | Permission | Read-only hint | Destructive hint | Input properties | Schema source |
| ---: | --- | --- | :---: | :---: | ---: | --- |
| 1 | `workspace_list` | DANGEROUS | no | no | 0 | `workspace-tools.ts` |
| 2 | `workspace_register` | WRITE | no | no | 3 | `workspace-tools.ts` |
| 3 | `workspace_info` | READ | yes | no | 1 | `workspace-tools.ts` |
| 4 | `workspace_tree` | READ | yes | no | 4 | `workspace-tools.ts` |
| 5 | `project_snapshot` | READ | yes | no | 1 | `workspace-tools.ts` |
| 6 | `read_file` | READ | yes | no | 4 | `file-tools.ts` |
| 7 | `read_files` | READ | yes | no | 2 | `file-tools.ts` |
| 8 | `search_files` | READ | yes | no | 5 | `search-tools.ts` |
| 9 | `search_text` | READ | yes | no | 6 | `search-tools.ts` |
| 10 | `git_status` | READ | yes | no | 1 | `git-tools.ts` |
| 11 | `git_diff` | READ | yes | no | 4 | `git-tools.ts` |
| 12 | `git_log` | READ | yes | no | 3 | `git-tools.ts` |
| 13 | `git` | EXECUTE | no | yes | 4 | `git-tools.ts` |
| 14 | `write_file` | WRITE | no | no | 3 | `file-tools.ts` |
| 15 | `apply_patch` | WRITE | no | no | 2 | `file-tools.ts` |
| 16 | `move_file` | WRITE | no | no | 3 | `file-tools.ts` |
| 17 | `copy_file` | WRITE | no | no | 3 | `file-tools.ts` |
| 18 | `delete_file` | DANGEROUS | no | yes | 3 | `file-tools.ts` |
| 19 | `process_start` | EXECUTE | no | no | 5 | `process-tools.ts` |
| 20 | `process_list` | READ | yes | no | 1 | `process-tools.ts` |
| 21 | `process_status` | READ | yes | no | 2 | `process-tools.ts` |
| 22 | `process_logs` | READ | yes | no | 4 | `process-tools.ts` |
| 23 | `process_stop` | EXECUTE | no | no | 2 | `process-tools.ts` |
| 24 | `project_dev` | EXECUTE | no | no | 1 | `process-tools.ts` |
| 25 | `project_test` | EXECUTE | no | no | 1 | `process-tools.ts` |
| 26 | `project_lint` | EXECUTE | no | no | 1 | `process-tools.ts` |
| 27 | `project_typecheck` | EXECUTE | no | no | 1 | `process-tools.ts` |
| 28 | `project_build` | EXECUTE | no | no | 1 | `process-tools.ts` |
| 29 | `codex_status` | READ | yes | no | 0 | `codex-tools.ts` |
| 30 | `codex_run` | EXECUTE | no | no | 2 | `codex-tools.ts` |
| 31 | `codex_task_list` | READ | yes | no | 1 | `codex-tools.ts` |
| 32 | `codex_task_status` | READ | yes | no | 2 | `codex-tools.ts` |
| 33 | `codex_task_logs` | READ | yes | no | 4 | `codex-tools.ts` |
| 34 | `codex_stop` | EXECUTE | no | no | 2 | `codex-tools.ts` |
| 35 | `shell` | EXECUTE | no | yes | 16 | `capability-tools.ts` |
| 36 | `dom_cdp` | DANGEROUS | no | yes | 10 | `capability-tools.ts` |
| 37 | `accessibility` | DANGEROUS | no | yes | 8 | `capability-tools.ts` |
| 38 | `input_event` | DANGEROUS | no | yes | 8 | `capability-tools.ts` |
| 39 | `vision` | READ | yes | no | 12 | `capability-tools.ts` |
| 40 | `window` | DANGEROUS | no | yes | 6 | `capability-tools.ts` |
| 41 | `health` | READ | yes | no | 3 | `capability-tools.ts` |
| 42 | `system_info` | READ | yes | no | 5 | `capability-tools.ts` |
| 43 | `notification` | EXECUTE | no | no | 6 | `capability-tools.ts` |
| 44 | `file_dialog` | EXECUTE | yes | no | 8 | `capability-tools.ts` |
| 45 | `clipboard` | DANGEROUS | no | no | 5 | `capability-tools.ts` |
| 46 | `web_fetch` | DANGEROUS | yes | no | 9 | `capability-tools.ts` |
| 47 | `audio` | DANGEROUS | no | no | 7 | `capability-tools.ts` |
| 48 | `screen_record` | DANGEROUS | no | no | 10 | `capability-tools.ts` |
| 49 | `office` | DANGEROUS | no | no | 12 | `capability-tools.ts` |
| 50 | `scheduler` | DANGEROUS | no | yes | 10 | `capability-tools.ts` |
| 51 | `skills_list` | DANGEROUS | no | yes | 2 | `skill-tools.ts` |
| 52 | `skills_read` | DANGEROUS | no | yes | 2 | `skill-tools.ts` |
| 53 | `mcp_list` | DANGEROUS | no | yes | 0 | `mcp-bridge-tools.ts` |
| 54 | `mcp_describe` | DANGEROUS | no | yes | 1 | `mcp-bridge-tools.ts` |
| 55 | `mcp_call` | DANGEROUS | no | yes | 3 | `mcp-bridge-tools.ts` |
| 56 | `tool_batch` | DANGEROUS | no | yes | 3 | `batch-tools.ts` |
| 57 | `workspace_context` | READ | yes | no | 8 | `context-tools.ts` |
| 58 | `workspace_context_continue` | READ | yes | no | 2 | `context-tools.ts` |
| 59 | `workspace_full_scan` | READ | yes | no | 5 | `context-tools.ts` |
| 60 | `workspace_full_scan_continue` | READ | yes | no | 2 | `context-tools.ts` |
| 61 | `workspace_snapshot` | READ | yes | no | 1 | `context-tools.ts` |
| 62 | `search_all` | READ | yes | no | 6 | `context-tools.ts` |
| 63 | `read_many_files` | READ | yes | no | 2 | `context-tools.ts` |
| 64 | `read_file_page` | READ | yes | no | 5 | `file-page-tools.ts` |
| 65 | `read_file_page_continue` | READ | yes | no | 2 | `file-page-tools.ts` |
| 66 | `workspace_index` | READ | yes | no | 3 | `workspace-index-tools.ts` |
| 67 | `workspace_index_status` | READ | yes | no | 1 | `workspace-index-tools.ts` |
| 68 | `workspace_index_watch` | READ | yes | no | 3 | `workspace-index-tools.ts` |
| 69 | `workspace_index_stop` | READ | yes | no | 1 | `workspace-index-tools.ts` |

## Schema groups and contract examples

The following examples make the required shape explicit without duplicating the
generated JSON Schema. Optional fields and bounds must remain aligned with the
source schema and the runtime `tools/list` response.

### Workspace and filesystem

```ts
workspace_list: {}
workspace_register: {
  parentWorkspaceId: string;
  path: string;
  displayName?: string;
}
workspace_info: { workspaceId: string }
workspace_tree: {
  workspaceId?: string;
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
}
project_snapshot: { workspaceId: string }
read_file: {
  workspaceId?: string;
  path: string;
  startLine?: number;
  endLine?: number;
}
read_files: { workspaceId?: string; files: Array<{ path: string; startLine?: number; endLine?: number }> }
search_files: { workspaceId?: string; path?: string; glob?: string; maxResults?: number; includeIgnored?: boolean }
search_text: {
  workspaceId?: string;
  path?: string;
  query: string;
  glob?: string;
  maxResults?: number;
  includeIgnored?: boolean;
}
```

`write_file`, `apply_patch`, `move_file`, `copy_file`, and `delete_file` retain
their checkpoint, same-workspace, secret-policy, confirmation, and path-guard
contracts. They must not acquire implicit recursive or arbitrary-root behavior.

### Git, process, project, and Codex

```ts
git_status: { workspaceId: string }
git_diff: { workspaceId: string; path?: string; staged?: boolean; maxBytes?: number }
git_log: { workspaceId: string; maxCommits?: number; maxBytes?: number }
git: { workspaceId?: string; cwd?: string; args: string[]; timeoutSeconds?: number }
process_start: { workspaceId: string; executable: string; args: string[]; cwd?: string; timeoutMs?: number }
process_list: { workspaceId: string }
process_status: { workspaceId: string; processId: string }
process_logs: { workspaceId: string; processId: string; tailLines?: number; sinceSequence?: number }
process_stop: { workspaceId: string; processId: string }
project_dev: { workspaceId: string }
project_test: { workspaceId: string }
project_lint: { workspaceId: string }
project_typecheck: { workspaceId: string }
project_build: { workspaceId: string }
codex_status: {}
codex_run: { workspaceId: string; instruction: string }
codex_task_list: { workspaceId: string }
codex_task_status: { workspaceId: string; codexTaskId: string }
codex_task_logs: { workspaceId: string; codexTaskId: string; tailLines?: number; sinceSequence?: number }
codex_stop: { workspaceId: string; codexTaskId: string }
```

Project tools take the workspace scope and use the detected project profile;
they do not accept arbitrary shell command strings.

### Local capability and extension tools

The detailed action enums and bounds are defined in `schemas.ts` and the
capability backends. Important invariants are:

- `shell` receives an executable plus an argument array, never a composed shell
  string, and retains foreground/background, timeout, dry-run, and task actions;
- `dom_cdp`, `accessibility`, `input_event`, and `window` retain their
  interactive/destructive policy;
- `vision`, `health`, and `system_info` remain truthful read-only diagnostics;
- `web_fetch` remains HTTP(S)-only and bounded by explicit byte/timeout fields;
- `skills_*` and `mcp_*` remain full-access bridge tools and do not silently
  flatten child-server tools into the Linux tool catalog.

The Linux native observation contract adds:

```ts
vision_annotated_capture: {
  workspaceId: string;
  capture?: 'display' | 'region' | 'window';
  max_depth?: number;
  max_marks?: number;
  ttl_seconds?: number;
}
ui_target_action: {
  workspaceId: string;
  observationId: string;
  markId: string;
  observationHash?: string;
  action?: 'click' | 'focus' | 'read_value' | 'set_value' | 'select_item' | 'menu_select';
  value?: string;
  userConfirmed?: boolean;
}
```

SoM observations return `observationId`, `observationHash`, annotated PNG data,
`marks[]`, and `expiresAt`. `ui_target_action` checks owner, TTL, optional hash,
mark identity, and a fresh Accessibility lookup before forwarding an action.
Coordinates are screen-pixel metadata; action execution uses semantic element
identifiers so DPI and multi-monitor offsets do not become authorization.

`vision` uses the XDG Screenshot portal and Tesseract. Missing providers or
permission are returned as structured unavailable/consent-required results.

The router adds `tool_dynamic_filter` and extends `tool_search`/`route_intent`
with ranked candidates, deterministic scores, reason codes, selected model,
permission metadata, and `authorizationUnchanged: true`. Local rerank is
opt-in; when no local model is configured it falls back to deterministic scoring
without sending prompt or file data off-machine.

### Context aggregation

```ts
workspace_context: {
  query: string;
  workspaceId?: string;
  path?: string;
  intent?: 'auto' | 'debug' | 'implement' | 'review' | 'trace' | 'explore';
  mode?: 'optimized' | 'full' | 'exhaustive';
  includeIgnored?: boolean;
  responseTargetBytes?: number;
  pageSize?: number;
}
workspace_context_continue: { continuationToken: string; pageSize?: number }
workspace_full_scan: { workspaceId?: string; path?: string; glob?: string; pageSize?: number; includeIgnored?: boolean }
workspace_full_scan_continue: { continuationToken: string; pageSize?: number }
workspace_snapshot: { workspaceId: string }
search_all: { query: string; workspaceId?: string; path?: string; glob?: string; maxResults?: number; includeIgnored?: boolean }
read_many_files: { workspaceId?: string; files: Array<{ path: string; startLine?: number; endLine?: number }> }
```

Context pages are transport windows, not capability limits. The engine keeps
continuation state and preserves the full primitive search/read tools.

`includeIgnored` is an explicit discovery override. Automatic mode is a quota
optimization, not authorization. `context_economy_stats` reports raw versus
delivered context bytes, skipped generated/binary paths, duplicate/previously
seen bytes avoided, ledger hits, and the bounded ledger size. The ledger is
in-memory and does not persist file contents or credentials.

### Lossless file paging

```ts
read_file_page: {
  workspaceId?: string;
  path: string;
  startLine?: number;
  pageSize?: number;
  responseTargetBytes?: number;
}
read_file_page_continue: { continuationToken: string; pageSize?: number }
```

Paged responses always expose whether more content remains. The page adapter
does not replace or reduce the existing unrestricted trusted-workspace read
path.

### Full-visibility indexing

```ts
workspace_index: { workspaceId: string; rebuild?: boolean; includeIgnored?: boolean }
workspace_index_status: { workspaceId: string }
workspace_index_watch: { workspaceId: string; debounceMs?: number; concurrency?: number }
workspace_index_stop: { workspaceId: string }
```

Index scheduling uses the automatic context-economy policy for vendor/build,
binary, and generated paths. It must not be treated as an access denial:
explicit index/search requests and direct file reads can still inspect any path
allowed by the existing workspace boundary, including hidden, ignored,
generated, dependency, and environment files.

### Roadmap extension catalog

The Phase 05–41 additive tools are defined in
[`../../packages/mcp-server/src/upgrade-catalog.ts`](../../packages/mcp-server/src/upgrade-catalog.ts).
Each entry carries its phase, permission class, tags, streamability, and
parallel-safety metadata. `tool_search` and `tool_describe` expose this metadata
without replacing the full `tools/list` contract.

### Compound execution

```ts
tool_batch: {
  parallel?: boolean;
  calls?: Array<{
    id?: string;
    tool: string;
    arguments?: Record<string, unknown>;
    dependsOn?: string[];
    timeoutMs?: number;
  }>;
  groups?: Array<{
    id?: string;
    parallel?: boolean;
    calls: Array<{
      id?: string;
      tool: string;
      arguments?: Record<string, unknown>;
      dependsOn?: string[];
      timeoutMs?: number;
    }>;
  }>;
}
```

The input contains at most 50 child calls. Results retain input order and
include per-child status, duration, error, and returned MCP response. Read-only
children can run in parallel; side-effecting children are serialized by the
early compound safety guard. Nested `tool_batch` calls are rejected.

## Change protocol

Any tool contract change must include:

1. a schema/source change;
2. a registry/tool-list test asserting the tool remains discoverable;
3. permission and annotation assertions;
4. success and failure tests for the application behavior;
5. an audit/Live Logs assertion for new compound children or side effects;
6. a fresh benchmark or regression comparison when latency, bytes, or result
   shape can change;
7. an update to this file and `docs/mcp/MCP_TOOL_CATALOG.md`.

Adding a compound tool is additive. Removing or narrowing a primitive tool is a
breaking change and is outside this upgrade roadmap.
