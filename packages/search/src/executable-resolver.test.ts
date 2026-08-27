import { describe, expect, it } from 'vitest';
import { PathExecutableResolver } from './executable-resolver.js';

describe('PathExecutableResolver', () => {
  it('returns a structured missing-executable result', async () => {
    const result = await new PathExecutableResolver({ PATH: '' }).resolve('definitely-missing-rg');

    expect(result).toMatchObject({ ok: false, error: { code: 'EXECUTABLE_NOT_FOUND' } });
  });
});
