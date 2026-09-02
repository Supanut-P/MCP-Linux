import { describe, expect, it } from 'vitest';
import { AuditQueryService, type AuditQueryEvent, type AuditQueryPort } from './audit-query-service.js';

describe('AuditQueryService', () => {
  it('returns redacted, bounded summaries and an owner-bound continuation cursor', async () => {
    const calls: Array<{ readonly query: unknown; readonly limit: number }> = [];
    const events: AuditQueryEvent[] = [
      event('e-2', '2026-09-02T00:00:02.000Z', 'mcp_tool:read_file', 'SUCCESS', 'workspace-secret', '/srv/secret.txt'),
      event('e-1', '2026-09-02T00:00:01.000Z', 'mcp_tool:write_file', 'PERMISSION_REQUIRED', 'workspace-secret', 'token=do-not-leak'),
      { ...event('other', '2026-09-02T00:00:00.000Z', 'mcp_tool:read_file', 'SUCCESS', 'workspace-other', 'other'), actorId: 'client-b' },
    ];
    const port: AuditQueryPort = {
      async list(query, limit): Promise<readonly AuditQueryEvent[]> {
        calls.push({ query, limit });
        const before = query.before;
        const visible = events.filter((candidate) => candidate.actorId === query.actorId && candidate.sessionId === query.sessionId)
          .filter((candidate) => query.actionPrefix === undefined || candidate.action.startsWith(query.actionPrefix))
          .filter((candidate) => before === undefined || candidate.timestamp < before.timestamp || (candidate.timestamp === before.timestamp && candidate.id < before.id));
        return visible.slice(0, limit);
      },
    };
    const service = new AuditQueryService(port);

    const first = await service.execute({ clientId: 'client-a', sessionId: 'session-a' }, { limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.entries).toHaveLength(1);
    expect(first.value.entries[0]).toEqual({
      id: 'e-2',
      timestamp: '2026-09-02T00:00:02.000Z',
      tool: 'read_file',
      resultCode: 'SUCCESS',
      durationMs: 4,
      workspaceAlias: expect.stringMatching(/^workspace-[a-f0-9]{16}$/),
    });
    expect(JSON.stringify(first.value)).not.toContain('secret');
    expect(JSON.stringify(first.value)).not.toContain('token=');
    expect(first.value.nextCursor).toEqual(expect.any(String));
    expect(calls[0]?.limit).toBe(2);

    const second = await service.execute({ clientId: 'client-a', sessionId: 'session-a' }, { limit: 1, cursor: first.value.nextCursor });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.entries[0]?.tool).toBe('write_file');
    expect(second.value.nextCursor).toBeUndefined();

    const wrongOwner = await service.execute({ clientId: 'client-b', sessionId: 'session-a' }, { limit: 1, cursor: first.value.nextCursor });
    expect(wrongOwner).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('passes bounded filters to the audit port and sanitizes provider failures', async () => {
    let received: unknown;
    const service = new AuditQueryService({
      async list(query): Promise<readonly AuditQueryEvent[]> {
        received = query;
        throw new Error('api_key=super-secret');
      },
    });
    const result = await service.execute({ clientId: 'client-a', sessionId: 'session-a' }, {
      tool: 'read_file',
      resultCode: 'SUCCESS',
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-03T00:00:00.000Z',
      workspaceId: 'workspace-1',
      limit: 7,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(received).toMatchObject({
      actorId: 'client-a',
      sessionId: 'session-a',
      actionPrefix: 'mcp_tool:read_file',
      resultCode: 'SUCCESS',
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-03T00:00:00.000Z',
      workspaceId: 'workspace-1',
    });
  });

  it('fails closed when cancelled and rejects malformed cursors', async () => {
    const controller = new AbortController();
    controller.abort();
    const service = new AuditQueryService({ list: async (): Promise<readonly AuditQueryEvent[]> => [] });
    await expect(service.execute({ clientId: 'client-a' }, { limit: 5 }, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(service.execute({ clientId: 'client-a' }, { cursor: 'not-a-cursor' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});

function event(id: string, timestamp: string, action: string, resultCode: string, workspaceId: string, targetSummary: string): AuditQueryEvent {
  return { id, timestamp, actorId: 'client-a', sessionId: 'session-a', action, resultCode, durationMs: 4, workspaceId, targetSummary };
}
