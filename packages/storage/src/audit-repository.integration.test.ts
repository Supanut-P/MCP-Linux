import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@baitonghub-linux-mcp/audit';
import { SqliteAuditRepository } from './audit-repository.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteAuditRepository', () => {
  it('persists sanitized audit metadata through the audit migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-audit-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const event: AuditEvent = {
      id: 'event-1',
      timestamp: new Date(0).toISOString(),
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      action: 'read_file',
      resultCode: 'SUCCESS',
      durationMs: 4,
      metadata: { path: 'src/index.ts' },
    };

    await repository.insert(event);

    await expect(repository.list(10)).resolves.toEqual([event]);
    database.close();
  });

  it('round-trips session scope and applies workspace/session filters before LIMIT', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-audit-scope-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);

    const targetEvents: AuditEvent[] = [
      scopedEvent('target-1', '2026-08-20T00:00:01.000Z', 'workspace-target', 'session-a'),
      scopedEvent('target-2', '2026-08-20T00:00:02.000Z', 'workspace-target', 'session-a'),
      scopedEvent('target-b', '2026-08-20T00:00:03.000Z', 'workspace-target', 'session-b'),
    ];
    for (const event of targetEvents) await repository.insert(event);
    for (let index = 0; index < 25; index += 1) {
      await repository.insert(scopedEvent(
        `noise-${index}`,
        `2026-08-21T00:00:${String(index).padStart(2, '0')}.000Z`,
        'workspace-noise',
        'session-noise',
      ));
    }

    await expect(repository.listScoped({
      actionPrefix: 'mcp_tool:',
      workspaceId: 'workspace-target',
      sessionId: 'session-a',
    }, 2)).resolves.toEqual([targetEvents[1], targetEvents[0]]);
    await expect(repository.listScoped({ workspaceId: 'workspace-target', sessionId: 'session-b' }, 10))
      .resolves.toEqual([targetEvents[2]]);
    database.close();
  });

  it('preserves legacy null session scope during migration and can query it explicitly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-audit-legacy-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const legacy: AuditEvent = {
      id: 'legacy-event', timestamp: '2026-08-20T00:00:00.000Z', actorId: 'legacy', actorName: 'legacy',
      action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: {},
    };
    const scoped = scopedEvent('scoped-event', '2026-08-20T00:00:01.000Z', 'workspace-1', 'session-1');
    await repository.insert(legacy);
    await repository.insert(scoped);

    await expect(repository.listScoped({ workspaceId: null, sessionId: null }, 10)).resolves.toEqual([legacy]);
    database.close();
  });

  it('applies actor, result, time, and descending cursor filters before the limit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-audit-query-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteAuditRepository(database);
    const matching: AuditEvent[] = [
      { ...scopedEvent('q-3', '2026-09-02T00:00:03.000Z', 'workspace-1', 'session-a'), resultCode: 'SUCCESS' },
      { ...scopedEvent('q-2', '2026-09-02T00:00:02.000Z', 'workspace-1', 'session-a'), resultCode: 'SUCCESS' },
      { ...scopedEvent('q-1', '2026-09-02T00:00:01.000Z', 'workspace-1', 'session-a'), resultCode: 'PERMISSION_REQUIRED' },
    ];
    for (const event of matching) await repository.insert(event);
    await repository.insert({ ...matching[0]!, id: 'other-actor', actorId: 'other' });

    await expect(repository.listScoped({
      actorId: 'client-1', actionPrefix: 'mcp_tool:read_file', workspaceId: 'workspace-1', sessionId: 'session-a',
      resultCode: 'SUCCESS', since: '2026-09-01T00:00:00.000Z', until: '2026-09-03T00:00:00.000Z',
      before: { timestamp: '2026-09-02T00:00:03.000Z', id: 'q-3' },
    }, 10)).resolves.toEqual([matching[1]!]);
    database.close();
  });

});


function scopedEvent(id: string, timestamp: string, workspaceId: string, sessionId: string): AuditEvent {
  return {
    id, timestamp, actorId: 'client-1', actorName: 'test', workspaceId, sessionId,
    action: 'mcp_tool:read_file', resultCode: 'SUCCESS', durationMs: 1, metadata: { callId: id },
  };
}
