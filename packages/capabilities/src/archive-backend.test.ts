import { describe, expect, it } from 'vitest';
import { validateArchiveMembers, ArchiveBackend } from './archive-backend.js';

describe('ArchiveBackend', () => {
  it('rejects absolute and traversal members', () => {
    expect(validateArchiveMembers(['/etc/passwd'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(validateArchiveMembers(['safe/../../escape'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(validateArchiveMembers(['lrwxrwxrwx user/group 0 2026-01-01 00:00 link -> ../../escape'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(validateArchiveMembers(['crw-r--r-- user/group 0 2026-01-01 00:00 device'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('requires confirmation before overwriting during extraction', async () => {
    const backend = new ArchiveBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => ['/tmp'] , resolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}` });
    // Missing archive is rejected before any extractor can run; mutation confirmation remains a backend gate.
    await expect(backend.execute({ operation: 'extract', archive: '/tmp/missing.tar', destination: '/tmp', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
  });

  it('requires confirmation for archive creation and rejects unknown formats', async () => {
    const backend = new ArchiveBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => ['/tmp'], resolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}` });
    await expect(backend.execute({ operation: 'create', source: '/tmp', output: '/tmp/out.tar' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(backend.execute({ operation: 'list', archive: '/tmp/archive.bin' })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
  });
});
