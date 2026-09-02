import path from 'node:path';
import { appError } from '@baitonghub-linux-mcp/domain';
import { sanitizeException, type DiagnosticLogger, type FileActor } from '@baitonghub-linux-mcp/application';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, type DestructiveAutoApprovalPolicy } from '@baitonghub-linux-mcp/shared';
import { ActivityTracker, summarizeToolTarget, type ActivitySink, type TraceContext } from './activity-tracker.js';
import { createApprovalReceipt, type ApprovalReceipt } from './approval-receipt.js';
import { ContextEngine } from './context-engine.js';
import { ContextEconomyRuntime } from './context-economy.js';
import { hasExplicitUserConfirmation, inspectDestructiveOperation } from './destructive-policy.js';
import { isScopedAutoApprovalAllowed, type WorkspaceScope } from './destructive-scope.js';
import { FilePageEngine } from './file-page-engine.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { mapError, mapResult, type McpToolResponse } from './result-mapper.js';
import { batchTools } from './tools/batch-tools.js';
import { contextTools } from './tools/context-tools.js';
import { filePageTools } from './tools/file-page-tools.js';
import { workspaceIndexTools } from './tools/workspace-index-tools.js';
import { upgradeTools } from './tools/upgrade-tools.js';
import { ToolSchemaRegistry } from './tool-schema-registry.js';
import { codexTools } from './tools/codex-tools.js';
import { capabilityTools } from './tools/capability-tools.js';
import { databaseTools } from './tools/database-tools.js';
import { fileTools } from './tools/file-tools.js';
import { gitTools } from './tools/git-tools.js';
import { mcpBridgeTools } from './tools/mcp-bridge-tools.js';
import { processTools } from './tools/process-tools.js';
import { sessionTools } from './tools/session-tools.js';
import { searchTools } from './tools/search-tools.js';
import { targetCatalogTools } from './tools/target-catalog-tools.js';
import { supportBundleTools } from './tools/support-bundle-tools.js';
import { auditTools } from './tools/audit-tools.js';
import { taskEventsTools } from './tools/task-events-tools.js';
import { taskHistoryTools } from './tools/task-history-tools.js';
import { diagnosticsSnapshotTools } from './tools/diagnostics-snapshot-tools.js';
import { remoteFleetDiffTools } from './tools/remote-fleet-diff-tools.js';
import { releaseVerifyTools } from './tools/release-verify-tools.js';
import { environmentPreflightTools } from './tools/environment-preflight-tools.js';
import { policyExplainTools } from './tools/policy-explain-tools.js';
import { skillTools } from './tools/skill-tools.js';
import { workspaceTools } from './tools/workspace-tools.js';
import type { McpApplicationServices, McpToolContext, McpToolDefinition } from './tools/tool-types.js';
import { filterServerProfileTools, type ServerProfileName } from './server-profile.js';

export type { McpApplicationServices } from './tools/tool-types.js';
export type { ActiveProjectScope, WorkspaceScope } from './destructive-scope.js';

export interface ToolRegistryOptions {
  readonly diagnostic?: DiagnosticLogger;
  readonly activity?: ActivitySink;
  readonly activityTracker?: ActivityTracker;
  readonly sessionId?: string;
  readonly profileProvider?: () => PermissionProfile;
  /** Explicit server surface profile; this filters advertisement and dispatch only. */
  readonly serverProfileProvider?: () => ServerProfileName;
  /** Legacy compatibility. New callers should supply destructivePolicyProvider. */
  readonly allowAiDeleteProvider?: () => boolean;
  /** Fine-grained local destructive auto-approval policy. */
  readonly destructivePolicyProvider?: () => DestructiveAutoApprovalPolicy;
  /** Resolves the registered workspace boundary for the workspaceId carried by this invocation. */
  readonly workspaceScopeResolver?: (workspaceId: string) => WorkspaceScope | null | Promise<WorkspaceScope | null>;
  /** @deprecated Compatibility only. New callers must use request-scoped workspace resolution. */
  readonly activeProjectProvider?: () => WorkspaceScope | null;
  /** Exposes quota-consuming Codex delegation tools. Disabled unless explicitly enabled. */
  readonly codexToolsEnabled?: boolean;
  readonly incrementalVerifier?: IncrementalVerifier;
  readonly maxToolDurationMs?: number;
}

