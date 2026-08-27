import { describe, expect, it } from 'vitest';
import { isUnrestricted, unrestrictedFromEnv, unrestrictedFromSetting, UNRESTRICTED_SETTING_KEY } from './unrestricted.js';

describe('unrestrictedFromSetting', () => {
  it('accepts common truthy values', () => {
    expect(unrestrictedFromSetting('1')).toBe(true);
    expect(unrestrictedFromSetting('true')).toBe(true);
    expect(unrestrictedFromSetting('TRUE')).toBe(true);
    expect(unrestrictedFromSetting('on')).toBe(true);
    expect(unrestrictedFromSetting(' yes ')).toBe(true);
  });

  it('rejects falsy and missing values', () => {
    expect(unrestrictedFromSetting('0')).toBe(false);
    expect(unrestrictedFromSetting('false')).toBe(false);
    expect(unrestrictedFromSetting('')).toBe(false);
    expect(unrestrictedFromSetting(null)).toBe(false);
    expect(unrestrictedFromSetting(undefined)).toBe(false);
  });
});

describe('unrestrictedFromEnv', () => {
  it('reads BAITONGHUB_LINUX_MCP_UNRESTRICTED', () => {
    expect(unrestrictedFromEnv({ BAITONGHUB_LINUX_MCP_UNRESTRICTED: '1' })).toBe(true);
    expect(unrestrictedFromEnv({ BAITONGHUB_LINUX_MCP_UNRESTRICTED: 'true' })).toBe(true);
    expect(unrestrictedFromEnv({ BAITONGHUB_LINUX_MCP_UNRESTRICTED: '0' })).toBe(false);
    expect(unrestrictedFromEnv({})).toBe(false);
  });
});

describe('isUnrestricted', () => {
  it('defaults to on when neither env nor settings set a value', () => {
    expect(isUnrestricted({}, null)).toBe(true);
    expect(isUnrestricted({}, undefined)).toBe(true);
  });

  it('honors an explicit off setting or env override', () => {
    expect(isUnrestricted({}, 'false')).toBe(false);
    expect(isUnrestricted({ BAITONGHUB_LINUX_MCP_UNRESTRICTED: '0' }, 'true')).toBe(false);
    expect(isUnrestricted({ BAITONGHUB_LINUX_MCP_UNRESTRICTED: '1' }, 'false')).toBe(true);
    expect(isUnrestricted({}, settingsValueFor(true))).toBe(true);
  });

  it('exposes a stable settings key', () => {
    expect(UNRESTRICTED_SETTING_KEY).toBe('unrestricted_mode');
  });
});

function settingsValueFor(enabled: boolean): string {
  return enabled ? 'true' : 'false';
}
