import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { DEFAULT_RUN_BUDGET_WARNING_MS, RUN_BUDGET_WARNING, RunBudgetGuard } from './run-budget.js';

function result(text = 'done'): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('RunBudgetGuard', () => {
  it('appends the budget warning to the tool result after 22 minutes from the first tool call', () => {
    let now = 1_000;
    const guard = new RunBudgetGuard({ now: (): number => now });
    const context = { sessionId: 'run-1' };

    guard.begin(context);
    expect(guard.finish(context, result()).content.at(-1)).toMatchObject({ text: 'done' });

    now += DEFAULT_RUN_BUDGET_WARNING_MS + 1;
    guard.begin(context);
    const warned = guard.finish(context, result('second result'));

    expect(warned.content.at(-1)).toEqual({ type: 'text', text: RUN_BUDGET_WARNING });
    expect(warned.content.at(-1)?.type === 'text' ? warned.content.at(-1)?.text : undefined).toBe(
      'ใกล้หมด budget — อัปเดต tracker + สั่งงานยาวเป็น background เดี๋ยวนี้',
    );
  });

  it('starts a new stateless run after the idle reset window', () => {
    let now = 0;
    const guard = new RunBudgetGuard({ warningAfterMs: 100, idleResetMs: 50, now: (): number => now });

    guard.begin(undefined);
    now = 60;
    guard.begin(undefined);
    now = 120;

    expect(guard.finish(undefined, result()).content.at(-1)).toMatchObject({ text: 'done' });
  });
});
