import { describe, expect, it } from 'vitest';
import { LogRingBuffer } from './ring-buffer.js';

describe('LogRingBuffer', () => {
  it('evicts oldest records after exceeding the 10 MiB bound and preserves sequence numbers', () => {
    const buffer = new LogRingBuffer(10 * 1024 * 1024);
    buffer.append('stdout', 'a'.repeat(10 * 1024 * 1024 - 4));
    buffer.append('stderr', 'tail-marker');

    const result = buffer.read({});

    expect(result.truncated).toBe(true);
    expect(result.entries).toEqual([{ sequence: 2, stream: 'stderr', text: 'tail-marker' }]);
    expect(result.nextSequence).toBe(2);
  });

  it('supports sequence cursors and tail line limits', () => {
    const buffer = new LogRingBuffer(1024);
    buffer.append('stdout', 'one\ntwo\nthree\n');

    expect(buffer.read({ sinceSequence: 1, tailLines: 1 })).toEqual({
      entries: [{ sequence: 3, stream: 'stdout', text: 'three\n' }],
      truncated: false,
      nextSequence: 3,
    });
  });
});
