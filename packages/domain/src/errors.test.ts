import { describe, expect, it } from 'vitest';
import { appError, err, ok } from './errors.js';

describe('Result helpers', () => {
  it('creates success result', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('creates sanitized application error result', () => {
    expect(err(appError('INVALID_INPUT', 'bad input'))).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'bad input', recoverable: false },
    });
  });

  it.each([
    'CAPABILITY_UNAVAILABLE',
    'CAPABILITY_CONSENT_REQUIRED',
    'PLATFORM_UNSUPPORTED',
  ] as const)('exposes the Linux platform contract error %s', (code) => {
    expect(appError(code, 'sanitized')).toMatchObject({ code, message: 'sanitized' });
  });
});
