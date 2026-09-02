import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserCdpProtocol, BrowserCdpTab } from '../browser-cdp-backend.js';
import { LinuxCommandRunner } from '../linux-command-runner.js';
import { createPlatformCapabilityRuntime } from './runtime-factory.js';

describe('createPlatformCapabilityRuntime', () => {
  it('composes the Linux v0.2 surface once for STDIO and HTTP callers', async () => {
    const runtime = createPlatformCapabilityRuntime({
      dataPath: '/home/alice/.local/share/baitonghub-linux-mcp',
      initialAllowedRoots: ['/home/alice/project'],
      allowedRootsProvider: async () => ['/home/alice/project'],
      workspaceRootProvider: async () => '/home/alice/project',
      unrestricted: true,
      platform: 'linux',
      environment: {},
      browserProtocol: browserProtocol(),
    });

    expect(runtime.service.listTools()).toEqual([
      'shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window',
      'health', 'system_info', 'journal', 'service_logs', 'network', 'service', 'package', 'schedule', 'notification', 'file_dialog', 'clipboard', 'web_fetch', 'container', 'archive', 'dependency_audit', 'remote_host', 'artifact_verify', 'http_probe', 'storage_usage', 'backup',
    ]);
    await expect(runtime.health.execute({ operation: 'check_tool', tool: 'system_info' })).resolves.toMatchObject({
      ok: true,
      value: { platform: 'linux', displayServer: 'headless', provider: 'node+procfs', available: true, ready: true },
    });
  });

  it('dispatches service, package, and schedule calls to their composed backends', async () => {
    const configHome = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-runtime-config-'));
    const calls: string[] = [];
    try {
      const runtime = createPlatformCapabilityRuntime({
        dataPath: path.join(configHome, 'data'), initialAllowedRoots: [configHome], allowedRootsProvider: async (): Promise<readonly string[]> => [configHome], platform: 'linux', environment: { XDG_CONFIG_HOME: configHome }, browserProtocol: browserProtocol(),
        adminResolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}`,
        adminRunner: new LinuxCommandRunner({ allowedExecutables: ['systemctl', 'apt-cache', 'apt-get', 'apt', 'dpkg-query'], spawn: async (executable: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => { calls.push(`${executable}:${args.join(' ')}`); return { exitCode: 0, stdout: 'Id=demo.service\nActiveState=active\n', stderr: '' }; } }),
      });
      await expect(runtime.service.execute('service', { operation: 'status', unit: 'demo.service' })).resolves.toMatchObject({ ok: true, value: { properties: { ActiveState: 'active' } } });
      await expect(runtime.service.execute('package', { operation: 'show', packages: ['jq'] })).resolves.toMatchObject({ ok: true, value: { operation: 'show' } });
      await expect(runtime.service.execute('schedule', { operation: 'list' })).resolves.toMatchObject({ ok: true, value: { directory: path.join(configHome, 'systemd', 'user') } });
      expect(calls).toEqual(['/usr/bin/systemctl:show --no-pager --property=Id,Names,Description,LoadState,ActiveState,SubState,UnitFileState,FragmentPath,MainPID,ExecMainStartTimestamp demo.service', '/usr/bin/apt-cache:show jq']);
    } finally { await rm(configHome, { recursive: true, force: true }); }
  });
});

function browserProtocol(): BrowserCdpProtocol {
  return {
    status: async () => ({ ready: false, port: 9222 }),
    listTabs: async (): Promise<readonly BrowserCdpTab[]> => [],
    newTab: async (): Promise<BrowserCdpTab> => { throw new Error('not used'); },
    closeTab: async () => ({}),
    request: async () => ({}),
  };
}
