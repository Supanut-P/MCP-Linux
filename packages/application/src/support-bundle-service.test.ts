import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { WorkspacePathGuard } from '@baitonghub-linux-mcp/workspace';
import type { Workspace } from '@baitonghub-linux-mcp/workspace';
import { SupportBundleService, type SupportBundleArchivePort, type SupportBundleSources } from './support-bundle-service.js';

async function fixture(): Promise<{ root: string; workspace: Workspace; sources: SupportBundleSources }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-support-'));
  const workspace: Workspace = { id: 'workspace-1', displayName: 'test', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
  return {
    root,
    workspace,
    sources: {
      doctor: async (): Promise<unknown> => ({ status: 'ok', password: 'doctor-secret' }),
      health: async (): Promise<unknown> => ({ status: 'ok', api_key: 'health-secret' }),
      runtime: async (): Promise<unknown> => ({ platform: 'linux', token: 'runtime-secret' }),
      auditSummary: async (): Promise<unknown> => ({ events: [{ message: 'audit-secret' }] }),
      recentErrors: async (): Promise<unknown> => Array.from({ length: 205 }, (_, index) => ({ index, secret: `error-${index}` })),
      packageFiles: async (): Promise<unknown> => ['baitonghub-linux-mcp-node', 'package.json'],
    },
  };
}

function archivePort(captured: { files?: Record<string, string> }): SupportBundleArchivePort {
  return {
    async create(sourceDirectory: string, outputPath: string): Promise<ReturnType<typeof ok>> {
      const files: Record<string, string> = {};
      for (const name of await readdir(sourceDirectory)) files[name] = await readFile(path.join(sourceDirectory, name), 'utf8');
      captured.files = files;
      await import('node:fs/promises').then(({ writeFile }) => writeFile(outputPath, 'archive-bytes'));
      return ok({ bytes: 13 });
    },
  };
}

describe('SupportBundleService', () => {
  it('returns a bounded dry-run preview with a stable hash and no secrets', async () => {
    const value = await fixture();
    try {
      const service = new SupportBundleService({
        workspaceRepository: { get: async (): Promise<Workspace> => value.workspace },
        pathGuard: new WorkspacePathGuard(undefined, { trustedWorkspaceAccess: true }),
        sources: value.sources,
        archive: archivePort({}),
      });

      const result = await service.execute({ workspaceId: 'workspace-1', destination: 'reports/support.tar.gz', include: ['doctor', 'recent-errors'], dry_run: true });

      expect(result).toMatchObject({ ok: true, value: {
        dry_run: true,
        memberNames: ['manifest.json', 'doctor.txt', 'recent-errors.json'],
        maxBytes: 2 * 1024 * 1024,
        maxRecentEvents: 200,
        redactionPolicy: 'audit-redactor-v1',
        previewHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      } });
      expect(JSON.stringify(result)).not.toMatch(/doctor-secret|error-1|password|secret/i);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it('creates a redacted archive only after matching preview confirmation', async () => {
    const value = await fixture();
    const captured: { files?: Record<string, string> } = {};
    try {
      const archive = archivePort(captured);
      const service = new SupportBundleService({
        workspaceRepository: { get: async (): Promise<Workspace> => value.workspace },
        pathGuard: new WorkspacePathGuard(undefined, { trustedWorkspaceAccess: true }),
        sources: value.sources,
        archive,
      });
      const preview = await service.execute({ workspaceId: 'workspace-1', destination: 'reports/support.tar.gz', include: ['doctor', 'health', 'runtime', 'audit-summary', 'recent-errors', 'package-files'], dry_run: true });
      if (!preview.ok) throw new Error('preview failed');

      await expect(service.execute({ workspaceId: 'workspace-1', destination: 'reports/support.tar.gz', include: ['doctor', 'health', 'runtime', 'audit-summary', 'recent-errors', 'package-files'], dry_run: false, previewHash: String(preview.value.previewHash), userConfirmed: true, _approvalReceiptId: 'receipt-1' })).resolves.toMatchObject({ ok: true, value: { path: 'reports/support.tar.gz', receiptId: 'receipt-1', memberCount: 7 } });
      expect(captured.files?.['manifest.json']).toContain('audit-redactor-v1');
      expect(JSON.stringify(captured.files)).not.toMatch(/doctor-secret|health-secret|runtime-secret|audit-secret|error-1|super-secret/i);
      await expect(stat(path.join(value.root, 'reports/support.tar.gz'))).resolves.toMatchObject({ isFile: expect.any(Function) });
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it('fails closed when the redacted bundle exceeds 2 MiB and rejects paths outside the workspace', async () => {
    const value = await fixture();
    const archive = vi.fn(archivePort({}).create);
    try {
      const service = new SupportBundleService({
        workspaceRepository: { get: async (): Promise<Workspace> => value.workspace },
        pathGuard: new WorkspacePathGuard(undefined, { trustedWorkspaceAccess: true }),
        sources: { ...value.sources, runtime: async (): Promise<unknown> => ({ payload: 'x'.repeat(2 * 1024 * 1024) }) },
        archive: { create: archive },
      });
      const preview = await service.execute({ workspaceId: 'workspace-1', destination: 'reports/support.tar.gz', include: ['runtime'], dry_run: true });
      if (!preview.ok) throw new Error('preview failed');
      const oversized = await service.execute({ workspaceId: 'workspace-1', destination: 'reports/support.tar.gz', include: ['runtime'], dry_run: false, previewHash: String(preview.value.previewHash), userConfirmed: true });
      expect(oversized).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
      expect(archive).not.toHaveBeenCalled();
      await expect(service.execute({ workspaceId: 'workspace-1', destination: '../support.tar.gz', include: ['runtime'], dry_run: true })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});
