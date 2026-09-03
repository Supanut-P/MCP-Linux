import { environmentPreflightSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function environmentPreflightTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.environmentPreflight;
  if (service === undefined) return [];
  return [defineTool({
    name: 'environment_preflight',
    description: 'Read a bounded, sanitized headless runtime readiness matrix from the existing health provider. It reports platform, display server, Node runtime, consent flags, and missing dependency names only; it never returns hostnames, paths, commands, secrets, or mutation authority.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: environmentPreflightSchema,
    handler: async (_input, signal) => service.execute(signal),
  })];
}
