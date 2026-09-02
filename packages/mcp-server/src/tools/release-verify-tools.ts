import { releaseVerifySchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function releaseVerifyTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.releaseVerify;
  if (service === undefined) return [];
  return [defineTool({
    name: 'release_verify',
    description: 'Verify local Linux release provenance, SHA-256 checksums, metadata, and optional CycloneDX SBOM inside a registered workspace. Offline and read-only: it never downloads, installs, executes, or mutates anything.',
    permission: 'READ',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: releaseVerifySchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
