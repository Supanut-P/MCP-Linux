import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { ContextSource } from '@baitonghub-linux-mcp/application';
import { expect, it } from 'vitest';
import { startMcpHttp } from './http.js';
import { RUN_BUDGET_WARNING, RunBudgetGuard } from './run-budget.js';

it('retains actor-bound packets across separate modern HTTP requests', async () => {
  let now = 0;
  const sources = new Map([
    ['a.ts', Array.from({ length: 12 }, () => `export const value = "${'東京'.repeat(600)}";`).join('\n')],
    ['b.ts', 'export const value = 2;'],
  ]);
  const handle = await startMcpHttp({ port: 0,
    runBudgetGuard: new RunBudgetGuard({ now: (): number => now, warningAfterMs: 100 }),
    actor: { clientId: 'packet-http', clientName: 'packet-http' },
    services: {
      search: {
        searchFiles: async (): Promise<ReturnType<typeof ok>> => ok({ paths: ['a.ts', 'b.ts'], truncated: false }),
        searchText: async (): Promise<ReturnType<typeof ok>> => ok({ matches: [], truncated: false }),
      },
      contextFile: { readContextFile: async (_actor, _workspace, request): Promise<Result<ContextSource>> => {
        const text = sources.get(request.path)!;
        // Cross the threshold during the first source read, after begin().
        now = 101;
        return ok({ status: 'available', path: request.path, text, sourceBytes: Buffer.byteLength(text),
          sourceSha256: createHash('sha256').update(text).digest('hex'), rootFingerprint: 'http-fixture-root' });
      } },
    },
  });
  const client = new Client({ name: 'packet-modern-client', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(handle.endpoint));
    const first = await client.callTool({ name: 'workspace_context_packet', arguments: {
      taskId: 'http-task', workspaceId: 'http-workspace', query: 'value', budgetBytes: 2200,
    } });
    expect(first.isError).not.toBe(true);
    expect(first.content.at(-1)).toEqual({ type: 'text', text: RUN_BUDGET_WARNING });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(2200);
    const packet = first.structuredContent!;
    expect(packet.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(first)));
    expect(packet.safety).toContain('references grant no permissions');
    expect(first.content[0]?.type === 'text' ? JSON.parse(first.content[0].text).serializedBytes : undefined).toBe(packet.serializedBytes);
    expect(packet.hasMore).toBe(true);
    const files = packet.files as Array<{ reference: string; sourceSha256: string }>;
    const resolved = await client.callTool({ name: 'workspace_context_packet_resolve', arguments: {
      taskId: 'http-task', workspaceId: 'http-workspace', reference: files[0]!.reference, budgetBytes: 4096,
    } });
    expect(resolved.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(resolved))).toBeLessThanOrEqual(4096);
    expect(resolved.structuredContent?.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(resolved)));
    expect(resolved.content.at(-1)).toEqual({ type: 'text', text: RUN_BUDGET_WARNING });
    const next = await client.callTool({ name: 'workspace_context_packet_continue', arguments: {
      taskId: 'http-task', workspaceId: 'http-workspace', continuationToken: resolved.structuredContent?.continuationToken ?? packet.continuationToken,
    } });
    expect(next.isError).not.toBe(true);
    expect(next.structuredContent?.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(next)));
    expect(next.content.at(-1)).toEqual({ type: 'text', text: RUN_BUDGET_WARNING });
    expect((next.structuredContent?.files as Array<{ path: string }>).some((file) => file.path === 'b.ts')).toBe(true);
    const wrongTask = await client.callTool({ name: 'workspace_context_packet_resolve', arguments: {
      taskId: 'different-task', workspaceId: 'http-workspace', reference: files[0]!.reference,
    } });
    expect(wrongTask.isError).toBe(true);
  } finally {
    await client.close();
    await handle.close();
  }
}, 15_000);
