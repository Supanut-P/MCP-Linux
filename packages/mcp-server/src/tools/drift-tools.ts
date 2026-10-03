import { z } from 'zod';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const confirmation = { userConfirmed: z.boolean().optional() };
const target = z.discriminatedUnion('kind', [
  z.object({ id, hostId: id, kind: z.literal('service'), unit: z.string().regex(/^(?!-)[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/) }).strict(),
  z.object({ id, hostId: id, kind: z.literal('config'), path: z.string().min(1).max(1024) }).strict(),
  z.object({ id, hostId: id, kind: z.literal('artifact'), path: z.string().min(1).max(1024) }).strict(),
]);
export const driftSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('capture'), snapshotId: id, workspaceId: id, targets: z.array(target).min(1).max(20), ...confirmation }).strict(),
  z.object({ operation: z.literal('approve'), snapshotId: id, snapshotHash: hash, ...confirmation }).strict(),
  z.object({ operation: z.literal('compare'), snapshotId: id, baselineId: id, baselineHash: hash, ...confirmation }).strict(),
  z.object({ operation: z.literal('status'), snapshotId: id, ...confirmation }).strict(),
]);

export function driftTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.drift;
  return service === undefined ? [] : [defineTool({
    name: 'drift',
    description: 'Capture bounded registered-host service states or file digests, approve a complete exact-hash baseline with explicit confirmation, compare its fixed targets, or inspect immutable evidence. Metadata persistence requires current READ/WRITE policy. Stale, unavailable and truncated evidence never proves unchanged. Caller-attested approval grants no remote mutation authority; raw content, paths and errors are omitted.',
    permission: 'READ', annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: driftSchema,
    handler: async (input, signal) => service.execute(context.actor, input, signal),
  })];
}
