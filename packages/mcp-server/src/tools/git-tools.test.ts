import { describe, expect, it } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { gitTools } from './git-tools.js';
import type { McpToolContext } from './tool-types.js';

describe('gitTools', () => {
  it('forwards the invocation cancellation signal to every Git service call', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        git: {
          async status(_actor: unknown, _workspaceId: string, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ entries: [] });
          },
          async diff(_actor: unknown, _workspaceId: string, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ patch: '', truncated: false });
          },
          async log(_actor: unknown, _workspaceId: string, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ entries: [], truncated: false });
          },
          async run(_actor: unknown, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ exitCode: 0, stdout: '', stderr: '' });
          },
        },
      },
    } as unknown as McpToolContext;
    const tools = gitTools(context);
    const signal = new AbortController().signal;
    const calls: ReadonlyArray<readonly [string, unknown]> = [
      ['git_status', { workspaceId: 'workspace-1' }],
      ['git_diff', { workspaceId: 'workspace-1' }],
      ['git_log', { workspaceId: 'workspace-1' }],
      ['git', { args: ['status'], workspaceId: 'workspace-1', userConfirmed: true }],
    ];

    for (const [name, input] of calls) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing Git tool: ${name}`);
      await tool.execute(input, signal);
    }

    expect(observedSignals).toEqual([signal, signal, signal, signal]);
  });
});
