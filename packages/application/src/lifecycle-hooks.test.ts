import { describe, expect, it } from 'vitest';
import { LifecycleHookRegistry } from './lifecycle-hooks.js';

describe('LifecycleHookRegistry', () => {
  it('runs hooks in registration order and can deny before a side effect', async () => {
    const registry = new LifecycleHookRegistry();
    registry.register('audit', 'beforeWrite', async () => undefined);
    registry.register('policy', 'beforeWrite', async () => ({ allow: false, reason: 'protected path' }));
    expect(await registry.run({ event: 'beforeWrite', toolName: 'write_file', inputKeys: ['path'] })).toMatchObject({ allow: false, reason: 'protected path' });
    expect(registry.list()).toHaveLength(2);
  });
});