const DEFAULT_MCP_TOOL_RESPONSE_BUDGET_MS: number | null = null;

interface BudgetedToolExecution {
  readonly response: McpToolResponse;
  readonly deferredSettlement?: Promise<void>;
}

export class ToolRegistry {
  private readonly tools: readonly McpToolDefinition[];
  private readonly diagnostic: DiagnosticLogger | undefined;
  private readonly activity: ActivityTracker;
  private readonly schemaRegistry: ToolSchemaRegistry;
  private readonly sessionId: string | undefined;
  private readonly permissionEngine = new DefaultPermissionEngine();
  private readonly profileProvider: () => PermissionProfile;
  private readonly serverProfileProvider: () => ServerProfileName;
  private readonly destructivePolicyProvider: () => DestructiveAutoApprovalPolicy;
  private readonly workspaceScopeResolver: (workspaceId: string) => Promise<WorkspaceScope | null>;
  private readonly activityWorkspaceResolver: (cwd: string) => Promise<string | undefined>;
  private readonly shellTaskWorkspaces = new Map<string, string>();
  private readonly maxToolDurationMs: number | null;
  private readonly actorId: string;

  public constructor(services: McpApplicationServices, actor: FileActor, options: ToolRegistryOptions = {}) {
    this.actorId = actor.clientId;
    this.diagnostic = options.diagnostic;
    this.activity = options.activityTracker ?? new ActivityTracker(options.activity);
    this.sessionId = options.sessionId;
    this.profileProvider = options.profileProvider ?? ((): PermissionProfile => permissionProfiles.full);
    this.serverProfileProvider = options.serverProfileProvider ?? ((): ServerProfileName => 'full');
    this.destructivePolicyProvider = options.destructivePolicyProvider ?? ((): DestructiveAutoApprovalPolicy => legacyDeletePolicy(options.allowAiDeleteProvider?.() === true));
    this.workspaceScopeResolver = normalizeWorkspaceScopeResolver(services, actor, options);
    this.activityWorkspaceResolver = normalizeActivityWorkspaceResolver(services, actor);
    this.maxToolDurationMs = normalizeToolResponseBudget(options.maxToolDurationMs);
    const contextEconomy = new ContextEconomyRuntime();
    const serverProfile = this.serverProfileProvider();
    const context: McpToolContext = { services, actor, contextEconomy, activity: this.activity, serverProfile };
    const contextEngine = new ContextEngine(services, actor, contextEconomy);
    const filePageEngine = new FilePageEngine(services, actor);
    const incrementalVerifier = options.incrementalVerifier ?? new IncrementalVerifier();
    const workspace = workspaceTools(context);
    const files = fileTools(context);
    const baseTools: readonly McpToolDefinition[] = [
      ...workspace,
      ...files.slice(0, 2),
      ...searchTools(context),
      ...gitTools(context),
      ...files.slice(2),
      ...processTools(context),
      ...(options.codexToolsEnabled === true ? codexTools(context) : []),
      ...advertisedCapabilityTools(context),
      ...auditTools(context),
      ...taskEventsTools(context),
      ...taskHistoryTools(context),
      ...diagnosticsSnapshotTools(context),
      ...remoteFleetDiffTools(context),
      ...releaseVerifyTools(context),
      ...environmentPreflightTools(context),
      ...databaseTools(context),
      ...targetCatalogTools(context),
      ...supportBundleTools(context),
      ...skillTools(context),
      ...mcpBridgeTools(context),
      ...contextTools(context, contextEngine),
      ...filePageTools(filePageEngine),
      ...workspaceIndexTools(context),
      ...sessionTools(context, incrementalVerifier),
      ...upgradeTools(context),
    ];
    const visibleBaseTools = filterServerProfileTools(baseTools, serverProfile);
    const policyTools = filterServerProfileTools(policyExplainTools(context, () => this.tools, this.profileProvider), serverProfile);
    const visibleNames = new Set([...visibleBaseTools, ...policyTools].map((tool) => tool.name));
    const visibleBatchTools = filterServerProfileTools(batchTools({
      invoke: (name, input, signal) => this.invoke(name, input, undefined, signal),
      describe: (name) => visibleBaseTools.find((tool) => tool.name === name),
    }), serverProfile).filter((tool) => visibleNames.has(tool.name) || tool.name === 'tool_batch');
    this.tools = [...visibleBaseTools, ...policyTools, ...visibleBatchTools];
    this.schemaRegistry = new ToolSchemaRegistry();
    for (const tool of this.tools) this.schemaRegistry.register(tool);
  }

