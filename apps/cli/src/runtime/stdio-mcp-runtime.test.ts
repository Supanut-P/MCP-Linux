import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@baitonghub-linux-mcp/storage';
import { permissionProfiles } from '@baitonghub-linux-mcp/permissions';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';
import { sharedActivityLeaseDirectoryPath } from '@baitonghub-linux-mcp/mcp-server';

const temporaryRoots: string[] = [];
const TEST_CHECKPOINT_KEY = Buffer.alloc(32, 0x46).toString('base64');

const workspace = {
  id: 'workspace-1',
  displayName: 'fixture',
  rootPath: 'E:\fixture',
  realRootPath: 'E:\fixture',
  createdAt: '2026-08-10T00:00:00.000Z',
};

beforeEach(() => {
  process.env.BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64 = TEST_CHECKPOINT_KEY;
});

afterEach(async () => {
  delete process.env.TUNNEL_CLIENT_PROFILE_DIR;
  delete process.env.BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'linux')('stdio MCP runtime', () => {
  it('does not overwrite the local permission profile when using full tunnel access', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-stdio-profile-'));
    temporaryRoots.push(dataPath);
    const database = new SqliteDatabase(path.join(dataPath, 'baitonghub-linux-mcp.sqlite'));
    new SqliteSettingsRepository(database).set('permission_profile', 'balanced');
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, workspace);
    await runtime.close();

    const verificationDatabase = new SqliteDatabase(path.join(dataPath, 'baitonghub-linux-mcp.sqlite'));
    const profile = new SqliteSettingsRepository(verificationDatabase).get('permission_profile');
    verificationDatabase.close();
    expect(profile).toBe('balanced');
  });

  it('owns and cleans the tunnel-profile activity snapshot for the direct STDIO runtime', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-stdio-activity-'));
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-stdio-profile-'));
    temporaryRoots.push(dataPath, profileDirectory);
    process.env.TUNNEL_CLIENT_PROFILE_DIR = profileDirectory;

    const runtime = createStdioMcpRuntime(dataPath, workspace);
    await runtime.activityReady;
    const leaseDirectory = sharedActivityLeaseDirectoryPath(profileDirectory);
    const [leaseFile] = await readdir(leaseDirectory);
    expect(leaseFile).toBeDefined();
    const leasePath = path.join(leaseDirectory, leaseFile!);
    const initialized = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    expect(initialized).toMatchObject({ version: 2, activeCount: 0, revision: 0, owner: { pid: process.pid } });

    const callId = await runtime.activityTracker.begin('read_file', { path: '/srv/fixture.txt' });
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ activeCount: 1, revision: 1 });
    await runtime.activityTracker.end(callId, 'SUCCESS', 1);
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ activeCount: 0, revision: 2 });

    await runtime.close();
    expect((await readdir(leaseDirectory)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('uses the selected stdio profile and hides broad workspaces when strict roots are enabled', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-stdio-strict-data-'));
    const allowedRaw = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-stdio-strict-allowed-'));
    const outsideRaw = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-stdio-strict-outside-'));
    temporaryRoots.push(dataPath, allowedRaw, outsideRaw);
    const allowed = await realpath(allowedRaw);
    const outside = await realpath(outsideRaw);
    await writeFile(path.join(outside, 'outside.txt'), 'outside', 'utf8');
    const allowedWorkspace = { id: 'allowed-workspace', displayName: 'allowed', rootPath: allowed, realRootPath: allowed, createdAt: '2026-08-22T00:00:00.000Z' };
    const outsideWorkspace = { id: 'outside-workspace', displayName: 'outside', rootPath: outside, realRootPath: outside, createdAt: '2026-08-22T00:00:01.000Z' };
    const database = new SqliteDatabase(path.join(dataPath, 'baitonghub-linux-mcp.sqlite'));
    const repo = new SqliteWorkspaceRepository(database);
    await repo.insert(allowedWorkspace);
    await repo.insert(outsideWorkspace);
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, allowedWorkspace, true, { permissionProfile: 'safe', strictAllowedRoots: [allowed] });
    try {
      expect(runtime.profileProvider()).toEqual(permissionProfiles.safe);
      const listed = await runtime.services.workspaceInfo?.list?.(runtime.actor);
      expect(listed).toMatchObject({ ok: true, value: [expect.objectContaining({ id: 'allowed-workspace' })] });
      const readOutside = await runtime.services.file?.readFile(runtime.actor, undefined, { path: path.join(outside, 'outside.txt') });
      expect(readOutside).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      const shellOutside = await runtime.services.capabilities?.execute('shell', {
        operation: 'run', executable: process.execPath, arguments: ['-e', 'process.exit(0)'], cwd: outside, execution: 'foreground',
      });
      expect(shellOutside).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    } finally {
      await runtime.close();
    }
  });

  it('keeps a shell background task alive across STDIO runtime replacement', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-stdio-durable-'));
    temporaryRoots.push(dataPath);
    const runtimeWorkspace = { ...workspace, rootPath: dataPath, realRootPath: dataPath };
    const database = new SqliteDatabase(path.join(dataPath, 'baitonghub-linux-mcp.sqlite'));
    await new SqliteWorkspaceRepository(database).insert(runtimeWorkspace);
    database.close();
    const firstRuntime = createStdioMcpRuntime(dataPath, runtimeWorkspace, true);
    const capabilities = firstRuntime.services.capabilities;
    expect(capabilities).toBeDefined();
    if (capabilities === undefined) return;

    const started = await capabilities.execute('shell', {
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('stdio-durable'), 350)"],
      cwd: dataPath,
      execution: 'background',
      timeout_seconds: 30,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) {
      await firstRuntime.close();
      return;
    }
    const taskId = String((started.value as Record<string, unknown>).task_id);
    await firstRuntime.close();

    const replacementRuntime = createStdioMcpRuntime(dataPath, runtimeWorkspace, true);
    const replacementCapabilities = replacementRuntime.services.capabilities;
    expect(replacementCapabilities).toBeDefined();
    if (replacementCapabilities === undefined) {
      await replacementRuntime.close();
      return;
    }
    const finished = await replacementCapabilities.execute('shell', { operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(finished).toMatchObject({
      ok: true,
      value: { task_id: taskId, state: 'completed', exit_code: 0, stdout: 'stdio-durable', durable: true },
    });
    await replacementRuntime.close();
  }, 15_000);

  it('keeps the explicit server surface profile separate from permission policy', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-stdio-server-profile-'));
    temporaryRoots.push(dataPath);
    const runtime = createStdioMcpRuntime(dataPath, workspace, true, { permissionProfile: 'safe', serverProfile: 'fleet' });
    try {
      expect(runtime.serverProfile).toBe('fleet');
      expect(runtime.profileProvider()).toEqual(permissionProfiles.safe);
    } finally {
      await runtime.close();
    }
  });
});
