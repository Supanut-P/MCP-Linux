import { workflowStateSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function workflowStateTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.workflowState;
  if (service === undefined) return [];
  return [defineTool({
    name: 'workflow',
    description: 'Persist and inspect bounded owner-scoped caller-native task state. Plan/start/checkpoint/complete/cancel require current WRITE permission. Start only reserves a task; resume never dispatches or repeats execution. Completion and references are caller-reported, not verified QA. Claims do not provide file locks or an OS sandbox.',
    permission: 'READ',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: workflowStateSchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
