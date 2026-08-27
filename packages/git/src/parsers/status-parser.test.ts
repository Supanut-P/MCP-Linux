import { describe, expect, it } from 'vitest';
import { parsePorcelainStatus } from './status-parser.js';

describe('parsePorcelainStatus', () => {
  it('parses staged, worktree, untracked, and rename records with Windows-safe paths', () => {
    const result = parsePorcelainStatus(
      ' M src\\space file.txt\0R  old name.txt\0new Ω.txt\0?? untracked.txt\0',
    );

    expect(result).toEqual([
      { path: 'src\\space file.txt', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' },
      { path: 'new Ω.txt', oldPath: 'old name.txt', kind: 'renamed', indexStatus: 'R', worktreeStatus: ' ' },
      { path: 'untracked.txt', kind: 'untracked', indexStatus: '?', worktreeStatus: '?' },
    ]);
  });
});
