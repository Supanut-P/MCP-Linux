import { describe, expect, it } from 'vitest';
import { parseServerProfile, serverProfileToolAllowed } from './server-profile.js';

describe('server profiles', () => {
  it('accepts the four explicit surfaces and rejects unknown values', () => {
    expect(parseServerProfile(undefined)).toMatchObject({ ok: true, value: 'full' });
    expect(parseServerProfile(' CORE ')).toMatchObject({ ok: true, value: 'core' });
    expect(parseServerProfile('operator')).toMatchObject({ ok: true, value: 'operator' });
    expect(parseServerProfile('fleet')).toMatchObject({ ok: true, value: 'fleet' });
    expect(parseServerProfile('desktop')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('keeps core tools available and adds only the selected surface', () => {
    expect(serverProfileToolAllowed('workspace_list', 'core')).toBe(true);
    expect(serverProfileToolAllowed('audit_query', 'core')).toBe(true);
    expect(serverProfileToolAllowed('service', 'core')).toBe(false);
    expect(serverProfileToolAllowed('service', 'operator')).toBe(true);
    expect(serverProfileToolAllowed('remote_host', 'operator')).toBe(false);
    expect(serverProfileToolAllowed('remote_host', 'fleet')).toBe(true);
    expect(serverProfileToolAllowed('remote_rollout', 'fleet')).toBe(true);
    expect(serverProfileToolAllowed('remote_host', 'full')).toBe(true);
  });
});
