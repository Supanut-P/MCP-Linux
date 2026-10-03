import { describe, expect, it } from 'vitest';
import { mapError, mapResult } from './result-mapper.js';

describe('mapResult image payloads', () => {
  it('exposes only exact bounded workflow digest details for acknowledgement', () => {
    const details = {baselineFingerprint: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64)};
    expect(mapError({code: 'INVALID_INPUT', message: 'Scope review required', recoverable: false, details}).structuredContent).toMatchObject({error: {details}});
    expect(mapError({code: 'INVALID_INPUT', message: 'Invalid', recoverable: false, details: {...details, secret: 'private'}}).structuredContent).not.toHaveProperty('error.details');
    expect(mapError({code: 'INVALID_INPUT', message: 'Invalid', recoverable: false, details: {...details, sourceFingerprint: 'private'}}).structuredContent).not.toHaveProperty('error.details');
    expect(mapError({code: 'INTERNAL_ERROR', message: 'private', recoverable: false, details}).structuredContent).not.toHaveProperty('error.details');
  });

  it('includes MCP image content for base64 image reads', () => {
    const response = mapResult({
      ok: true as const,
      value: {
        path: 'pixel.png',
        content: 'iVBORw0KGgo=',
        encoding: 'base64',
        mimeType: 'image/png',
        startLine: 1,
        endLine: 1,
      },
    });

    expect(response.content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  });

  it('keeps filesystem error messages instead of Operation failed', () => {
    const response = mapError({ code: 'FILE_NOT_FOUND', message: 'File or directory was not found', recoverable: false });
    expect(response.content[0]?.text).toBe('FILE_NOT_FOUND: File or directory was not found');
  });
});
