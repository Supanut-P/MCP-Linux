import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointService, FileService, GitService, ProcessService, ProjectService, ProjectSnapshotService, SearchService, WorkspaceInfoService, WorkspaceQueryService } from '@baitonghub-linux-mcp/application';
import { ok, type CommandSpec, type Result } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry, type McpApplicationServices } from '@baitonghub-linux-mcp/mcp-server';
import { SqliteCheckpointRepository, SqliteDatabase, SqliteWorkspaceRepository } from '@baitonghub-linux-mcp/storage';
import { WorkspaceService } from '@baitonghub-linux-mcp/workspace';
import { ArchiveBackend, validateArchiveMembers } from '../../packages/capabilities/src/archive-backend.js';
import { ContainerBackend } from '../../packages/capabilities/src/container-backend.js';
import { DependencyAuditBackend } from '../../packages/capabilities/src/dependency-audit-backend.js';
import { LinuxCommandRunner } from '../../packages/capabilities/src/linux-command-runner.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // Ignore transient cleanup locks on Windows
    }
  }));
});

describe.runIf(process.platform === 'linux')('MCP development flow', () => {
  it('accepts the bounded v0.4 developer operations contract with fake providers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-v04-'));
    temporaryRoots.push(root);
    const composeFile = path.join(root, 'compose.yaml');
    await writeFile(composeFile, 'services:\n  api:\n    image: alpine\n', 'utf8');
    const calls: string[] = [];
    const containerRunner = new LinuxCommandRunner({ allowedExecutables: ['docker'], spawn: async (_executable, args): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => { calls.push(args.join(' ')); return { exitCode: 0, stdout: 'ok\n', stderr: '' }; } });
    const container = new ContainerBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => [root], resolveExecutable: async (): Promise<string> => '/usr/bin/docker', runner: containerRunner });
    await expect(container.execute({ operation: 'compose-config', compose_file: composeFile })).resolves.toMatchObject({ ok: true });
    for (const operation of ['compose-up', 'compose-down'] as const) await expect(container.execute({ operation, compose_file: composeFile, userConfirmed: true })).resolves.toMatchObject({ ok: true });
    for (const operation of ['logs', 'stats', 'restart'] as const) await expect(container.execute({ operation, container: 'api', compose_file: composeFile, userConfirmed: true })).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual(['compose -f ' + composeFile + ' config', 'compose -f ' + composeFile + ' up -d', 'compose -f ' + composeFile + ' down', 'compose -f ' + composeFile + ' logs --tail 100 api', 'compose -f ' + composeFile + ' stats api', 'compose -f ' + composeFile + ' restart api']);
    expect(validateArchiveMembers(['../../escape'])).toMatchObject({ ok: false });
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    const auditRunner = new LinuxCommandRunner({ allowedExecutables: ['pnpm'], spawn: async (): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => ({ exitCode: 0, stdout: JSON.stringify({ vulnerabilities: {} }), stderr: '' }) });
    const audit = new DependencyAuditBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => [root], resolveExecutable: async (): Promise<string> => '/usr/bin/pnpm', runner: auditRunner });
    await expect(audit.execute({ path: root })).resolves.toMatchObject({ ok: true, value: { provider: 'pnpm', packages: [] } });
    const archive = new ArchiveBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => [root], resolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}` });
    await expect(archive.execute({ operation: 'list', archive: path.join(root, 'missing.tar') })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
  });

  it('keeps the complete fixture workflow inside application services', async () => {
    const fixtureRoot = await createFixture();
    const rawDatabaseRoot = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-mcp-db-'));
    temporaryRoots.push(rawDatabaseRoot);
    const databaseRoot = await realpath(rawDatabaseRoot);
    const database = new SqliteDatabase(path.join(databaseRoot, 'state.sqlite'));
    const workspaceRepository = new SqliteWorkspaceRepository(database);
    const checkpointRepository = new SqliteCheckpointRepository(database);
    const workspaceService = new WorkspaceService(workspaceRepository);
    const workspaceResult = await workspaceService.add('Node fixture', fixtureRoot);
    expect(workspaceResult.ok).toBe(true);
    if (!workspaceResult.ok) return;

    const workspaceId = workspaceResult.value.id;
    const actor = { clientId: 'integration-client', clientName: 'integration test' };
    const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository);
    const fileService = new FileService(workspaceRepository, undefined, undefined, { checkpointService });
    const gitService = new GitService(workspaceRepository);
    const processService = new ProcessService(workspaceRepository, {
      projectService: {
        async getCommand(): Promise<Result<CommandSpec>> {
          return ok({ executable: process.execPath, args: ['-e', "process.stdout.write('project-test-pass\\n')"] });
        },
      },
    });
    const projectService = new ProjectService(workspaceRepository);
    const workspaceQuery = new WorkspaceQueryService(workspaceRepository);
    const searchAdapter = {
      async searchText(): Promise<Result<{ matches: { path: string; lineNumber: number; text: string }[]; truncated: boolean }>> {
        return ok({ matches: [{ path: path.join('src', 'app.ts'), lineNumber: 1, text: "export const value = 'before';" }], truncated: false });
      },
      async searchFiles(): Promise<Result<{ files: string[]; truncated: boolean }>> {
        return ok({ files: [path.join('src', 'app.ts')], truncated: false });
      },
    };
    const services: McpApplicationServices = {
      workspaceInfo: new WorkspaceInfoService(workspaceRepository),
      workspaceQuery,
      project: projectService,
      projectSnapshot: new ProjectSnapshotService(workspaceRepository, {
        projectService,
        gitService,
        workspaceQuery,
        processService,
      }),
      file: fileService,
      search: new SearchService(workspaceRepository, searchAdapter),
      git: gitService,
      process: processService,
    };
    const registry = new ToolRegistry(services, actor);

    try {
      const info = await registry.invoke('workspace_info', { workspaceId });
      expect(info).toMatchObject({ structuredContent: { id: workspaceId, realRootPath: fixtureRoot } });

      const search = await registry.invoke('search_text', { workspaceId, query: 'before', glob: 'src/*.ts' });
      expect(search).toMatchObject({ structuredContent: { matches: [{ path: expect.stringContaining('src'), text: expect.stringContaining('before') }] } });

      const read = await registry.invoke('read_file', { workspaceId, path: 'src/app.ts' });
      expect(read).toMatchObject({ structuredContent: { content: "export const value = 'before';\n" } });

      const write = await registry.invoke('write_file', { workspaceId, path: 'src/new-file.ts', content: 'export const created = true;\n' });
      expect(write).toMatchObject({ structuredContent: { path: expect.stringContaining('new-file.ts') } });

      const patch = await registry.invoke('apply_patch', {
        workspaceId,
        files: [{ path: 'src/app.ts', content: "export const value = 'after';\n" }],
      });
      expect(patch).toMatchObject({ structuredContent: { paths: [expect.stringContaining('app.ts')] } });

      const projectTest = await registry.invoke('project_test', { workspaceId });
      expect(projectTest).toMatchObject({ structuredContent: { processId: expect.any(String) } });
      const processId = stringField(projectTest, 'processId');
      const terminal = await waitForTerminalProcess(registry, workspaceId, processId);
      expect(terminal.state).toBe('exited');

      const logs = await registry.invoke('process_logs', { workspaceId, processId, tailLines: 20 });
      expect(logs).toMatchObject({ structuredContent: { entries: [{ text: expect.stringContaining('project-test-pass') }] } });

      const gitStatus = await registry.invoke('git_status', { workspaceId });
      const gitEntries = structuredRecord(gitStatus).entries;
      expect(Array.isArray(gitEntries)).toBe(true);
      expect(gitEntries).toContainEqual(expect.objectContaining({ path: 'src/app.ts' }));

      const gitDiff = await registry.invoke('git_diff', { workspaceId, path: 'src/app.ts' });
      expect(gitDiff).toMatchObject({ structuredContent: { patch: expect.stringContaining("-export const value = 'before';") } });

      const handoff = await registry.invoke('session_handoff', { workspaceId });
      expect(handoff).toMatchObject({
        structuredContent: {
          tracker_excerpt: expect.stringContaining('REAL-TRACKER-PROBE-42'),
          changed_files: expect.arrayContaining(['src/app.ts']),
          prompt: expect.stringContaining('Continue this run in the same chat'),
        },
      });

      const snapshot = await registry.invoke('project_snapshot', { workspaceId });
      expect(snapshot).toMatchObject({
        structuredContent: {
          project: { kind: 'node' },
          git: { changedFiles: expect.any(Number), stagedFiles: expect.any(Number) },
          tree: { entries: expect.arrayContaining([{ path: 'src', type: 'directory' }]) },
          runningProcesses: [],
          recentProcessErrors: [],
          composeFiles: [],
          lockfiles: ['package-lock.json'],
          projectCommands: ['project_test'],
        },
      });
      expect(registry.list().map((tool) => tool.name)).toEqual(expect.arrayContaining(['container', 'archive', 'dependency_audit']));

      const secret = await registry.invoke('read_file', { workspaceId, path: '.env' });
      expect(secret).toMatchObject({ structuredContent: { error: { code: 'SECRET_ACCESS_DENIED' } } });
      expect(await readFile(path.join(fixtureRoot, 'src', 'app.ts'), 'utf8')).toContain("value = 'after'");
    } finally {
      database.close();
    }
  }, 20_000);
});

async function createFixture(): Promise<string> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-mcp-fixture-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'PHASE_PROGRESS.md'), '# Phase tracker\n## Next chat startup probe\nREAL-TRACKER-PROBE-42\n', 'utf8');
  await writeFile(path.join(root, 'src', 'app.ts'), "export const value = 'before';\n", 'utf8');
  await writeFile(path.join(root, '.env'), 'SECRET_NOT_FOR_TOOLS=hidden\n', 'utf8');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'baitonghub-linux-mcp-flow-fixture',
    scripts: { test: "node -e \"process.stdout.write('project-test-pass\\n')\"" },
  }), 'utf8');
  await writeFile(path.join(root, 'package-lock.json'), '{}', 'utf8');
  await execFileAsync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'baitonghub-linux-mcp-test@example.invalid'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'baitonghub-linux-mcp integration'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['add', '--', 'package.json', 'package-lock.json', 'src'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root, windowsHide: true });
  return root;
}

async function waitForTerminalProcess(registry: ToolRegistry, workspaceId: string, processId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await registry.invoke('process_status', { workspaceId, processId });
    const record = structuredRecord(response);
    const state = record.state;
    if (state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out') return record;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for fixture project test');
}

function stringField(response: { readonly structuredContent?: Readonly<Record<string, unknown>> }, field: string): string {
  const value = response.structuredContent?.[field];
  if (typeof value !== 'string') throw new Error(`Missing string field: ${field}`);
  return value;
}

function structuredRecord(response: { readonly structuredContent?: Readonly<Record<string, unknown>> }): Record<string, unknown> {
  if (response.structuredContent === undefined) throw new Error('MCP response did not include structured content');
  return response.structuredContent;
}
