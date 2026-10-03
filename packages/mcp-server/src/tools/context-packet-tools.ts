import { z } from 'zod';
import { APP_NAME, APP_VERSION } from '@baitonghub-linux-mcp/shared';
import { ContextPacketRuntime } from '../context-packet-runtime.js';
import type { ContextPacketStore } from '../context-packet-store.js';
import type { ContextEngine } from '../context-engine.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const identifier = z.string().trim().min(1).max(128).refine((value) => !value.includes('\0'));
const common = { taskId: identifier, workspaceId: identifier };
const budgetBytes = z.number().int().min(1024).max(64 * 1024).optional();
export const contextPacketSchema = z.object({
  ...common,
  query: z.string().trim().min(1).max(4096).refine((value) => !value.includes('\0')),
  role: z.enum(['worker', 'qa']).default('worker'),
  budgetBytes,
  path: z.string().trim().min(1).max(4096).optional(),
  intent: z.enum(['auto', 'debug', 'implement', 'review', 'trace', 'explore']).optional(),
}).strict();
export const contextPacketContinueSchema = z.object({ ...common, continuationToken: identifier, budgetBytes }).strict();
export const contextPacketResolveSchema = z.object({ ...common, reference: identifier, budgetBytes }).strict();

export function contextPacketTools(context: McpToolContext, discovery: Pick<ContextEngine, 'discoverPacketCandidates'>, sessionId?: string, store?: ContextPacketStore): McpToolDefinition[] {
  const source = context.services.contextFile;
  if (source === undefined) return [];
  // Modern MCP adds this identity to results. Emit it explicitly so packet
  // fitting and delivered result bytes agree on both modern and legacy paths.
  const resultMetadata = { 'io.modelcontextprotocol/serverInfo': { name: APP_NAME, version: APP_VERSION } };
  const ports = {
    resultMetadata,
    reserveRunBudgetWarning: true,
    actor: { ...context.actor, ...(sessionId === undefined ? {} : { sessionId }) },
    source,
    discovery,
  };
  const runtime = store === undefined ? new ContextPacketRuntime(ports) : store.get(ports);
  return [
    defineTool({
      name: 'workspace_context_packet',
      resultMetadata,
      description: 'Collect a bounded task context packet with freshly verified source fingerprints, snippets and opaque references. Read only; no execution or new permissions.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: contextPacketSchema,
      handler: async (input, signal) => runtime.collect(input, signal),
    }),
    defineTool({
      name: 'workspace_context_packet_continue',
      resultMetadata,
      description: 'Continue a task-bound context packet with fresh source checks; expired, changed or mismatched references cannot establish unchanged source.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: contextPacketContinueSchema,
      handler: async (input, signal) => runtime.continue(input, signal),
    }),
    defineTool({
      name: 'workspace_context_packet_resolve',
      resultMetadata,
      description: 'Resolve an opaque task context reference by rereading its registered source and identifying stale content. Process-local references can expire.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: contextPacketResolveSchema,
      handler: async (input, signal) => runtime.resolve(input, signal),
    }),
  ];
}
