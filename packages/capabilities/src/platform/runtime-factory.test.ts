import { describe, expect, it } from 'vitest';
import type { BrowserCdpProtocol, BrowserCdpTab } from '../browser-cdp-backend.js';
import { createPlatformCapabilityRuntime } from './runtime-factory.js';

describe('createPlatformCapabilityRuntime', () => {
  it('composes the Linux surface once for STDIO and HTTP callers', async () => {
    const runtime = createPlatformCapabilityRuntime({
      dataPath: '/home/alice/.local/share/baitonghub-linux-mcp',
      initialAllowedRoots: ['/home/alice/project'],
      allowedRootsProvider: async () => ['/home/alice/project'],
      unrestricted: true,
      platform: 'linux',
      environment: {},
      browserProtocol: browserProtocol(),
    });

    expect(runtime.service.listTools()).toEqual([
      'shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window',
      'health', 'system_info', 'notification', 'file_dialog', 'clipboard', 'web_fetch',
    ]);
    await expect(runtime.health.execute({ operation: 'check_tool', tool: 'system_info' })).resolves.toMatchObject({
      ok: true,
      value: { platform: 'linux', displayServer: 'headless', provider: 'node', available: true, ready: true },
    });
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
