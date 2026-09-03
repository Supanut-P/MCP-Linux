import { z } from 'zod';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { UPGRADE_TOOL_CATALOG } from '../upgrade-catalog.js';
import { UpgradeRuntimeService } from '../upgrade-runtime.js';

const upgradeInputSchema = z.object({}).passthrough();

/**
 * The roadmap tools share one deterministic runtime boundary. Their schemas
 * intentionally allow forward-compatible fields; tool-specific descriptors
 * are discoverable through tool_describe instead of being forced into every
 * client's initial context window.
 */
export function upgradeTools(context: McpToolContext): McpToolDefinition[] {
  const runtime = new UpgradeRuntimeService(context.services, context.actor, context.contextEconomy);
  // These entries have concrete runtimes registered beside the upgrade catalog.
  // Keep their catalog metadata for discovery, but do not register a second
  // MCP handler under the same name.
  const concrete = new Set(['db_inspect', 'db_query', 'remote_fleet', 'remote_rollout', 'remote_rollout_resume', 'support_bundle']);
  return UPGRADE_TOOL_CATALOG.filter((entry) => !concrete.has(entry.name)).map((entry) => defineTool({
    name: entry.name,
    description: entry.description,
    permission: entry.permission,
    annotations: {
      readOnlyHint: entry.permission === 'READ',
      destructiveHint: entry.permission === 'DANGEROUS',
    },
    inputSchema: upgradeInputSchema,
    handler: async (input, signal) => runtime.execute(entry.name, input, signal),
  }));
}
