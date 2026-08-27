import { describe, expect, it } from 'vitest';

import { ContextEconomyRuntime } from './context-economy.js';

describe('ContextEconomyRuntime', () => {
  it('deduplicates unchanged and repeated content while producing a diff for edits', () => {
    const economy = new ContextEconomyRuntime();
    const first = economy.prepare({ workspaceId: 'workspace-1', path: 'src/a.ts', content: 'one\ntwo', contextId: 'ctx-1' });
    const unchanged = economy.prepare({ workspaceId: 'workspace-1', path: 'src/a.ts', content: 'one\ntwo', contextId: 'ctx-2' });
    const duplicate = economy.prepare({ workspaceId: 'workspace-1', path: 'src/copy.ts', content: 'one\ntwo', contextId: 'ctx-2' });
    const changed = economy.prepare({ workspaceId: 'workspace-1', path: 'src/a.ts', content: 'one\nchanged', contextId: 'ctx-3' });

    expect(first.delivery).toBe('content');
    expect(unchanged).toMatchObject({ delivery: 'unchanged', unchangedSince: 'ctx-1' });
    expect(duplicate).toMatchObject({ delivery: 'reference', referencePath: 'src/a.ts' });
    expect(changed.delivery).toBe('diff');
    expect(changed.diff).toContain('+changed');
  });

  it('keeps bounded telemetry without retaining unbounded context', () => {
    const economy = new ContextEconomyRuntime({ maxEntries: 2, maxStoredBytes: 8 });
    economy.prepare({ workspaceId: 'workspace-1', path: 'src/a.ts', content: '1234', contextId: 'ctx-1' });
    economy.prepare({ workspaceId: 'workspace-1', path: 'src/b.ts', content: '5678', contextId: 'ctx-1' });
    economy.prepare({ workspaceId: 'workspace-1', path: 'src/c.ts', content: '9012', contextId: 'ctx-1' });

    const stats = economy.snapshot();
    expect(stats.filesDiscovered).toBe(3);
    expect(stats.ledgerEntries).toBeLessThanOrEqual(2);
    expect(stats.rawContextBytes).toBe(12);
  });
});
