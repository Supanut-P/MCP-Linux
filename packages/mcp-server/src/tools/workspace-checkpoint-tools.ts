import { workspaceCheckpointSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function workspaceCheckpointTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.workspaceCheckpoint;
  if (service === undefined) return [];
  return [defineTool({
    name: 'workspace_checkpoint',
    description: 'Create, list, inspect, or delete an owner-isolated workspace manifest checkpoint. Only bounded relative paths and file metadata are stored; file contents, commands, secrets, and absolute paths are never persisted.',
    permission: 'WRITE',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: workspaceCheckpointSchema,
    handler: async (input, signal) => service.execute(context.actor, {
      ...(input.operation === undefined ? {} : { operation: input.operation }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.maxEntries === undefined ? {} : { maxEntries: input.maxEntries }),
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }, signal),
  })];
}
