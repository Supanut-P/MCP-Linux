import { describe, expect, it } from 'vitest';
import { RuntimeCache } from './runtime-cache.js';

describe('RuntimeCache', () => {
  it('invalidates by content identity and reports saved bytes', () => {
    const cache = new RuntimeCache<string>();
    const key = { workspaceId: 'w', path: 'src/a.ts', mtimeMs: 1, size: 2, contentHash: 'a' };
    cache.set(key, 'value', 12);
    expect(cache.get(key)).toBe('value');
    expect(cache.get({ ...key, contentHash: 'b' })).toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1, bytesSaved: 12 });
  });
});
