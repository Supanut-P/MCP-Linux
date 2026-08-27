import { describe, expect, it } from 'vitest';
import { JsCommandDetector } from './js-command-detector.js';
import type { ProjectProfile } from './project-profile.js';

const profile: ProjectProfile = {
  rootPath: 'C:\\workspace',
  kind: 'node',
  packageManager: 'pnpm',
  frameworks: [],
  scripts: { test: 'vitest run' },
  configFiles: [],
};

describe('JsCommandDetector', () => {
  it('returns an executable and args without shell composition', () => {
    expect(new JsCommandDetector().getCommand(profile, 'test')).toEqual({
      ok: true,
      value: { executable: 'pnpm', args: ['test'] },
    });
  });

  it('returns INVALID_INPUT when the requested script is missing', () => {
    const result = new JsCommandDetector().getCommand(profile, 'build');

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
