import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import { ReleaseVerifyService, type ReleaseVerifyInput } from './release-verify-service.js';

const actor: FileActor = { clientId: 'test-client', clientName: 'Test Client' };
const workspaceId = 'workspace-1';
const debPath = 'dist/Baitonghub-Linux-mcp-1.24.0-amd64.deb';
const tarPath = 'dist/Baitonghub-Linux-mcp-1.24.0-linux-x64.tar.gz';
const debHash = 'a'.repeat(64);
const tarHash = 'b'.repeat(64);

function fixtureFiles(): Record<string, string> {
  return {
    'dist/BUILD-METADATA.json': JSON.stringify({
      schema: 'baitonghub.release-provenance.v1',
      product: 'Baitonghub-Linux-mcp',
      package: '@baitonghub-linux-mcp/root',
      version: '1.24.0',
      sourceCommit: 'c'.repeat(40),
      sourceDirty: false,
      artifacts: [
        { file: 'Baitonghub-Linux-mcp-1.24.0-amd64.deb', bytes: 10, sha256: debHash },
        { file: 'Baitonghub-Linux-mcp-1.24.0-linux-x64.tar.gz', bytes: 20, sha256: tarHash },
      ],
    }),
    'dist/PROVENANCE-SHA256SUMS': `${debHash}  Baitonghub-Linux-mcp-1.24.0-amd64.deb\n${tarHash}  Baitonghub-Linux-mcp-1.24.0-linux-x64.tar.gz\n`,
    'dist/SBOM.cdx.json': JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ type: 'library', name: 'node', version: '24.0.0' }] }),
  };
}

function input(overrides: Partial<ReleaseVerifyInput> = {}): ReleaseVerifyInput {
  return {
    workspaceId,
    version: '1.24.0',
    metadataPath: 'dist/BUILD-METADATA.json',
    checksumsPath: 'dist/PROVENANCE-SHA256SUMS',
    sbomPath: 'dist/SBOM.cdx.json',
    artifacts: [{ path: debPath, sha256: debHash }, { path: tarPath, sha256: tarHash }],
    ...overrides,
  };
}

function makeService(files = fixtureFiles(), capabilityResult?: Result<unknown>): { service: ReleaseVerifyService; calls: Array<{ tool: string; input: unknown }> } {
  const calls: Array<{ tool: string; input: unknown }> = [];
  const file = {
    readFile: async (_actor: FileActor, _workspace: string | undefined, request: { path: string }): Promise<Result<{ path: string; content: string; startLine: number; endLine: number; encoding: 'utf8'; byteLength: number }>> => {
      const content = files[request.path];
      return content === undefined
        ? { ok: false, error: { code: 'FILE_NOT_FOUND', message: 'missing', recoverable: false } }
        : ok({ path: request.path, content, startLine: 1, endLine: content.split('\n').length, encoding: 'utf8', byteLength: Buffer.byteLength(content) });
    },
  };
  const capabilities = {
    execute: async (tool: string, request: unknown): Promise<Result<unknown>> => {
      calls.push({ tool, input: request });
      if (capabilityResult !== undefined) return capabilityResult;
      const expected = typeof request === 'object' && request !== null && 'expected_sha256' in request && typeof request.expected_sha256 === 'string' ? request.expected_sha256 : '';
      return ok({ matches: true, digest: expected, bytes: 10 });
    },
  };
  return { service: new ReleaseVerifyService({ file, capabilities }), calls };
}

describe('ReleaseVerifyService', () => {
  it('verifies metadata, checksums, SBOM, and artifacts without invoking shell or network', async () => {
    const { service, calls } = makeService();
    const result = await service.execute(actor, input());
    expect(result).toMatchObject({ ok: true, value: {
      operation: 'release_verify', verified: true, version: '1.24.0', sourceCommit: 'c'.repeat(40),
      artifacts: [{ path: debPath, verified: true }, { path: tarPath, verified: true }],
      sbom: { present: true, componentCount: 1 }, reasonCodes: [],
    } });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.tool === 'artifact_verify')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('BUILD-METADATA');
  });

  it('fails closed on checksum, metadata, or SBOM mismatch', async () => {
    const files = fixtureFiles();
    files['dist/PROVENANCE-SHA256SUMS'] = `${'d'.repeat(64)}  Baitonghub-Linux-mcp-1.24.0-amd64.deb\n${tarHash}  Baitonghub-Linux-mcp-1.24.0-linux-x64.tar.gz\n`;
    const { service } = makeService(files);
    await expect(service.execute(actor, input())).resolves.toMatchObject({ ok: true, value: { verified: false, reasonCodes: ['checksum_mismatch'] } });

    const metadata = JSON.parse(files['dist/BUILD-METADATA.json']) as Record<string, unknown>;
    metadata.product = 'Other';
    files['dist/BUILD-METADATA.json'] = JSON.stringify(metadata);
    await expect(service.execute(actor, input())).resolves.toMatchObject({ ok: true, value: { verified: false, reasonCodes: ['metadata_mismatch'] } });

    files['dist/BUILD-METADATA.json'] = fixtureFiles()['dist/BUILD-METADATA.json'];
    files['dist/PROVENANCE-SHA256SUMS'] = fixtureFiles()['dist/PROVENANCE-SHA256SUMS'];
    files['dist/SBOM.cdx.json'] = JSON.stringify({ bomFormat: 'SPDX', specVersion: '1.5', components: [] });
    await expect(service.execute(actor, input())).resolves.toMatchObject({ ok: true, value: { verified: false, reasonCodes: ['sbom_mismatch'] } });
  });

  it('fails closed when artifact_verify reports a digest mismatch', async () => {
    const { service } = makeService(fixtureFiles(), ok({ matches: false, digest: 'e'.repeat(64), bytes: 10 }));
    await expect(service.execute(actor, input())).resolves.toMatchObject({ ok: true, value: { verified: false, reasonCodes: ['artifact_mismatch'] } });
  });

  it('rejects malformed, oversized, duplicate, absolute, and traversal paths', async () => {
    const { service } = makeService();
    await expect(service.execute(actor, input({ artifacts: [] }))).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute(actor, input({ artifacts: [{ path: '/etc/passwd', sha256: debHash }] }))).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute(actor, input({ artifacts: [{ path: '../outside', sha256: debHash }] }))).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute(actor, input({ artifacts: [{ path: debPath, sha256: debHash }, { path: debPath, sha256: debHash }] }))).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('returns a sanitized unavailable result when the verifier provider fails', async () => {
    const { service } = makeService(fixtureFiles(), { ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'private provider detail', recoverable: true } });
    const result = await service.execute(actor, input());
    expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Artifact verification provider is unavailable' } });
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });

  it('fails closed when a manifest exceeds the serialized input limit', async () => {
    const files = fixtureFiles();
    files['dist/BUILD-METADATA.json'] = JSON.stringify({ ...JSON.parse(files['dist/BUILD-METADATA.json']), padding: 'x'.repeat(300_000) });
    const { service } = makeService(files);
    await expect(service.execute(actor, input())).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
