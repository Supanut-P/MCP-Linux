import { taskHistorySchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function taskHistoryTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.taskHistory;
  if (service === undefined) return [];
  return [defineTool({
    name: 'task_history',
    description: 'Read a bounded, owner-scoped history of durable shell and remote-rollout tasks. Entries include only task identity, kind, state, timestamps, workspace hash, result code, and duration; commands, paths, output, environments, hosts, and secrets are never returned.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: taskHistorySchema,
    handler: async (input, signal) => service.execute(context.actor, {
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.workspaceHash === undefined ? {} : { workspaceHash: input.workspaceHash }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }, signal),
  })];
}
