import { workflowStateSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function workflowStateTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.workflowState;
  if (service === undefined) return [];
  return [defineTool({
    name: 'workflow',
    description: 'Persist bounded owner-scoped caller-native task state. Mutations require current WRITE permission. Start reserves coordinated workspace/file scope with a fenced lease and source baseline; resume never dispatches. Handoff checks bounded nonignored source deltas. Expired or terminal leases quarantine scope until explicit owner reconcile with writerStopped/userConfirmed. QA references and writer termination remain caller-attested. Coordination is not an OS sandbox.',
    permission: 'READ',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: workflowStateSchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
