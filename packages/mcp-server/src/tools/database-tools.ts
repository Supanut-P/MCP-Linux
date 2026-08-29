import { databaseInspectSchema, databaseQuerySchema } from './schemas.js';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function databaseTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'db_inspect',
      description: 'Inspect a registered SQLite, PostgreSQL, or MySQL target through a read-only bounded connection.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: databaseInspectSchema,
      handler: async (input) => context.services.database?.inspect(input) ?? missingService(),
    }),
    defineTool({
      name: 'db_query',
      description: 'Run one read-only SQL statement against a registered database target, bounded to 1000 rows and 2 MiB.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: databaseQuerySchema,
      handler: async (input) => context.services.database?.query(input) ?? missingService(),
    }),
  ];
}
