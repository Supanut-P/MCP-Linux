import os from 'node:os';
import path from 'node:path';

export interface DataPathEnvironment {
  readonly BAITONGHUB_LINUX_MCP_DATA_PATH?: string;
  readonly BAITONGHUB_LINUX_MCP_CONFIG_PATH?: string;
  readonly BAITONGHUB_LINUX_MCP_STATE_PATH?: string;
  readonly XDG_DATA_HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_STATE_HOME?: string;
  readonly APPDATA?: string;
  readonly USERPROFILE?: string;
  readonly HOME?: string;
}

export interface BaitonghubLinuxMcpPaths {
  readonly dataPath: string;
  readonly configPath: string;
  readonly statePath: string;
}

const APP_DIRECTORY_NAME = 'baitonghub-linux-mcp';

/** Resolve the per-user baitonghub-linux-mcp data directory without embedding a developer profile path. */
export function resolveBaitonghubLinuxMcpDataPath(
  environment: DataPathEnvironment = process.env,
  roamingAppDataFallback?: string,
): string {
  const configured = environment.BAITONGHUB_LINUX_MCP_DATA_PATH?.trim();
  if (configured) return path.resolve(configured);

  const appData = firstNonEmpty(
    environment.APPDATA,
    roamingAppDataFallback,
    environment.USERPROFILE ? path.join(environment.USERPROFILE, 'AppData', 'Roaming') : undefined,
    environment.HOME ? path.join(environment.HOME, 'AppData', 'Roaming') : undefined,
    path.join(os.homedir(), 'AppData', 'Roaming'),
  );
  return path.resolve(appData, APP_DIRECTORY_NAME);
}

/** Resolve the platform-specific data, config, and state roots used by the runtime. */
export function resolveBaitonghubLinuxMcpPaths(
  environment: DataPathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  roamingAppDataFallback?: string,
): BaitonghubLinuxMcpPaths {
  if (platform !== 'linux') {
    const dataPath = resolveBaitonghubLinuxMcpDataPath(environment, roamingAppDataFallback);
    return { dataPath, configPath: dataPath, statePath: dataPath };
  }

  const home = linuxHome(environment);
  return {
    dataPath: resolveLinuxPath(
      environment.BAITONGHUB_LINUX_MCP_DATA_PATH,
      environment.XDG_DATA_HOME,
      path.posix.join(home, '.local', 'share'),
    ),
    configPath: resolveLinuxPath(
      environment.BAITONGHUB_LINUX_MCP_CONFIG_PATH,
      environment.XDG_CONFIG_HOME,
      path.posix.join(home, '.config'),
    ),
    statePath: resolveLinuxPath(
      environment.BAITONGHUB_LINUX_MCP_STATE_PATH,
      environment.XDG_STATE_HOME,
      path.posix.join(home, '.local', 'state'),
    ),
  };
}

function linuxHome(environment: DataPathEnvironment): string {
  const configured = environment.HOME?.trim();
  return path.posix.resolve(configured || os.homedir().replaceAll('\\', '/'));
}

function resolveLinuxPath(
  applicationOverride: string | undefined,
  xdgRoot: string | undefined,
  defaultRoot: string,
): string {
  const configured = applicationOverride?.trim();
  if (configured) return path.posix.resolve(configured);

  const base = xdgRoot?.trim() || defaultRoot;
  return path.posix.resolve(base, APP_DIRECTORY_NAME);
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return path.join(os.homedir(), 'AppData', 'Roaming');
}
