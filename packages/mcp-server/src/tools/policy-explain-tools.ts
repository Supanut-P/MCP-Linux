import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityToolName } from '@baitonghub-linux-mcp/capabilities';
import { DefaultPermissionEngine, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import { inspectDestructiveOperation } from '../destructive-policy.js';
import { serverProfileToolAllowed, type ServerProfileName } from '../server-profile.js';
import { policyExplainSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export interface PolicyExplainOutput {
  readonly tool: string;
  readonly allowed: boolean;
  readonly available: boolean;
  readonly reasonCode: 'OK' | 'TOOL_NOT_AVAILABLE' | 'PROFILE_REQUIRES_APPROVAL' | 'PROFILE_DENIES' | 'CONFIRMATION_REQUIRED' | 'CAPABILITY_UNAVAILABLE' | 'REGISTERED_ROOT_REQUIRED';
  readonly profile: PermissionProfile['name'];
  readonly serverProfile: ServerProfileName;
  readonly permission: McpToolDefinition['permission'];
  readonly requiredProfile: PermissionProfile['name'];
  readonly requiresConsent: boolean;
  readonly missingDependencies: readonly string[];
  readonly registeredRootRequired: boolean;
}

const CAPABILITY_NAMES = new Set<CapabilityToolName>([
  'shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window', 'health', 'system_info',
  'journal', 'service_logs', 'network', 'service', 'package', 'schedule', 'notification', 'file_dialog',
  'clipboard', 'web_fetch', 'container', 'archive', 'dependency_audit', 'remote_host', 'artifact_verify',
  'http_probe', 'storage_usage', 'backup',
]);

const REGISTERED_ROOT_TOOLS = new Set([
  'read_file', 'read_files', 'write_file', 'apply_patch', 'move_file', 'copy_file', 'delete_file',
  'restore_deleted_file', 'search_files', 'search_text', 'search_all', 'read_many_files', 'workspace_tree',
  'workspace_context', 'workspace_full_scan', 'workspace_snapshot', 'workspace_index', 'workspace_changes',
  'git_status', 'git_diff', 'git_log', 'git', 'shell', 'process_start', 'process_list', 'process_status',
  'process_logs', 'process_stop', 'project_dev', 'project_test', 'project_lint', 'project_typecheck', 'project_build',
]);

export function policyExplainTools(
  context: McpToolContext,
  visibleTools: () => readonly McpToolDefinition[],
  profileProvider: () => PermissionProfile,
): McpToolDefinition[] {
  return [defineTool({
    name: 'policy_explain',
    description: 'Read-only explanation of whether one currently visible MCP tool is available under the active server and permission profiles. It is advisory only and never executes, authorizes, or reveals hidden tools, filesystem topology, dependencies, or secrets.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: policyExplainSchema,
    handler: async (input): Promise<Result<PolicyExplainOutput>> => {
      const profile = profileProvider();
      const serverProfile = context.serverProfile ?? 'full';
      const tool = visibleTools().find((candidate) => candidate.name === input.tool);
      if (tool === undefined || !serverProfileToolAllowed(input.tool, serverProfile)) {
        // Keep the response useful without exposing the shape of hidden tools.
        // A caller only learns that the exact name is not currently available.
        return ok({
          tool: input.tool,
          allowed: false,
          available: false,
          reasonCode: 'TOOL_NOT_AVAILABLE',
          profile: profile.name,
          serverProfile,
          permission: 'READ',
          requiredProfile: 'safe',
          requiresConsent: false,
          missingDependencies: [],
          registeredRootRequired: false,
        });
      }
      const capability = capabilityName(input.tool);
      const advertised = context.services.capabilities?.listTools?.();
      const missingDependencies = capability !== undefined && advertised !== undefined && !advertised.includes(capability)
        ? ['capability-registration']
        : context.services.capabilities === undefined && capability !== undefined
          ? ['capability-service']
          : [];
      const available = missingDependencies.length === 0;
      const registeredRootRequired = REGISTERED_ROOT_TOOLS.has(input.tool);
      const rootMissing = registeredRootRequired && input.workspaceId === undefined;
      // Inspect the same complete request shape dispatch would see so shell,
      // Git, browser, and other operation-specific destructive checks remain
      // truthful. policy_explain never executes this request.
      const destructive = inspectDestructiveOperation(input.tool, input).destructive;
      const requiredProfile = minimumProfile(tool.permission);
      const permissionDecision = new DefaultPermissionEngine().decide(profile, {
        action: `mcp:${input.tool}`,
        level: tool.permission,
        workspaceId: input.workspaceId ?? 'system',
        target: input.tool,
        destructive: tool.annotations.destructiveHint,
      });
      const requiresConsent = destructive;
      const reasonCode = !available
        ? 'CAPABILITY_UNAVAILABLE'
        : rootMissing
          ? 'REGISTERED_ROOT_REQUIRED'
          : permissionDecision === 'DENY'
            ? 'PROFILE_DENIES'
            : permissionDecision === 'ASK'
              ? 'PROFILE_REQUIRES_APPROVAL'
              : requiresConsent
                ? 'CONFIRMATION_REQUIRED'
                : 'OK';
      return ok({
        tool: input.tool,
        allowed: available && !rootMissing && permissionDecision === 'ALLOW' && !requiresConsent,
        available,
        reasonCode,
        profile: profile.name,
        serverProfile,
        permission: tool.permission,
        requiredProfile,
        requiresConsent,
        missingDependencies,
        registeredRootRequired,
      });
    },
  })];
}

function capabilityName(tool: string): CapabilityToolName | undefined {
  if (CAPABILITY_NAMES.has(tool as CapabilityToolName)) return tool as CapabilityToolName;
  if (tool === 'remote_fleet' || tool === 'remote_rollout' || tool === 'remote_rollout_resume') return 'remote_host';
  return undefined;
}

function minimumProfile(permission: McpToolDefinition['permission']): PermissionProfile['name'] {
  if (permission === 'READ') return 'safe';
  if (permission === 'WRITE' || permission === 'EXECUTE') return 'balanced';
  return 'full';
}
