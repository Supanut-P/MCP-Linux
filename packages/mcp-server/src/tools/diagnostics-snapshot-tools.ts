import { diagnosticsSnapshotSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function diagnosticsSnapshotTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.diagnosticsSnapshot;
  if (service === undefined) return [];
  return [defineTool({
    name: 'diagnostics_snapshot',
    description: 'Read one deterministic, bounded incident snapshot containing redacted health, runtime pressure, audit count, and dependency readiness. It never returns paths, commands, topology, credentials, or provider stderr.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: diagnosticsSnapshotSchema,
    handler: async (_input, signal) => service.execute(context.actor, signal),
  })];
}
