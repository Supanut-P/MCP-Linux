import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { capabilityToolNames, type CapabilityToolName } from './index.js';
import { capabilityDescriptors } from './capability-descriptors.js';
import type { CapabilityBackend } from './local-capability-service.js';

interface HealthCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly backends?: Readonly<Partial<Record<CapabilityToolName, CapabilityBackend>>>;
  readonly domCdp?: CapabilityBackend;
  readonly accessibility?: CapabilityBackend;
}

export class HealthCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly backends: Readonly<Partial<Record<CapabilityToolName, CapabilityBackend>>>;
  private readonly domCdp: CapabilityBackend | undefined;
  private readonly accessibility: CapabilityBackend | undefined;

  public constructor(options: HealthCapabilityOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.backends = options.backends ?? {};
    this.domCdp = options.domCdp;
    this.accessibility = options.accessibility;
  }

  public async execute(input: unknown): Promise<Result<unknown>> {
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Health input must be an object'));
    const operation = input.operation === undefined ? 'check_all' : input.operation;
    if (operation !== 'check_all' && operation !== 'check_tool') return err(appError('INVALID_INPUT', 'Health operation is invalid'));
    const tool = input.tool;
    const validatedTool = isCapabilityToolName(tool) ? tool : undefined;
    if (operation === 'check_tool' && validatedTool === undefined) return err(appError('INVALID_INPUT', 'Health tool is required'));
    if (operation === 'check_tool' && validatedTool !== undefined) return ok({ tool: validatedTool, ...(await this.check(validatedTool)) });

    const capabilities: Record<string, unknown> = {};
    for (const name of capabilityToolNames) capabilities[name] = await this.check(name);
    return ok({ capabilities });
  }

  private async check(tool: CapabilityToolName): Promise<Record<string, unknown>> {
    const configuredBackend = this.backends[tool];
    if (configuredBackend !== undefined) return this.describe(tool, await this.checkDelegated(configuredBackend, statusInput(tool)));
    if (tool === 'shell' || tool === 'health' || tool === 'web_fetch') return this.describe(tool, { available: true, ready: true, local: true });
    if (tool === 'system_info' || tool === 'notification' || tool === 'file_dialog' || tool === 'clipboard') {
      return this.describe(tool, { available: this.platform === 'linux', ready: this.platform === 'linux', local: true });
    }
    if (tool === 'journal' || tool === 'service_logs' || tool === 'network') return this.describe(tool, { available: false, ready: false, local: true, reason: 'Backend is not configured' });
    if (tool === 'service' || tool === 'package' || tool === 'schedule' || tool === 'container' || tool === 'archive' || tool === 'dependency_audit') return this.describe(tool, { available: false, ready: false, local: true, reason: 'Backend is not configured' });
    if (tool === 'input_event' || tool === 'vision' || tool === 'window') return this.describe(tool, { available: false, ready: false, local: true, reason: 'Backend is not configured' });
    if (tool === 'dom_cdp') return this.describe(tool, await this.checkDelegated(this.domCdp, { action: 'status' }));
    return this.describe(tool, await this.checkDelegated(this.accessibility, { action: 'status' }));
  }

  private describe(tool: CapabilityToolName, value: Record<string, unknown>): Record<string, unknown> {
    const descriptor = capabilityDescriptors.find((candidate) => candidate.name === tool);
    const metadata = {
      platform: this.platform,
      displayServer: displayServer(this.platform, this.environment),
      provider: typeof value.provider === 'string' ? value.provider : 'local',
      available: value.available === true,
      ready: value.ready === true,
      requiresConsent: value.requiresConsent === true,
      missingDependencies: Array.isArray(value.missingDependencies) ? value.missingDependencies : [],
    };
    return descriptor === undefined
      ? { ...metadata, ...value }
      : {
        availability: descriptor.availability === 'native'
          ? this.platform === 'linux' ? 'linux' : 'optional'
          : descriptor.availability,
        platforms: descriptor.platforms,
        requirements: descriptor.requirements,
        permission: descriptor.permission,
        supportsCancel: descriptor.supportsCancel,
        supportsDryRun: descriptor.supportsDryRun,
        auditTarget: descriptor.auditTarget,
        ...metadata,
        ...value,
      };
  }

  private async checkDelegated(backend: CapabilityBackend | undefined, input: unknown): Promise<Record<string, unknown>> {
    if (backend === undefined) return { available: false, ready: false, local: true, reason: 'Backend is not configured' };
    if (hasHealth(backend)) {
      try { return { ...(await backend.health()), local: true }; } catch { return { available: false, ready: false, local: true, reason: 'Health probe failed' }; }
    }
    const result = await backend.execute(input);
    if (!result.ok) return { available: false, ready: false, local: true, reason: result.error.message };
    const value = isRecord(result.value) ? result.value : {};
    return { available: value.available !== false, ready: value.ready !== false, local: true, ...value };
  }
}

function hasHealth(value: CapabilityBackend): value is CapabilityBackend & { health(): Promise<Record<string, unknown>> } {
  return 'health' in value && typeof value.health === 'function';
}

function statusInput(tool: CapabilityToolName): Readonly<Record<string, unknown>> {
  return ['window', 'input_event'].includes(tool)
    ? { operation: 'status' }
    : { action: 'status' };
}

function displayServer(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== 'linux') return 'headless';
  if (environment.WAYLAND_DISPLAY?.trim()) return 'wayland';
  if (environment.DISPLAY?.trim()) return 'x11';
  return 'headless';
}

function isCapabilityToolName(value: unknown): value is CapabilityToolName {
  return typeof value === 'string' && capabilityToolNames.some((name) => name === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
