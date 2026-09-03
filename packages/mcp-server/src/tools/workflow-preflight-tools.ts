import { workflowPreflightSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function workflowPreflightTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.workflowPreflight;
  if (service === undefined) return [];
  return [defineTool({
    name: 'workflow_preflight',
    description: 'Read-only readiness check for a headless workflow. It composes sanitized runtime, diagnostics, and optional registered-workspace usage signals; it is advisory only and never authorizes, executes, or writes work.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: workflowPreflightSchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