  public list(): readonly McpToolDefinition[] {
    return this.tools;
  }

  public listInFlight(): ReturnType<ActivityTracker['listInFlight']> {
    return this.activity.listInFlight();
  }

  public listSchemas(): ReturnType<ToolSchemaRegistry['list']> {
    return this.schemaRegistry.list();
  }

  public describeSchema(name: string): ReturnType<ToolSchemaRegistry['describe']> {
    return this.schemaRegistry.describe(name);
  }

  public async invoke(name: string, input: unknown, traceContext?: TraceContext, parentSignal?: AbortSignal): Promise<McpToolResponse> {
    const activityWorkspaceId = await this.resolveActivityWorkspaceId(name, input);
    const activityInput = withActivityWorkspaceId(input, activityWorkspaceId);
    const callId = await this.activity.begin(name, activityInput, { ...(traceContext ?? {}), ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }) });
    const started = Date.now();
    try {
      const tool = this.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        const response = mapError(appError('INVALID_INPUT', 'Unknown MCP tool'));
        await this.activity.end(callId, 'INVALID_INPUT', Date.now() - started, 'Unknown MCP tool');
        return response;
      }
      const parsed = tool.parse(input);
      if (!parsed.ok) {
        const response = mapError(parsed.error);
        await this.activity.end(callId, parsed.error.code, Date.now() - started, parsed.error.message);
        return response;
      }
      const destructiveDecision = inspectDestructiveOperation(tool.name, parsed.value);
      const dangerousCall = tool.permission === 'DANGEROUS' || destructiveDecision.destructive;
      const policy = this.destructivePolicyProvider();
      const destructiveWorkspaceId = readExplicitWorkspaceId(parsed.value);
      const workspaceScope = destructiveDecision.destructive && destructiveWorkspaceId !== undefined
        ? await this.resolveWorkspaceScope(destructiveWorkspaceId)
        : null;
      const policyAllowsScopedDestructive = destructiveDecision.destructive
        && destructiveWorkspaceId !== undefined
        && isScopedAutoApprovalAllowed(tool.name, parsed.value, destructiveDecision, policy, workspaceScope);
      if (destructiveDecision.destructive && !hasExplicitUserConfirmation(parsed.value) && !policyAllowsScopedDestructive) {
        const message = `Destructive operation requires explicit user confirmation${destructiveDecision.reason === undefined ? '' : `: ${destructiveDecision.reason}`}. Ask the user in chat first, then retry with userConfirmed: true`;
        const response = mapError(appError('PERMISSION_REQUIRED', message, true));
        const receipt = dangerousCall ? this.approvalReceipt(tool.name, parsed.value, 'CONFIRMATION_REQUIRED') : undefined;
        await this.activity.end(callId, 'PERMISSION_REQUIRED', Date.now() - started, message, receipt === undefined ? undefined : { approvalReceipt: receipt });
        return response;
      }
      const permissionDecision = this.permissionEngine.decide(this.profileProvider(), {
        action: 'mcp:' + tool.name,
        level: policyAllowsScopedDestructive ? 'WRITE' : tool.permission,
        workspaceId: readWorkspaceId(parsed.value),
        target: tool.name,
        destructive: tool.annotations.destructiveHint,
      });
      if (permissionDecision !== 'ALLOW') {
        const code = permissionDecision === 'DENY' ? 'PERMISSION_DENIED' : 'PERMISSION_REQUIRED';
        const message = permissionDecision === 'DENY'
          ? 'MCP tool ' + tool.name + ' is denied by the active permission profile'
          : 'MCP tool ' + tool.name + ' requires permission approval';
        const response = mapError(appError(code, message, permissionDecision === 'ASK'));
        const receipt = dangerousCall ? this.approvalReceipt(tool.name, parsed.value, permissionDecision) : undefined;
        await this.activity.end(callId, code, Date.now() - started, message, receipt === undefined ? undefined : { approvalReceipt: receipt });
        return response;
      }
      const approvalReceipt = dangerousCall
        ? this.approvalReceipt(tool.name, parsed.value, policyAllowsScopedDestructive ? 'AUTO_ALLOW' : 'ALLOW', hasExplicitUserConfirmation(parsed.value) || policyAllowsScopedDestructive)
        : undefined;
      const confirmedInput = policyAllowsScopedDestructive ? withInternalUserConfirmation(parsed.value) : parsed.value;
      const executionInput = approvalReceipt === undefined || tool.name !== 'support_bundle'
        ? confirmedInput
        : withInternalApprovalReceipt(confirmedInput, approvalReceipt.id);
      const execution = await this.executeWithinResponseBudget(tool, executionInput, parentSignal);
      const response = execution.response;
      this.rememberShellTaskWorkspace(name, response, activityWorkspaceId);
      const resultCode = response.isError === true
        ? readErrorCode(response) ?? 'ERROR'
        : 'SUCCESS';
      const resultMessage = readErrorMessage(response);
      if (execution.deferredSettlement !== undefined) {
        void execution.deferredSettlement.then(() => this.activity.end(
          callId,
          resultCode,
          Date.now() - started,
          resultMessage,
          approvalReceipt === undefined ? undefined : { approvalReceipt },
        ));
      } else {
        await this.activity.end(callId, resultCode, Date.now() - started, resultMessage, approvalReceipt === undefined ? undefined : { approvalReceipt });
      }
      return response;
    } catch (error: unknown) {
      const response = mapError(sanitizeException(error, this.diagnostic));
      await this.activity.end(callId, 'INTERNAL_ERROR', Date.now() - started, 'Operation failed');
      return response;
    }
  }

  private async resolveActivityWorkspaceId(name: string, input: unknown): Promise<string | undefined> {
    const explicitWorkspaceId = readExplicitWorkspaceId(input);
    if (explicitWorkspaceId !== undefined) return explicitWorkspaceId;
    if (name !== 'shell' || !isRecord(input)) return undefined;
    const taskId = readTrimmedString(input.task_id);
    if (taskId !== undefined) {
      const remembered = this.shellTaskWorkspaces.get(taskId);
      if (remembered !== undefined) return remembered;
    }
    const cwd = readTrimmedString(input.cwd);
    return cwd === undefined ? undefined : this.activityWorkspaceResolver(cwd);
  }

  private rememberShellTaskWorkspace(name: string, response: McpToolResponse, workspaceId: string | undefined): void {
    if (name !== 'shell' || workspaceId === undefined || response.isError === true) return;
    const taskId = readTrimmedString(response.structuredContent?.task_id);
    if (taskId !== undefined) this.shellTaskWorkspaces.set(taskId, workspaceId);
  }

  private async resolveWorkspaceScope(workspaceId: string): Promise<WorkspaceScope | null> {
    try {
      return await this.workspaceScopeResolver(workspaceId);
    } catch {
      // Scope lookup failures must fail closed to normal confirmation, not widen authorization.
      return null;
    }
  }

  private approvalReceipt(toolName: string, input: unknown, decision: string, confirmed = false): ApprovalReceipt {
    const profile = this.profileProvider();
    const workspaceId = readWorkspaceId(input);
    const targetSummary = summarizeToolTarget(toolName, input);
    const previewHash = readPreviewHash(input);
    return createApprovalReceipt({
      toolName,
      actorId: this.actorId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(targetSummary === undefined ? {} : { targetSummary }),
      ...(previewHash === undefined ? {} : { previewHash }),
      profile: profile.name,
      decision,
      ...(confirmed ? { confirmedAt: new Date().toISOString() } : {}),
    });
  }

  private async executeWithinResponseBudget(tool: McpToolDefinition, input: unknown, parentSignal?: AbortSignal): Promise<BudgetedToolExecution> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let deadlineExceeded = false;
    let onParentAbort: (() => void) | undefined;
    let operation: Promise<McpToolResponse> | undefined;
    try {
      const response = await new Promise<McpToolResponse>((resolve, reject) => {
        const finish = (response: McpToolResponse): void => {
          if (settled) return;
          settled = true;
          resolve(response);
        };
        onParentAbort = (): void => {
          deadlineExceeded = true;
          controller.abort();
          finish(mapError(appError(
            'PROCESS_TIMEOUT',
            `MCP tool ${tool.name} was cancelled because its parent request ended; cancellation was requested, but an underlying operation may still be finishing. Check task/process status before retrying.`,
            true,
          )));
        };
        if (parentSignal?.aborted) {
          onParentAbort();
          return;
        }
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });
        const responseBudgetMs = this.maxToolDurationMs;
        if (responseBudgetMs !== null) {
          timer = setTimeout(() => {
            deadlineExceeded = true;
            controller.abort();
            finish(mapError(appError(
              'PROCESS_TIMEOUT',
              `MCP tool ${tool.name} exceeded the ${Math.ceil(responseBudgetMs / 1000)}s response budget; cancellation was requested, but an underlying operation may still be finishing. Check task/process status before retrying.`,
              true,
            )));
          }, responseBudgetMs);
        }
        operation = tool.execute(input, controller.signal).then(mapResult);
        void operation.then(
          finish,
          reject,
        );
      });
      return {
        response,
        ...(deadlineExceeded && operation !== undefined
          ? { deferredSettlement: operation.then(() => undefined, () => undefined) }
          : {}),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onParentAbort !== undefined) parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }
}

