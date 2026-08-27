import { describe, expect, it } from 'vitest';
import { machineRootPaths, normalizeWorkspaceRoot } from './machine-root.js';

describe('registered-root helpers', () => {
  it('keeps Linux access inside the registered root even when unrestricted is requested', () => {
    expect(machineRootPaths(false, '/home/alice/project')).toEqual(['/home/alice/project']);
    expect(machineRootPaths(true, '/home/alice/project')).toEqual(['/home/alice/project']);
    expect(machineRootPaths(true, undefined)).toEqual([]);
    expect(normalizeWorkspaceRoot('/home/alice/project')).toBe('/home/alice/project/');
  });
});
