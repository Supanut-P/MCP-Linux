import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { DocumentRuntimeService } from './document-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor = { clientId: 'test-client', clientName: 'test' };

function servicesWithWorkspace(root: string): McpApplicationServices {
  return {
    workspaceInfo: { info: async () => ok({ id: 'ws-1', realRootPath: root, rootPath: root }) },
  } as unknown as McpApplicationServices;
}

async function withWorkspace(run: (root: string, file: string, provider: string) => Promise<void>): Promise<void> {
  // Hosted Windows runners may report TEMP as an 8.3 path (RUNNER~1) while
  // realpath() returns the long form. Keep fixtures canonical like real workspaces.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'baitonghub-linux-mcp-doc-test-')));
  const file = path.join(root, 'sample.pdf');
  await writeFile(file, '%PDF-1.4\n%fake-but-present\n%%EOF\n', 'utf8');
  const provider = path.join(root, 'pdftotext');
  await writeFile(provider, 'stub', 'utf8');
  await run(root, file, provider);
}

describe('DocumentRuntimeService', () => {
  it('extracts PDF layout text through the configured provider', async () => {
    await withWorkspace(async (root, file, provider) => {
      const calls: { provider: string; args: readonly string[] }[] = [];
      const runtime = new DocumentRuntimeService(servicesWithWorkspace(root), actor, {
        pdfProvider: provider,
        pdfRunner: async (resolvedProvider, args): Promise<ReturnType<typeof ok>> => { calls.push({ provider: resolvedProvider, args }); return ok('name  qty\npencil 3\fpen 5'); },
      });
      const result = await runtime.extractTables({ workspaceId: 'ws-1', file_path: file });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'pdf_extract_tables', available: true, workspaceId: 'ws-1', mode: 'layout-text', truncated: false,
        text: 'name  qty\npencil 3\fpen 5',
      } });
      expect(calls).toEqual([{ provider, args: ['-layout', file, '-'] }]);
    });
  });

  it('reports a truthful unavailable state without a PDF provider', async () => {
    await withWorkspace(async (root, file) => {
      const runtime = new DocumentRuntimeService(servicesWithWorkspace(root), actor, { environment: { PATH: '' }, pdfProvider: path.join(root, 'missing-pdftotext') });
      const result = await runtime.extractTables({ workspaceId: 'ws-1', file_path: file });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'pdf_extract_tables', available: false, status: 'optional',
        requirements: ['local PDF provider', 'bounded document size'],
      } });
    });
  });

  it('summarizes PDF structure for inspect_pdf', async () => {
    await withWorkspace(async (root, file, provider) => {
      const runtime = new DocumentRuntimeService(servicesWithWorkspace(root), actor, {
        pdfProvider: provider,
        pdfRunner: async (): Promise<ReturnType<typeof ok>> => ok('page one\fpage two\fpage three'),
      });
      const result = await runtime.inspectPdf({ workspaceId: 'ws-1', file_path: file });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'inspect_pdf', available: true, workspaceId: 'ws-1', pages: 2, preview: expect.stringContaining('page one'),
      } });
    });
  });

  it('rejects paths that escape the registered workspace before invoking a provider', async () => {
    await withWorkspace(async (root, _file, provider) => {
      const outsideName = `${path.basename(root)}-outside.pdf`;
      const outside = path.join(root, '..', outsideName);
      try {
        await writeFile(outside, '%PDF-1.4\n%%EOF\n', 'utf8');
        let calls = 0;
        const runtime = new DocumentRuntimeService(servicesWithWorkspace(root), actor, {
          pdfProvider: provider,
          pdfRunner: async (): Promise<ReturnType<typeof ok>> => { calls += 1; return ok('should not run'); },
        });
        await expect(runtime.extractTables({ workspaceId: 'ws-1', file_path: path.join('..', outsideName) })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
        expect(calls).toBe(0);
      } finally {
        await rm(outside, { force: true });
      }
    });
  });
});
