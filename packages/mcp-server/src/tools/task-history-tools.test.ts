import { describe, expect, it } from 'vitest';
import { ContextEconomyRuntime } from '../context-economy.js';
import { taskHistoryTools } from './task-history-tools.js';
import type { McpToolContext } from './tool-types.js';

describe('taskHistoryTools', () => {
  it('uses the request actor and forwards the bounded filter', async () => {
    let observedActor: unknown;
    let observedInput: unknown;
    const context = {
      actor: { clientId: 'client-1', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        taskHistory: {
          execute: async (actor: unknown, input: unknown) => {
            observedActor = actor;
            observedInput = input;
            return { ok: true, value: { entries: [], count: 0, truncated: false } } as const;
          },
        },
      },
    } as unknown as McpToolContext;
    const tool = taskHistoryTools(context)[0];
    const parsed = tool.parse({ state: 'completed', limit: 10 });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    await tool.execute(parsed.value, new AbortController().signal);
    expect(observedActor).toEqual(context.actor);
    expect(observedInput).toMatchObject({ state: 'completed', limit: 10 });
  });
});
