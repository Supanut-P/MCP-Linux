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

describe('SqliteDatabase WAL', () => {
  it('opens in WAL mode so desktop and stdio MCP can share baitonghub-linux-mcp.sqlite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-wal-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'baitonghub-linux-mcp.sqlite');
    const writer = new SqliteDatabase(filename);
    const mode = writer.connection.prepare('PRAGMA journal_mode;').get() as { journal_mode?: string } | undefined;
    expect(mode?.journal_mode?.toLowerCase()).toBe('wal');

    const repository = new SqliteAuditRepository(writer);
    const event: AuditEvent = {
      id: 'event-mcp-1',
      timestamp: new Date().toISOString(),
      actorId: 'cli-mcp-stdio',
      actorName: 'baitonghub-linux-mcp cli MCP',
      action: 'mcp_tool:read_file',
      resultCode: 'SUCCESS',
      durationMs: 3,
      metadata: { toolName: 'read_file', callId: 'c1', phase: 'completed' },
    };
    await repository.insert(event);

    const reader = new SqliteDatabase(filename);
    const listed = await new SqliteAuditRepository(reader).listByActionPrefix('mcp_tool:', 10);
    expect(listed.map((item) => item.id)).toEqual(['event-mcp-1']);
    writer.close();
    reader.close();
  });
});
