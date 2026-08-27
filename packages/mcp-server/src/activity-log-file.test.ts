import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityTracker, type ActivitySinkEvent } from './activity-tracker.js';
import { composeActivitySinks, createFileActivitySink, formatActivityLogLine, mcpActivityLogPath } from './activity-log-file.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('mcp activity log file', () => {
  it('resolves the activity log under the shared data path', () => {
    expect(mcpActivityLogPath('C:\\Users\\me\\AppData\\Roaming\\baitonghub-linux-mcp')).toMatch(/mcp-activity\.log$/);
  });

  it('writes started and completed NDJSON lines that Live Logs can tail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-activity-'));
    temporaryRoots.push(root);
    const filePath = mcpActivityLogPath(root);
    const tracker = new ActivityTracker(createFileActivitySink(filePath));

    const callId = await tracker.begin('read_file', { workspaceId: 'workspace-1', path: 'src\\app.ts' }, { sessionId: 'session-a' });
    await tracker.end(callId, 'SUCCESS', 4);

    const raw = await readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as { callId: string; phase: string; toolName: string; workspaceId?: string; sessionId?: string });
    expect(lines).toEqual([
      expect.objectContaining({ callId, phase: 'started', toolName: 'read_file', workspaceId: 'workspace-1', sessionId: 'session-a' }),
      expect.objectContaining({ callId, phase: 'completed', toolName: 'read_file', workspaceId: 'workspace-1', sessionId: 'session-a' }),
    ]);
    expect(formatActivityLogLine({
      callId: 'c1',
      toolName: 'write_file',
      phase: 'completed',
      resultCode: 'FILE_NOT_FOUND',
      durationMs: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      resultMessage: 'missing',
    })).toContain('"toolName":"write_file"');
  });

  it('still records to later sinks when an earlier activity sink fails', async () => {
    const recorded: ActivitySinkEvent[] = [];
    const sink = composeActivitySinks([
      {
        async record(): Promise<void> {
          throw new Error('file sink unavailable');
        },
      },
      {
        async record(event): Promise<void> {
          recorded.push(event);
        },
      },
    ]);

    await expect(sink.record({
      callId: 'c1',
      toolName: 'read_file',
      phase: 'started',
      resultCode: 'STARTED',
      durationMs: 0,
      timestamp: '2026-08-17T00:00:00.000Z',
    })).rejects.toThrow('file sink unavailable');
    expect(recorded).toHaveLength(1);
  });
});
