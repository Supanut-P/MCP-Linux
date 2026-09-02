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
import { LinuxObservabilityBackend } from '../linux-observability-backend.js';
import { ServiceLogsBackend } from '../service-logs-backend.js';
import { SystemdBackend } from '../systemd-backend.js';
import { AptBackend } from '../apt-backend.js';
import { ScheduleBackend } from '../schedule-backend.js';
import { LinuxCommandRunner } from '../linux-command-runner.js';
import { LinuxNativeCapabilityBackend, type LinuxAtSpiProvider, type LinuxPortalProvider } from '../linux-native-backend.js';
import { LocalCapabilityService, type CapabilityBackend } from '../local-capability-service.js';
import { ShellCapabilityBackend } from '../shell-backend.js';
import { WebFetchCapabilityBackend } from '../web-fetch-backend.js';
import { ContainerBackend } from '../container-backend.js';
import { ArchiveBackend } from '../archive-backend.js';
import { DependencyAuditBackend } from '../dependency-audit-backend.js';
import { RemoteHostBackend, type RemoteHostRegistry } from '../remote-host-backend.js';
import { OperatorProbeBackend } from '../operator-probe-backend.js';
import { BackupBackend } from '../backup-backend.js';
import type { SecretStore } from '@baitonghub-linux-mcp/shared';
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
  /** Optional fixed command runner seam for deterministic host-level administration tests. */
  readonly adminRunner?: LinuxCommandRunner;
  readonly adminResolveExecutable?: (name: string) => Promise<string | null>;
  readonly remoteHostRegistry?: RemoteHostRegistry;
  readonly secretStore?: SecretStore;
  /** Maps a registered workspace id to its canonical root for read-only probes. */
  readonly workspaceRootProvider?: (workspaceId: string) => Promise<string | null> | string | null;
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
  const systemInfoObservability = new LinuxObservabilityBackend('system_info', nativeOptions);
  const journal = new LinuxObservabilityBackend('journal', nativeOptions);
  const serviceLogs = new ServiceLogsBackend(nativeOptions);
  const network = new LinuxObservabilityBackend('network', nativeOptions);
  const adminOptions = {
    ...nativeOptions,
    ...(options.adminRunner === undefined ? {} : { runner: options.adminRunner }),
    ...(options.adminResolveExecutable === undefined ? {} : { resolveExecutable: options.adminResolveExecutable }),
  };
  const systemdAdmin = new SystemdBackend(adminOptions);
  const packageManager = new AptBackend(adminOptions);
  const schedule = new ScheduleBackend({
    ...adminOptions,
    allowedRootsProvider: options.allowedRootsProvider,
    packagedCliPath: path.join('/opt', 'baitonghub-linux-mcp', 'baitonghub-linux-mcp'),
  });
  const container = new ContainerBackend({ ...adminOptions, allowedRootsProvider: options.allowedRootsProvider });
  const archive = new ArchiveBackend({ ...adminOptions, allowedRootsProvider: options.allowedRootsProvider });
  const dependencyAudit = new DependencyAuditBackend({ ...adminOptions, allowedRootsProvider: options.allowedRootsProvider });
  const remoteHost = new RemoteHostBackend({
    platform: 'linux',
    ...(options.remoteHostRegistry === undefined ? {} : { registry: options.remoteHostRegistry }),
    ...(options.secretStore === undefined ? {} : { secrets: options.secretStore }),
  });
  const operatorProbeOptions = {
    allowedRootsProvider: options.allowedRootsProvider,
    ...(options.workspaceRootProvider === undefined ? {} : { workspaceRootProvider: options.workspaceRootProvider }),
  };
  const artifactVerify = new OperatorProbeBackend('artifact_verify', operatorProbeOptions);
  const httpProbe = new OperatorProbeBackend('http_probe');
  const storageUsage = new OperatorProbeBackend('storage_usage', operatorProbeOptions);
  const backup = new BackupBackend(operatorProbeOptions);
  const notification = new LinuxNativeCapabilityBackend('notification', nativeOptions);
  const fileDialog = new LinuxNativeCapabilityBackend('file_dialog', nativeOptions);
  const clipboard = new LinuxNativeCapabilityBackend('clipboard', nativeOptions);
  const backends: Readonly<Partial<Record<CapabilityToolName, CapabilityBackend>>> = {
    dom_cdp: domCdp,
    accessibility,
    input_event: inputEvent,
    vision,
    window,
    system_info: systemInfoObservability,
    journal,
    service_logs: serviceLogs,
    network,
    service: systemdAdmin,
    package: packageManager,
    schedule,
    notification,
    file_dialog: fileDialog,
    clipboard,
    container,
    archive,
    dependency_audit: dependencyAudit,
    remote_host: remoteHost,
    artifact_verify: artifactVerify,
    http_probe: httpProbe,
    storage_usage: storageUsage,
    backup,
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
    systemInfo: systemInfoObservability,
    journal,
    serviceLogs,
    network,
    service: systemdAdmin,
    package: packageManager,
    schedule,
    notification,
    fileDialog,
    clipboard,
    webFetch,
    container,
    archive,
    dependencyAudit,
    remoteHost,
    artifactVerify,
    httpProbe,
    storageUsage,
    backup,
  }, capabilityToolNamesForPlatform('linux').filter((name) => options.workspaceRootProvider !== undefined || (name !== 'artifact_verify' && name !== 'storage_usage')));
  return { service, health };
}
