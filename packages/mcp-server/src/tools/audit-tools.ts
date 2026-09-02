import { auditQuerySchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function auditTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.auditQuery;
  if (service === undefined) return [];
  return [defineTool({
    name: 'audit_query',
    description: 'Read bounded, redacted summaries of this MCP session activity. Results are cursor-based and never include command lines, paths, environments, secrets, client identity, or provider stderr.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: auditQuerySchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
