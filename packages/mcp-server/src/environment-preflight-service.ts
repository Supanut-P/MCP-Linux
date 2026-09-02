import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { capabilityToolNames, type CapabilityService } from '@baitonghub-linux-mcp/capabilities';

const MAX_CAPABILITIES = 64;
const MAX_MISSING_DEPENDENCIES = 128;
const SAFE_PLATFORM = new Set(['linux', 'win32', 'darwin', 'freebsd', 'openbsd', 'android', 'aix', 'sunos']);
const SAFE_DISPLAY_SERVERS = new Set(['wayland', 'x11', 'headless']);

export interface EnvironmentPreflightOutput {
  readonly operation: 'environment_preflight';
  readonly status: 'ready' | 'degraded' | 'unavailable';
  readonly platform: string;
  readonly displayServer: string;
  readonly runtime: { readonly nodeVersion: string; readonly nodeMajor: number | null };
  readonly capabilities: {
    readonly total: number;
    readonly available: number;
    readonly ready: number;
    readonly consentRequired: number;
    readonly notReady: readonly string[];
    readonly missingDependencies: readonly string[];
  };
}

export interface EnvironmentPreflightServiceOptions {
  readonly capabilities?: Pick<CapabilityService, 'execute'>;
  readonly nodeVersion?: string;
}

/** Projects only bounded readiness fields from the existing health provider. */
export class EnvironmentPreflightService {
  private readonly capabilities: Pick<CapabilityService, 'execute'> | undefined;
  private readonly nodeVersion: string;

  public constructor(options: EnvironmentPreflightServiceOptions = {}) {
    this.capabilities = options.capabilities;
    this.nodeVersion = options.nodeVersion ?? process.version;
  }

  public async execute(signal?: AbortSignal): Promise<Result<EnvironmentPreflightOutput>> {
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Environment preflight was cancelled', true));
    if (this.capabilities === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Environment preflight provider is unavailable', true));
    let result: Result<unknown>;
    try {
      result = await this.capabilities.execute('health', { operation: 'check_all' }, signal);
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Environment preflight provider is unavailable', true));
    }
    if (!result.ok) return err(appError('CAPABILITY_UNAVAILABLE', 'Environment preflight provider is unavailable', true));
    const value = isRecord(result.value) ? result.value : undefined;
    const source = value !== undefined && isRecord(value.capabilities) ? value.capabilities : undefined;
    if (source === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Environment preflight provider is unavailable', true));

    const entries = Object.entries(source).filter(([name]) => capabilityToolNames.some((candidate) => candidate === name)).slice(0, MAX_CAPABILITIES);
    const checks = entries.map(([name, raw]) => projectCheck(name, raw));
    const platform = firstSafe(entries, 'platform', SAFE_PLATFORM) ?? 'unknown';
    const displayServer = firstSafe(entries, 'displayServer', SAFE_DISPLAY_SERVERS) ?? 'unknown';
    const available = checks.filter((check) => check.available).length;
    const ready = checks.filter((check) => check.ready).length;
    const consentRequired = checks.filter((check) => check.requiresConsent).length;
    const notReady = checks.filter((check) => !check.ready).map((check) => check.name).slice(0, MAX_CAPABILITIES);
    const missingDependencies = [...new Set(checks.flatMap((check) => check.missingDependencies))].slice(0, MAX_MISSING_DEPENDENCIES);
    const status: EnvironmentPreflightOutput['status'] = checks.length === 0 || available === 0
      ? 'unavailable'
      : ready === checks.length && missingDependencies.length === 0 && consentRequired === 0
        ? 'ready'
        : 'degraded';
    const runtime = runtimeInfo(this.nodeVersion);
    const output: EnvironmentPreflightOutput = {
      operation: 'environment_preflight',
      status,
      platform,
      displayServer,
      runtime,
      capabilities: { total: checks.length, available, ready, consentRequired, notReady, missingDependencies },
    };
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 128 * 1024) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Environment preflight result exceeded the size limit', true));
    }
    return ok(output);
  }
}

interface ProjectedCheck {
  readonly name: string;
  readonly available: boolean;
  readonly ready: boolean;
  readonly requiresConsent: boolean;
  readonly missingDependencies: readonly string[];
}

function projectCheck(name: string, raw: unknown): ProjectedCheck {
  const value = isRecord(raw) ? raw : {};
  const missingDependencies = Array.isArray(value.missingDependencies)
    ? value.missingDependencies.filter((item): item is string => typeof item === 'string' && item.length <= 128).slice(0, MAX_MISSING_DEPENDENCIES)
    : [];
  return {
    name: safeIdentifier(name),
    available: value.available === true,
    ready: value.ready === true,
    requiresConsent: value.requiresConsent === true,
    missingDependencies,
  };
}

function firstSafe(entries: readonly [string, unknown][], field: 'platform' | 'displayServer', allowed: ReadonlySet<string>): string | undefined {
  for (const [, raw] of entries) {
    if (!isRecord(raw) || typeof raw[field] !== 'string') continue;
    const value = raw[field].trim().toLowerCase();
    if (allowed.has(value)) return value;
  }
  return undefined;
}

function runtimeInfo(version: string): EnvironmentPreflightOutput['runtime'] {
  const normalized = /^v\d+\.\d+\.\d+$/.test(version) ? version : 'unknown';
  const match = /^v(\d+)\./.exec(normalized);
  return { nodeVersion: normalized, nodeMajor: match === null ? null : Number(match[1]) };
}

function safeIdentifier(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
