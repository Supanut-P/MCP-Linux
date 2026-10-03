import { describe, expect, it } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import type { McpApplicationServices } from './tools/tool-types.js';
import { ContextEngine, type WorkspaceContextRequest } from './context-engine.js';
import { ContextEconomyRuntime } from './context-economy.js';

const actor = { clientId: 'context-test', clientName: 'context-test' };

describe('packet discovery projection', () => {
  it('keeps case-distinct candidates without reading or committing delivery state', async () => {
    const base = services();
    const economy = new ContextEconomyRuntime();
    const engine = new ContextEngine({ ...base,
      file: { ...base.file!, readFile: async (): Promise<never> => { throw new Error('Discovery must not read content'); } },
      search: { ...base.search!,
        searchText: async (): Promise<ReturnType<typeof ok>> => ok({ matches: [
          { path: 'src/Login.ts', line: 1, text: 'old match must not escape' },
          { path: 'src/login.ts', line: 2, text: 'another old match' },
          { path: '.env', line: 1, text: 'excluded private match' },
        ], truncated: false }),
        searchFiles: async (): Promise<ReturnType<typeof ok>> => ok({ paths: ['src/Login.ts', 'src/login.ts', '.env'], truncated: false }),
      },
      git: { ...base.git!, status: async (): Promise<ReturnType<typeof ok>> => ok({ entries: [{ path: '.env', index: 'M', worktree: ' ' }] }) },
    }, actor, economy);
    const result = await engine.discoverPacketCandidates({ workspaceId: 'workspace-1', query: 'login' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.candidates.map((file) => file.path).sort()).toEqual(['src/Login.ts', 'src/login.ts']);
      expect(JSON.stringify(result.value)).not.toContain('old match');
    }
    expect(economy.snapshot().ledgerEntries).toBe(0);
    expect(economy.snapshot().filesDiscovered).toBe(0);
  });

  it('bounds discovery and observes cancellation without returning old text', async () => {
    const engine = new ContextEngine(services(), actor);
    const result = await engine.discoverPacketCandidates({ workspaceId: 'workspace-1', query: 'login', maxCandidates: 1 });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.candidates.length).toBeLessThanOrEqual(1);
    const controller = new AbortController(); controller.abort();
    expect(await engine.discoverPacketCandidates({ workspaceId: 'workspace-1', query: 'login' }, controller.signal)).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(await engine.discoverPacketCandidates({ workspaceId: '', query: 'login' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});

function services(): McpApplicationServices {
  return {
    workspaceInfo: {
      async list(): Promise<ReturnType<typeof ok>> {
        return ok([{ id: 'workspace-1' }, { id: 'workspace-2' }]);
      },
    },
    search: {
      async searchText(_actor, workspaceId, request): Promise<ReturnType<typeof ok>> {
        void request;
        return ok({
          matches: workspaceId === 'workspace-1'
            ? [
              { path: 'src/auth/login.ts', line: 4, text: 'export function login() {}' },
              { path: '.env', line: 1, text: 'LOGIN_SECRET=present' },
              { path: 'node_modules/pkg/index.js', line: 1, text: 'login dependency' },
            ]
            : [{ path: 'dist/login.js', line: 1, text: 'login build' }],
          truncated: false,
        });
      },
      async searchFiles(_actor, workspaceId): Promise<ReturnType<typeof ok>> {
        return ok({
          paths: workspaceId === 'workspace-1'
            ? ['src/auth/login.ts', '.env', '.git/config', 'node_modules/pkg/index.js']
            : ['dist/login.js'],
          truncated: false,
        });
      },
    },
    file: {
      async readFile(_actor, workspaceId, request): Promise<ReturnType<typeof ok>> {
        return ok({
          path: request.path,
          content: `export function ${request.path.replace(/[^a-z]/gi, '')}() {}\nLOGIN_SECRET=present`,
          startLine: 1,
          endLine: 2,
          encoding: 'utf8' as const,
          ...(workspaceId === undefined ? {} : { byteLength: 64 }),
        });
      },
    },
    git: {
      async status(): Promise<ReturnType<typeof ok>> {
        return ok({ entries: [{ path: 'src/auth/login.ts', index: 'M', worktree: ' ' }] });
      },
    },
  };
}

describe('context engine', () => {
  it('aggregates matches across workspaces, ranks candidates, and filters vendor/build paths by default', async () => {
    const request: WorkspaceContextRequest = {
      query: 'login',
      mode: 'exhaustive',
      pageSize: 20,
    };
    const result = await new ContextEngine(services(), actor).collect(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.files.map((file) => file.path);
    expect(paths).toContain('.env');
    expect(paths).not.toContain('.git/config');
    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('dist/login.js');
    expect(paths[0]).toBe('src/auth/login.ts');
    expect(result.value.files[0]?.reason).toContain('text match');
    expect(result.value.symbols.length).toBeGreaterThan(0);
    expect(result.value.matchedFiles).toBeGreaterThanOrEqual(2);

    const explicit = await new ContextEngine(services(), actor).collect({ ...request, includeIgnored: true });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    const explicitPaths = explicit.value.files.map((file) => file.path);
    expect(explicitPaths).toContain('.git/config');
    expect(explicitPaths).toContain('node_modules/pkg/index.js');
    expect(explicitPaths).toContain('dist/login.js');
  });

  it('returns a continuation token without discarding candidates outside the response page', async () => {
    const engine = new ContextEngine(services(), actor);
    const first = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });

    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    expect(first.value.files).toHaveLength(1);
    expect(first.value.hasMore).toBe(true);

    const next = await engine.continue(first.value.continuationToken, 1);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.files).toHaveLength(1);
    expect(next.value.files[0]?.path).not.toBe(first.value.files[0]?.path);
  });

  it('supports cross-workspace search, paged full scans, and parallel many-file reads', async () => {
    const engine = new ContextEngine(services(), actor);
    const search = await engine.searchAll({ query: 'login' });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.value.scannedWorkspaces).toBe(2);
    expect(search.value.paths).toEqual(expect.arrayContaining([
      { workspaceId: 'workspace-1', path: 'src/auth/login.ts' },
    ]));
    expect(search.value.paths).not.toContainEqual({ workspaceId: 'workspace-1', path: '.git/config' });
    expect(search.value.paths).not.toContainEqual({ workspaceId: 'workspace-2', path: 'dist/login.js' });

    const explicitSearch = await engine.searchAll({ query: 'login', includeIgnored: true });
    expect(explicitSearch.ok).toBe(true);
    if (!explicitSearch.ok) return;
    expect(explicitSearch.value.paths).toEqual(expect.arrayContaining([
      { workspaceId: 'workspace-1', path: '.git/config' },
      { workspaceId: 'workspace-2', path: 'dist/login.js' },
    ]));

    const scan = await engine.fullScan({ workspaceId: 'workspace-1', pageSize: 1 });
    expect(scan.ok).toBe(true);
    if (!scan.ok || scan.value.continuationToken === undefined) return;
    expect(scan.value.files).toHaveLength(1);
    const scanNext = await engine.continueFullScan(scan.value.continuationToken, 10);
    expect(scanNext.ok).toBe(true);
    if (!scanNext.ok) return;
    expect(scanNext.value.files.length).toBeGreaterThan(0);

    const many = await engine.readMany({ workspaceId: 'workspace-1', files: [{ path: '.env' }, { path: 'dist/login.js' }] });
    expect(many.ok).toBe(true);
    if (!many.ok) return;
    expect(many.value.totalFiles).toBe(2);
    expect(many.value.failedFiles).toBe(0);
  });

  it('uses the context ledger to avoid resending unchanged files', async () => {
    const engine = new ContextEngine(services(), actor);
    const first = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });
    const second = await engine.collect({ query: 'login', workspaceId: 'workspace-1', pageSize: 1 });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.files[0]?.delivery).toBe('content');
    expect(second.value.files[0]?.delivery).toBe('unchanged');
    expect(second.value.files[0]?.unchangedSince).toBeDefined();
    expect(second.value.economy?.ledgerHits).toBeGreaterThan(0);
    expect(second.value.economy?.previouslySeenBytesAvoided).toBeGreaterThan(0);
  });
});
