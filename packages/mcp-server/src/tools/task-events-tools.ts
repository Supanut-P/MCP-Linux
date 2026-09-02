import { taskEventsSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function taskEventsTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.taskEvents;
  if (service === undefined) return [];
  return [defineTool({
    name: 'task_events',
    description: 'Read a bounded, reconnect-safe lifecycle stream for an owned durable task. Events contain only state, timestamps, phases, attempts, and sanitized result codes; command lines, paths, output, environments, and secrets are never returned.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: taskEventsSchema,
    handler: async (input, signal) => service.execute(context.actor, {
      taskId: input.taskId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
    }, signal),
  })];
}
