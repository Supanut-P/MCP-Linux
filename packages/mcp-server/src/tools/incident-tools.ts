import { z } from 'zod';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const confirmation = { userConfirmed: z.boolean().optional() };
export const incidentSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('collect'), incidentId: id, workspaceId: id, hostIds: z.array(id).min(1).max(20).optional(), selectionId: id.optional(), unit: z.string().regex(/^(?!-)[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/).optional(), ...confirmation }).strict(),
  z.object({ operation: z.literal('status'), incidentId: id, ...confirmation }).strict(),
  z.object({ operation: z.literal('report'), incidentId: id, afterSequence: z.number().int().min(0).max(128).optional(), limit: z.number().int().min(1).max(32).optional(), ...confirmation }).strict(),
]);

export function incidentTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.incident;
  return service === undefined ? [] : [defineTool({
    name: 'incident',
    description: 'Collect fixed bounded read observations from registered fleet hosts and a workspace, or inspect durable status and paged evidence. Collect persists metadata under current READ/WRITE policy; repeated IDs never replay probes. Raw journal messages, paths and provider errors are omitted. Partial or missing evidence does not prove absence. No deployment or automatic resume.',
    permission: 'READ', annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: incidentSchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
