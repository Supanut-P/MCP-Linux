import { targetCatalogSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function targetCatalogTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.targetCatalog;
  if (service === undefined) return [];
  return [defineTool({
    name: 'target_catalog',
    description: 'List or describe explicitly registered database and SSH target aliases without exposing addresses, usernames, roots, fingerprints, secret references, or secret values.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: targetCatalogSchema,
    handler: async (input) => {
      if (input.operation === 'list') return service.list(input.kind);
      return service.describe(input.kind, input.id);
    },
  })];
}
