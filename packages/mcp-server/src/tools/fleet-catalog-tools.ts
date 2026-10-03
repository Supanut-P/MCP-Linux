import { z } from 'zod';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const confirmation = { userConfirmed: z.boolean().optional() };
export const fleetCatalogSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list'), ...confirmation }).strict(),
  z.object({ operation: z.literal('resolve'), id, ...confirmation }).strict(),
  z.object({ operation: z.literal('remove'), id, expectedRevision: revision, ...confirmation }).strict(),
  z.object({ operation: z.literal('put_group'), id, expectedRevision: revision, hostIds: z.array(id).min(1).max(20), ...confirmation }).strict(),
  z.object({ operation: z.literal('put_mapping'), id, expectedRevision: revision, hostId: id, workspaceId: id, serviceUnit: z.string().regex(/^[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/), ...confirmation }).strict(),
]);

export function fleetCatalogTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.fleetCatalog;
  if (service === undefined) return [];
  return [defineTool({
    name: 'fleet_catalog',
    description: 'Store owner-scoped fleet groups and service-to-workspace mappings using registered IDs only. Reads return bounded metadata; local mutations require current WRITE policy. Resolve detects missing or changed registrations and withholds usable mappings. No SSH, file access or dispatch occurs. Metadata ownership does not provide host tenancy or execution authority.',
    permission: 'READ', annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: fleetCatalogSchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
