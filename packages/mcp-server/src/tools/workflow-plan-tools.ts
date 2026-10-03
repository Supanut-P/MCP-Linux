import { workflowPlanSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function workflowPlanTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.workflowPlan;
  if (service === undefined) return [];
  return [defineTool({
    name: 'workflow_plan',
    description: 'Prepare a bounded task contract and role prompts for caller-native Codex subagents inside a registered workspace. Commands are reviewable data only; no execution, permissions, model validation, or durable workflow state is created.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: workflowPlanSchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
