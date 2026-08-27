import { describe, expect, it } from 'vitest';
import { PatchApplier } from './patch-applier.js';

describe('PatchApplier', () => {
  it('rejects duplicate paths before any file operation is started', () => {
    const result = new PatchApplier().validate([
      { path: 'src/a.ts', content: 'one' },
      { path: 'src\\a.ts', content: 'two' },
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('rejects oversized patch batches', () => {
    const result = new PatchApplier().validate([{ path: 'large.txt', content: 'x'.repeat(4 * 1024 * 1024 + 1) }]);

    expect(result).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
  });
});
