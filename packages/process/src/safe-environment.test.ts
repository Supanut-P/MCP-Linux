import { describe, expect, it } from 'vitest';
import { createSafeProcessEnvironment } from './safe-environment.js';

describe('runtime-only process environment', () => {
  it('preserves Windows OS/home paths while dropping credential-bearing variables', () => {
    expect(createSafeProcessEnvironment({ Path: 'tools', SystemRoot: 'os', USERPROFILE: 'home', CODEX_HOME: 'codex', OPENAI_API_KEY: 'canary-key', HTTPS_PROXY: 'canary-proxy', CUSTOM_SECRET: 'canary-secret' }, 'win32'))
      .toEqual({ PATH: 'tools', SYSTEMROOT: 'os', USERPROFILE: 'home', CODEX_HOME: 'codex' });
  });
  it('retains case-sensitive Linux policy and excludes Windows-only variables', () => {
    expect(createSafeProcessEnvironment({ PATH: 'tools', Path: 'wrong', HOME: 'home', SYSTEMROOT: 'os', OPENAI_API_KEY: 'canary' }, 'linux'))
      .toEqual({ PATH: 'tools', HOME: 'home' });
  });
});
