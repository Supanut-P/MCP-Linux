import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { workspaceChangesSchema, workspaceIndexSchema, workspaceIndexStatusSchema, workspaceIndexStopSchema, workspaceIndexWatchSchema } from './schemas.js';

export function workspaceIndexTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'workspace_index',
      description: 'Build or refresh the persistent workspace index using automatic context filters unless ignored paths are explicitly included.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexSchema,
      handler: async (input) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.indexWorkspace(input.workspaceId, { discovery: input.includeIgnored ? 'explicit' : 'automatic' }),
    }),
    defineTool({
      name: 'workspace_index_status',
      description: 'Return persistent index metadata and lossless watcher queue telemetry.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexStatusSchema,
      handler: async (input) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.status(input.workspaceId),
    }),
    defineTool({
      name: 'workspace_index_watch',
      description: 'Watch all workspace paths and incrementally re-index only changed paths with configurable debounce/concurrency.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexWatchSchema,
      handler: async (input) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.startWatch(input.workspaceId, {
          ...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
          ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        }),
    }),
    defineTool({
      name: 'workspace_index_stop',
      description: 'Stop a workspace watcher after draining all queued path updates.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexStopSchema,
      handler: async (input) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.stopWatch(input.workspaceId),
    }),
    defineTool({
      name: 'workspace_changes',
      description: 'Return bounded, read-only file change events from an active workspace watcher without file contents or absolute paths.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceChangesSchema,
      handler: async (input) => {
        if (context.services.workspaceChanges === undefined) return missingService();
        return input.operation === 'snapshot'
          ? context.services.workspaceChanges.snapshot(input.workspaceId, input.maxEvents)
          : context.services.workspaceChanges.diff(input.workspaceId, input.afterSequence, input.maxEvents);
      },
    }),
  ];
}
