import { describe, expect, it } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { fileTools } from './file-tools.js';
import type { McpToolContext } from './tool-types.js';

describe('fileTools cancellation', () => {
  it('forwards the invocation signal to every file mutation', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const record = (signal?: AbortSignal): ReturnType<typeof ok> => {
      observedSignals.push(signal);
      return ok({});
    };
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        file: {
          async writeFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async applyPatch(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async moveFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async copyFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async deleteFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async restoreDeletedFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
        },
      },
    } as unknown as McpToolContext;
    const tools = fileTools(context);
    const signal = new AbortController().signal;
    const calls: ReadonlyArray<readonly [string, unknown]> = [
      ['write_file', { workspaceId: 'workspace-1', path: 'a.txt', content: 'a' }],
      ['apply_patch', { workspaceId: 'workspace-1', files: [{ path: 'a.txt', content: 'b' }] }],
      ['move_file', { workspaceId: 'workspace-1', sourcePath: 'a.txt', destinationPath: 'b.txt' }],
      ['copy_file', { workspaceId: 'workspace-1', sourcePath: 'a.txt', destinationPath: 'b.txt' }],
      ['delete_file', { workspaceId: 'workspace-1', path: 'a.txt', userConfirmed: true }],
      ['restore_deleted_file', { workspaceId: 'workspace-1', recoveryId: '123e4567-e89b-42d3-a456-426614174000' }],
    ];

    for (const [name, input] of calls) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing file tool: ${name}`);
      await tool.execute(input, signal);
    }

    expect(observedSignals).toEqual([signal, signal, signal, signal, signal, signal]);
  });
});
