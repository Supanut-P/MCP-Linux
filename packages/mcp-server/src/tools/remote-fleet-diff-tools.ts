import { remoteFleetDiffSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function remoteFleetDiffTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.remoteFleetDiff;
  if (service === undefined) return [];
  return [defineTool({
    name: 'remote_fleet_diff',
    description: 'Compare a prior bounded remote_fleet snapshot with a fresh read-only snapshot for registered hosts. Returns only changed sections and sanitized status; it accepts no hostname, command, credential, or mutation input.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: remoteFleetDiffSchema,
    handler: async (input, signal) => service.execute(input, signal),
  })];
}
