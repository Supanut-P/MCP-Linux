import path from 'node:path';
import type { Result } from '@baitonghub-linux-mcp/domain';
import {
  BrowserCdpBackend,
  type BrowserCdpProtocol,
} from '../browser-cdp-backend.js';
import { NodeBrowserCdpProtocol } from '../browser-cdp-protocol.js';
import { capabilityToolNamesForPlatform } from '../capability-descriptors.js';
import type { CapabilityToolName } from '../capability-tool-names.js';
import { HealthCapabilityBackend } from '../health-backend.js';
import { LinuxNativeCapabilityBackend, type LinuxAtSpiProvider, type LinuxPortalProvider } from '../linux-native-backend.js';
import { LocalCapabilityService, type CapabilityBackend } from '../local-capability-service.js';
import { ShellCapabilityBackend } from '../shell-backend.js';
import { WebFetchCapabilityBackend } from '../web-fetch-backend.js';
import type { PlatformRuntimeFactory } from './types.js';

export interface PlatformCapabilityRuntime {
  readonly service: LocalCapabilityService;
  readonly health: HealthCapabilityBackend;
}

export interface PlatformCapabilityRuntimeOptions {
  readonly dataPath: string;
  readonly initialAllowedRoots: readonly string[];
  readonly allowedRootsProvider: () => Promise<readonly string[]>;
  readonly unrestricted?: boolean;
  readonly maxSynchronousWaitSecondsProvider?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly portal?: LinuxPortalProvider;
  readonly atSpi?: LinuxAtSpiProvider;
  readonly browserProtocol?: BrowserCdpProtocol;
  readonly browserLauncher?: (url: string | undefined, signal?: AbortSignal) => Promise<Result<unknown>>;
}

/** Linux-headless composition root shared by STDIO and HTTP transports. */
export class DefaultPlatformRuntimeFactory implements PlatformRuntimeFactory<PlatformCapabilityRuntime> {
  public constructor(private readonly options: PlatformCapabilityRuntimeOptions) {}

  public create(): PlatformCapabilityRuntime {
    return createPlatformCapabilityRuntime(this.options);
  }
}

export function createPlatformCapabilityRuntime(options: PlatformCapabilityRuntimeOptions): PlatformCapabilityRuntime {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('Baitonghub-Linux-mcp supports Linux only');
  const environment = options.environment ?? process.env;
  const initialAllowedRoots = options.initialAllowedRoots.length > 0 ? options.initialAllowedRoots : [options.dataPath];
  const shell = new ShellCapabilityBackend({
    allowedRoots: initialAllowedRoots,
    allowedRootsProvider: options.allowedRootsProvider,
    unrestricted: false,
    taskStateDirectory: path.join(options.dataPath, 'background-tasks'),
    ...(options.maxSynchronousWaitSecondsProvider === undefined ? {} : { maxSynchronousWaitSecondsProvider: options.maxSynchronousWaitSecondsProvider }),
  });
  const defaultBrowserProtocol = options.browserProtocol === undefined
    ? new NodeBrowserCdpProtocol({ profileDir: path.join(options.dataPath, 'browser-profile') })
    : undefined;
  const browserProtocol = options.browserProtocol ?? defaultBrowserProtocol!;
  const launcher = options.browserLauncher ?? (defaultBrowserProtocol === undefined
    ? undefined
    : (url: string | undefined, signal?: AbortSignal): Promise<Result<unknown>> => defaultBrowserProtocol.launch(url, signal));
  const domCdp = new BrowserCdpBackend({
    protocol: browserProtocol,
    ...(launcher === undefined ? {} : { launcher }),
  });
  const webFetch = new WebFetchCapabilityBackend();

  return linuxRuntime(options, environment, shell, domCdp, webFetch);
}

function linuxRuntime(
  options: PlatformCapabilityRuntimeOptions,
  environment: Readonly<Record<string, string | undefined>>,
  shell: ShellCapabilityBackend,
  domCdp: BrowserCdpBackend,
  webFetch: WebFetchCapabilityBackend,
): PlatformCapabilityRuntime {
  const nativeOptions = {
    platform: 'linux' as const,
    environment,
    ...(options.portal === undefined ? {} : { portal: options.portal }),
    ...(options.atSpi === undefined ? {} : { atSpi: options.atSpi }),
  };
  const accessibility = new LinuxNativeCapabilityBackend('accessibility', nativeOptions);
  const inputEvent = new LinuxNativeCapabilityBackend('input_event', nativeOptions);
  const vision = new LinuxNativeCapabilityBackend('vision', nativeOptions);
  const window = new LinuxNativeCapabilityBackend('window', nativeOptions);
  const systemInfo = new LinuxNativeCapabilityBackend('system_info', nativeOptions);
  const notification = new LinuxNativeCapabilityBackend('notification', nativeOptions);
  const fileDialog = new LinuxNativeCapabilityBackend('file_dialog', nativeOptions);
  const clipboard = new LinuxNativeCapabilityBackend('clipboard', nativeOptions);
  const backends: Readonly<Partial<Record<CapabilityToolName, CapabilityBackend>>> = {
    dom_cdp: domCdp,
    accessibility,
    input_event: inputEvent,
    vision,
    window,
    system_info: systemInfo,
    notification,
    file_dialog: fileDialog,
    clipboard,
  };
  const health = new HealthCapabilityBackend({ platform: 'linux', environment, backends });
  const service = new LocalCapabilityService({
    shell,
    domCdp,
    accessibility,
    inputEvent,
    vision,
    window,
    health,
    systemInfo,
    notification,
    fileDialog,
    clipboard,
    webFetch,
  }, capabilityToolNamesForPlatform('linux'));
  return { service, health };
}
