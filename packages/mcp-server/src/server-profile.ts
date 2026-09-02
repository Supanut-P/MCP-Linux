import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { McpToolDefinition } from './tools/tool-types.js';

export type ServerProfileName = 'core' | 'operator' | 'fleet' | 'full';

const CORE_TOOLS = new Set([
  'workspace_list', 'workspace_register', 'workspace_info', 'workspace_tree', 'project_snapshot',
  'read_file', 'read_files', 'write_file', 'apply_patch', 'move_file', 'copy_file', 'delete_file', 'restore_deleted_file',
  'search_files', 'search_text', 'search_all', 'read_many_files', 'read_file_page', 'read_file_page_continue',
  'git_status', 'git_diff', 'git_log', 'git',
  'process_start', 'process_list', 'process_status', 'process_logs', 'process_stop',
  'project_dev', 'project_test', 'project_lint', 'project_typecheck', 'project_build',
  'shell', 'health', 'system_info', 'runtime_metrics', 'journal', 'service_logs', 'network',
  'artifact_verify', 'http_probe', 'storage_usage',
  'workspace_context', 'workspace_context_continue', 'workspace_full_scan', 'workspace_full_scan_continue',
  'workspace_snapshot', 'workspace_index', 'workspace_index_status', 'workspace_index_watch', 'workspace_index_stop', 'workspace_changes',
  'session_handoff', 'session_context', 'session_resume', 'session_history', 'response_mode',
  'symbol_search', 'find_definition', 'find_references', 'find_implementations', 'call_hierarchy', 'import_graph',
  'dependency_graph', 'module_graph', 'type_search', 'trace_symbol', 'context_ranking', 'debug_context',
  'review_context', 'change_context', 'symbol_context', 'test_context', 'dependency_context', 'git_context',
  'frontend_context', 'backend_context', 'route_intent', 'discover_tests', 'test_failures', 'coverage_context',
  'test_history', 'dev_context', 'path_context', 'startup_context', 'mcp_health', 'mcp_resources',
  'permission_check', 'permission_profile', 'tool_schema_list', 'capabilities', 'tool_search', 'tool_describe',
  'tool_categories', 'tool_function_find', 'tool_aliases', 'recipe_list', 'recipe_describe', 'dry_run',
  'review_changes', 'changed_symbols', 'affected_modules', 'git_history_context', 'git_blame_context',
  'lsp_diagnostics', 'recipe_catalog', 'project_profile_get', 'regression_report', 'recovery_status',
  'handoff_context', 'self_heal_plan',
]);

const OPERATOR_TOOLS = new Set([
  'service', 'package', 'schedule', 'notification', 'container', 'archive', 'dependency_audit', 'backup',
  'db_inspect', 'db_query', 'target_catalog', 'support_bundle', 'service_context', 'process_context',
  'port_context', 'installed_runtime_context', 'network_context', 'startup_context', 'live_logs_query',
  'live_logs_status', 'telemetry_dashboard', 'context_economy_stats', 'execution_plan', 'repo_map',
  'context_expand', 'cache_stats', 'cache_clear', 'cache_invalidate', 'hook_list', 'skill_match', 'skill_load',
  'plugin_list', 'session_checkpoint', 'inspect_web_app', 'debug_ui', 'capture_ui_state', 'form_context',
  'console_context', 'browser_debug_context', 'capture_screenshot', 'compare_screenshot', 'dom_snapshot',
  'layout_metadata', 'visual_context', 'inspect_pdf', 'compare_pdf_pages', 'pdf_extract_tables', 'benchmark_run',
  'lsp_rename', 'self_heal_apply', 'tool_batch',
]);

const FLEET_TOOLS = new Set([
  'remote_host', 'remote_fleet', 'remote_rollout', 'remote_rollout_resume',
]);

export function parseServerProfile(value: string | null | undefined): Result<ServerProfileName> {
  if (value === undefined || value === null || value.trim().length === 0) return ok('full');
  const normalized = value.trim().toLowerCase();
  if (normalized === 'core' || normalized === 'operator' || normalized === 'fleet' || normalized === 'full') return ok(normalized);
  return err(appError('INVALID_INPUT', 'Server profile must be one of core, operator, fleet, or full', false));
}

export function serverProfileToolAllowed(name: string, profile: ServerProfileName): boolean {
  if (profile === 'full') return true;
  if (CORE_TOOLS.has(name)) return true;
  if (profile === 'operator') return OPERATOR_TOOLS.has(name);
  if (profile === 'fleet') return FLEET_TOOLS.has(name);
  return false;
}

export function filterServerProfileTools(tools: readonly McpToolDefinition[], profile: ServerProfileName): readonly McpToolDefinition[] {
  return tools.filter((tool) => serverProfileToolAllowed(tool.name, profile));
}

export const serverProfileToolSets = Object.freeze({
  core: CORE_TOOLS,
  operator: OPERATOR_TOOLS,
  fleet: FLEET_TOOLS,
});
