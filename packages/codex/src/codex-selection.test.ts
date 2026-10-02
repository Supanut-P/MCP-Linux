import { describe, expect, it } from 'vitest';
import { resolveCodexSelection } from './codex-selection.js';

describe('resolveCodexSelection', () => {
  it('preserves legacy absence and applies deterministic role defaults', () => {
    expect(resolveCodexSelection(undefined)).toEqual({ ok: true, value: null });
    expect(resolveCodexSelection({})).toEqual({ ok: true, value: null });
    expect(resolveCodexSelection({ role: 'lead' })).toMatchObject({ value: { model: 'gpt-6.1-sol', effort: 'medium' } });
    expect(resolveCodexSelection({ role: 'worker' })).toMatchObject({ value: { model: 'gpt-6-luna', effort: 'low' } });
    expect(resolveCodexSelection({ role: 'qa' })).toMatchObject({ value: { model: 'gpt-6.1-sol', effort: 'medium' } });
    expect(resolveCodexSelection({ role: 'planner' })).toMatchObject({ value: { model: 'gpt-6-astra', effort: 'low' } });
  });
  it('allows explicit supported overrides without substituting models', () => {
    expect(resolveCodexSelection({ role: 'worker', model: 'gpt-5.6-terra', effort: 'high' })).toMatchObject({ ok: true, value: { model: 'gpt-5.6-terra', effort: 'high' } });
    for (const input of [null, [], { role: null }, { model: undefined }, { effort: null }, { config: {} }, { model: 'unknown-model' }, { model: 'x'.repeat(129) }, { model: 'gpt-6-luna', effort: 'ultra' }, { role: 'admin' }]) {
      expect(resolveCodexSelection(input).ok).toBe(false);
    }
  });
});
