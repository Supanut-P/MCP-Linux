import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { DiagnosticLogger, FileActor } from '@baitonghub-linux-mcp/application';
import type { PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import { APP_NAME, APP_VERSION, type DestructiveAutoApprovalPolicy } from '@baitonghub-linux-mcp/shared';
import { readTraceContext, type ActivitySink, type ActivityTracker } from './activity-tracker.js';
import { withProgressHeartbeat, type ProgressNotifyContext } from './progress-heartbeat.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { RunBudgetGuard, type RunBudgetContext } from './run-budget.js';
import { registerTasksProtocol } from './tasks-protocol.js';
import { ToolRegistry, type ActiveProjectScope, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';
import { actorForRequestScope, type McpRequestScope } from './request-scope.js';

export interface McpServerOptions {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly requestScope?: McpRequestScope;
  readonly diagnostic?: DiagnosticLogger;
  readonly activity?: ActivitySink;
  readonly activityTracker?: ActivityTracker;
  readonly profileProvider?: () => PermissionProfile;
  readonly allowAiDeleteProvider?: () => boolean;
  readonly destructivePolicyProvider?: () => DestructiveAutoApprovalPolicy;
  readonly workspaceScopeResolver?: (workspaceId: string) => WorkspaceScope | null | Promise<WorkspaceScope | null>;
  /** @deprecated Compatibility only. Prefer workspaceScopeResolver. */
  readonly activeProjectProvider?: () => ActiveProjectScope | null;
  /** Exposes quota-consuming Codex delegation tools. Disabled unless explicitly enabled. */
  readonly codexToolsEnabled?: boolean;
  /** Shared across per-request server factories so repeated diff fingerprints can hit cache. */
  readonly incrementalVerifier?: IncrementalVerifier;
  /** Shared across per-request server factories so the run clock starts at the first tool call. */
  readonly runBudgetGuard?: RunBudgetGuard;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const actor = actorForRequestScope(options.actor, options.requestScope);
  const registry = new ToolRegistry(options.services, actor, {
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
    ...(options.activity === undefined ? {} : { activity: options.activity }),
    ...(options.activityTracker === undefined ? {} : { activityTracker: options.activityTracker }),
    ...(options.requestScope === undefined ? {} : { sessionId: options.requestScope.sessionId }),
    ...(options.profileProvider === undefined ? {} : { profileProvider: options.profileProvider }),
    ...(options.allowAiDeleteProvider === undefined ? {} : { allowAiDeleteProvider: options.allowAiDeleteProvider }),
    ...(options.destructivePolicyProvider === undefined ? {} : { destructivePolicyProvider: options.destructivePolicyProvider }),
    ...(options.workspaceScopeResolver === undefined ? {} : { workspaceScopeResolver: options.workspaceScopeResolver }),
    ...(options.activeProjectProvider === undefined ? {} : { activeProjectProvider: options.activeProjectProvider }),
    ...(options.codexToolsEnabled === undefined ? {} : { codexToolsEnabled: options.codexToolsEnabled }),
    ...(options.incrementalVerifier === undefined ? {} : { incrementalVerifier: options.incrementalVerifier }),
  });
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  // tasks capability (MCP spec 2025-11-25) exposes existing durable shell
  // background tasks via tasks/get/result/list/cancel. requests.tools.call is
  // intentionally not declared, so clients will not send task-augmented
  // tool calls.
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION }, {
    capabilities: {
      tools: {},
      tasks: { list: {}, cancel: {} },
    },
  });
  registerTasksProtocol(server, options.services, { actor });
  for (const tool of registry.list()) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }, async (input: unknown, context): Promise<CallToolResult> => {
      const dispatchContext = context as ProgressNotifyContext & RunBudgetContext;
      runBudgetGuard.begin(dispatchContext);
      const result = await withProgressHeartbeat(dispatchContext, tool.name, async () => (
        registry.invoke(tool.name, input, readTraceContext(context)) as unknown as Promise<CallToolResult>
      ));
      return runBudgetGuard.finish(dispatchContext, result);
    });
  }
  return server;
}
