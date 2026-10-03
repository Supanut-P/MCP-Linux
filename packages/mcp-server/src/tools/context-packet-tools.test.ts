import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { ContextSource } from '@baitonghub-linux-mcp/application';
import { ToolRegistry } from '../tool-registry.js';
import { contextPacketSchema, contextPacketContinueSchema, contextPacketResolveSchema } from './context-packet-tools.js';

const actor = { clientId: 'packet-tool-test', clientName: 'packet-tool-test' };

describe('context packet tools', () => {
  it('keeps legacy registries unchanged when the optional bounded reader is absent', () => {
    expect(new ToolRegistry({}, actor).list().filter((tool) => tool.name.startsWith('workspace_context_packet'))).toEqual([]);
  });

  it('exposes read-only collect/continue/resolve and fits the actual MCP result', async () => {
    const text = 'export function packetProof() {}\n';
    let reads = 0;
    const registry = new ToolRegistry({
      contextFile: { readContextFile: async (_actor, _workspace, request): Promise<Result<ContextSource>> => {
        reads += 1;
        return ok({ status: 'available' as const, path: request.path, text,
          sourceBytes: Buffer.byteLength(text), sourceSha256: createHash('sha256').update(text).digest('hex'), rootFingerprint: 'fixture-root' });
      } },
      search: {
        searchFiles: async (): Promise<ReturnType<typeof ok>> => ok({ paths: ['proof.ts'], truncated: false }),
        searchText: async (): Promise<ReturnType<typeof ok>> => ok({ matches: [{ path: 'proof.ts', line: 1, text: 'obsolete match text' }], truncated: false }),
      },
    }, actor, { sessionId: 'packet-session' });
    const tools = registry.list().filter((tool) => tool.name.startsWith('workspace_context_packet'));
    expect(tools).toHaveLength(3);
    expect(tools.every((tool) => tool.permission === 'READ' && tool.annotations?.readOnlyHint === true)).toBe(true);
    const response = await registry.invoke('workspace_context_packet', { taskId: 'task-1', workspaceId: 'ws-1', query: 'packetProof', budgetBytes: 4096 });
    expect(response.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(4096);
    expect(response.structuredContent?.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(response), 'utf8'));
    expect(response._meta).toHaveProperty('io.modelcontextprotocol/serverInfo');
    expect(response.structuredContent).toMatchObject({ taskId: 'task-1', workspaceId: 'ws-1', role: 'worker' });
    expect(JSON.stringify(response)).not.toContain('obsolete match text');
    expect(reads).toBeGreaterThan(0);
  });

  it('rejects execution fields and out-of-range budgets or malformed reference operations', () => {
    const request = { taskId: 't', workspaceId: 'w', query: 'q' };
    expect(contextPacketSchema.safeParse({ ...request, execute: true }).success).toBe(false);
    expect(contextPacketSchema.safeParse({ ...request, budgetBytes: 65_537 }).success).toBe(false);
    expect(contextPacketContinueSchema.safeParse({ taskId: 't', workspaceId: 'w' }).success).toBe(false);
    expect(contextPacketResolveSchema.safeParse({ taskId: 't', workspaceId: 'w', reference: '\0' }).success).toBe(false);
  });
});