function advertisedCapabilityTools(context: McpToolContext): readonly McpToolDefinition[] {
  const definitions = capabilityTools(context);
  const advertised = context.services.capabilities?.listTools?.();
  if (advertised === undefined) return definitions.filter((tool) => (tool.name !== 'remote_rollout' || context.services.remoteRollout !== undefined) && (tool.name !== 'remote_rollout_resume' || context.services.remoteRolloutResume !== undefined));
  const allowed = new Set<string>(advertised);
  return definitions.filter((tool) => {
    if (tool.name === 'runtime_metrics') return true;
    if (tool.name === 'remote_fleet') return allowed.has('remote_host');
    if (tool.name === 'remote_rollout') return allowed.has('remote_host') && context.services.remoteRollout !== undefined;
    if (tool.name === 'remote_rollout_resume') return allowed.has('remote_host') && context.services.remoteRolloutResume !== undefined;
    if (tool.name === 'vision_annotated_capture') return allowed.has('vision');
    if (tool.name === 'ui_target_action') return allowed.has('input_event') && allowed.has('accessibility');
    return allowed.has(tool.name);
  });
}

function withInternalUserConfirmation(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  return { ...(input as Record<string, unknown>), userConfirmed: true };
}

function withInternalApprovalReceipt(input: unknown, receiptId: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  return { ...(input as Record<string, unknown>), _approvalReceiptId: receiptId };
}

