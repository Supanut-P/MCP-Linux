import { appError, err, type Result } from '@baitonghub-linux-mcp/domain';
import { capabilityToolNames, type CapabilityService, type CapabilityToolName } from './capability-tool-names.js';

export interface CapabilityBackend {
  execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>>;
}

export interface LocalCapabilityBackends {
  readonly shell: CapabilityBackend;
  readonly domCdp: CapabilityBackend;
  readonly accessibility: CapabilityBackend;
  readonly inputEvent: CapabilityBackend;
  readonly vision: CapabilityBackend;
  readonly window: CapabilityBackend;
  readonly health: CapabilityBackend;
  readonly systemInfo?: CapabilityBackend;
  readonly journal?: CapabilityBackend;
  readonly network?: CapabilityBackend;
  readonly service?: CapabilityBackend;
  readonly package?: CapabilityBackend;
  readonly schedule?: CapabilityBackend;
  readonly notification?: CapabilityBackend;
  readonly fileDialog?: CapabilityBackend;
  readonly clipboard?: CapabilityBackend;
  readonly webFetch?: CapabilityBackend;
  readonly container?: CapabilityBackend;
  readonly archive?: CapabilityBackend;
  readonly dependencyAudit?: CapabilityBackend;
  readonly remoteHost?: CapabilityBackend;
}

export class LocalCapabilityService implements CapabilityService {
  public constructor(
    private readonly backends: LocalCapabilityBackends,
    private readonly advertisedTools: readonly CapabilityToolName[] = capabilityToolNames,
  ) {}

  public listTools(): readonly CapabilityToolName[] {
    return [...this.advertisedTools];
  }

  public execute(tool: CapabilityToolName, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted === true) {
      return Promise.resolve(err(appError('PROCESS_TIMEOUT', 'Capability operation was cancelled before dispatch', true)));
    }
    const backend = this.backendFor(tool);
    return backend === undefined
      ? Promise.resolve(err(appError('INVALID_INPUT', 'Capability tool is not supported')))
      : backend.execute(input, signal);
  }

  private backendFor(tool: CapabilityToolName): CapabilityBackend | undefined {
    switch (tool) {
      case 'shell': return this.backends.shell;
      case 'dom_cdp': return this.backends.domCdp;
      case 'accessibility': return this.backends.accessibility;
      case 'input_event': return this.backends.inputEvent;
      case 'vision': return this.backends.vision;
      case 'window': return this.backends.window;
      case 'health': return this.backends.health;
      case 'system_info': return this.backends.systemInfo;
      case 'journal': return this.backends.journal;
      case 'network': return this.backends.network;
      case 'service': return this.backends.service;
      case 'package': return this.backends.package;
      case 'schedule': return this.backends.schedule;
      case 'notification': return this.backends.notification;
      case 'file_dialog': return this.backends.fileDialog;
      case 'clipboard': return this.backends.clipboard;
      case 'web_fetch': return this.backends.webFetch;
      case 'container': return this.backends.container;
      case 'archive': return this.backends.archive;
      case 'dependency_audit': return this.backends.dependencyAudit;
      case 'remote_host': return this.backends.remoteHost;
    }
  }
}
