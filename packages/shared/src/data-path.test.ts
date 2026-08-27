import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBaitonghubLinuxMcpDataPath, resolveBaitonghubLinuxMcpPaths } from './data-path.js';

describe('resolveBaitonghubLinuxMcpDataPath', () => {
  it('uses the same explicit override for Desktop and MCP', () => {
    expect(resolveBaitonghubLinuxMcpDataPath({ BAITONGHUB_LINUX_MCP_DATA_PATH: 'D:\\agent-data', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(path.resolve('D:\\agent-data'));
  });

  it('defaults to the per-user roaming AppData baitonghub-linux-mcp directory', () => {
    expect(resolveBaitonghubLinuxMcpDataPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(path.resolve('C:\\Users\\u\\AppData\\Roaming', 'baitonghub-linux-mcp'));
  });

  it('accepts Electron appData as a fallback without embedding a build-machine profile', () => {
    expect(resolveBaitonghubLinuxMcpDataPath({}, 'C:\\Users\\end-user\\AppData\\Roaming')).toBe(path.resolve('C:\\Users\\end-user\\AppData\\Roaming', 'baitonghub-linux-mcp'));
  });

  it('uses XDG data, config, and state directories on Linux', () => {
    expect(resolveBaitonghubLinuxMcpPaths({ HOME: '/home/alice' }, 'linux')).toEqual({
      dataPath: '/home/alice/.local/share/baitonghub-linux-mcp',
      configPath: '/home/alice/.config/baitonghub-linux-mcp',
      statePath: '/home/alice/.local/state/baitonghub-linux-mcp',
    });
  });

  it('honors explicit Linux XDG and application path overrides', () => {
    expect(resolveBaitonghubLinuxMcpPaths({
      HOME: '/home/alice',
      XDG_DATA_HOME: '/srv/data',
      XDG_CONFIG_HOME: '/srv/config',
      XDG_STATE_HOME: '/srv/state',
      BAITONGHUB_LINUX_MCP_DATA_PATH: '/opt/baitonghub/data',
    }, 'linux')).toEqual({
      dataPath: '/opt/baitonghub/data',
      configPath: '/srv/config/baitonghub-linux-mcp',
      statePath: '/srv/state/baitonghub-linux-mcp',
    });
  });
});
