import { supportBundleSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function supportBundleTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.supportBundle;
  if (service === undefined) return [];
  return [defineTool({
    name: 'support_bundle',
    description: 'Create a bounded, redacted Linux support archive from registered workspace diagnostics. Start with dry_run, then confirm the matching previewHash.',
    permission: 'DANGEROUS',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: supportBundleSchema,
    handler: async (input, signal) => service.execute(input, signal),
  })];
}