function readPreviewHash(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input.previewHash ?? input.preview_hash;
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function legacyDeletePolicy(enabled: boolean): DestructiveAutoApprovalPolicy {
  if (!enabled) return DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY;
  return {
    ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
    approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, delete_file: true },
  };
}

function normalizeToolResponseBudget(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MCP_TOOL_RESPONSE_BUDGET_MS;
}

function normalizeActivityWorkspaceResolver(
  services: McpApplicationServices,
  actor: FileActor,
): (cwd: string) => Promise<string | undefined> {
  return async (cwd: string): Promise<string | undefined> => {
    const infoPort = services.workspaceInfo;
    if (infoPort?.list === undefined || !isAbsoluteActivityPath(cwd)) return undefined;
    try {
      const listed = await infoPort.list(actor);
      if (!listed.ok || !Array.isArray(listed.value)) return undefined;
      let best: { readonly workspaceId: string; readonly score: number } | undefined;
      for (const entry of listed.value) {
        if (!isRecord(entry)) continue;
        const workspaceId = readTrimmedString(entry.id);
        if (workspaceId === undefined) continue;
        const roots = [readTrimmedString(entry.realRootPath), readTrimmedString(entry.rootPath)].filter((value): value is string => value !== undefined);
        for (const root of roots) {
          if (!activityPathContains(root, cwd)) continue;
          const score = normalizedActivityPath(root).length;
          if (best === undefined || score > best.score) best = { workspaceId, score };
        }
      }
      return best?.workspaceId;
    } catch {
      return undefined;
    }
  };
}

function withActivityWorkspaceId(input: unknown, workspaceId: string | undefined): unknown {
  if (workspaceId === undefined || !isRecord(input) || readExplicitWorkspaceId(input) !== undefined) return input;
  return { ...input, workspaceId };
}

function isAbsoluteActivityPath(value: string): boolean {
  return path.isAbsolute(value);
}

function activityPathContains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedActivityPath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '');
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type WorkspaceScopeResolverOptions = Pick<ToolRegistryOptions, 'workspaceScopeResolver' | 'activeProjectProvider'>;

function normalizeWorkspaceScopeResolver(
  services: McpApplicationServices,
  actor: FileActor,
  options: WorkspaceScopeResolverOptions,
): (workspaceId: string) => Promise<WorkspaceScope | null> {
  if (options.workspaceScopeResolver !== undefined) {
    return async (workspaceId: string): Promise<WorkspaceScope | null> => options.workspaceScopeResolver!(workspaceId);
  }
  if (options.activeProjectProvider !== undefined) {
    return async (workspaceId: string): Promise<WorkspaceScope | null> => {
      const scope = options.activeProjectProvider!();
      return scope !== null && scope.workspaceId === workspaceId ? scope : null;
    };
  }
  return async (workspaceId: string): Promise<WorkspaceScope | null> => {
    const infoPort = services.workspaceInfo;
    if (infoPort === undefined) return null;
    const result = await infoPort.info(actor, workspaceId);
    if (!result.ok || typeof result.value !== 'object' || result.value === null || Array.isArray(result.value)) return null;
    const info = result.value as Record<string, unknown>;
    if (info.id !== workspaceId) return null;
    const realRootPath = typeof info.realRootPath === 'string' && info.realRootPath.trim().length > 0 ? info.realRootPath : undefined;
    const rootPath = realRootPath ?? (typeof info.rootPath === 'string' && info.rootPath.trim().length > 0 ? info.rootPath : undefined);
    return rootPath === undefined ? null : { workspaceId, rootPath };
  };
}

function readExplicitWorkspaceId(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('workspaceId' in input)) return undefined;
  const value = (input as { workspaceId?: unknown }).workspaceId;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
function readWorkspaceId(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'workspaceId' in input) {
    const value = (input as { workspaceId?: unknown }).workspaceId;
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return 'system';
}

function readErrorCode(response: McpToolResponse): string | undefined {
  return readErrorField(response, 'code');
}

function readErrorMessage(response: McpToolResponse): string | undefined {
  return readErrorField(response, 'message');
}

function readErrorField(response: McpToolResponse, field: 'code' | 'message'): string | undefined {
  const content = response.structuredContent;
  if (typeof content !== 'object' || content === null || !('error' in content)) return undefined;
  const error = (content as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}
