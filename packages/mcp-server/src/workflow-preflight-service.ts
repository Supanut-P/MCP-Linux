import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type { DiagnosticsSnapshotService, DiagnosticsSnapshotOutput } from './diagnostics-snapshot-service.js';
import type { EnvironmentPreflightService } from './environment-preflight-service.js';
import type { WorkspaceSnapshotService, WorkspaceSnapshotUsageOutput } from './workspace-snapshot-service.js';

const MAX_SERIALIZED_BYTES = 128 * 1024;
const MAX_PATH_LENGTH = 4096;
const SAFE_STATUS = new Set(['ready', 'degraded', 'unavailable']);

export interface WorkflowPreflightInput {
  readonly workspaceId?: string | undefined;
  readonly path?: string | undefined;
}

export interface WorkflowPreflightSection {
  readonly available: boolean;
  readonly ready: boolean;
}

export interface WorkflowEnvironmentSection extends WorkflowPreflightSection {
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

export interface WorkflowDiagnosticsSection extends WorkflowPreflightSection {
  readonly status: 'ready' | 'degraded' | 'unavailable';
  readonly health: DiagnosticsSnapshotOutput['health'];
  readonly runtime: DiagnosticsSnapshotOutput['runtime'];
  readonly audit: DiagnosticsSnapshotOutput['audit'];
  readonly dependencies: DiagnosticsSnapshotOutput['dependencies'];
}

export interface WorkflowWorkspaceSection extends WorkflowPreflightSection {
  readonly workspaceId: string;
  readonly path: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly scannedEntries: number;
  readonly truncated: boolean;
}

export interface WorkflowPreflightOutput {
  readonly operation: 'workflow_preflight';
  readonly status: 'ready' | 'degraded' | 'unavailable';
  readonly environment: WorkflowEnvironmentSection;
  readonly diagnostics: WorkflowDiagnosticsSection;
  readonly workspace?: WorkflowWorkspaceSection;
}

export interface WorkflowPreflightServiceOptions {
  readonly environmentPreflight?: Pick<EnvironmentPreflightService, 'execute'>;
  readonly diagnosticsSnapshot?: Pick<DiagnosticsSnapshotService, 'execute'>;
  readonly workspaceSnapshot?: Pick<WorkspaceSnapshotService, 'execute'>;
}

/** Composes bounded readiness providers without adding authority of its own. */
export class WorkflowPreflightService {
  public constructor(private readonly options: WorkflowPreflightServiceOptions = {}) {}

  public async execute(actor: FileActor, input: WorkflowPreflightInput = {}, signal?: AbortSignal): Promise<Result<WorkflowPreflightOutput>> {
    const normalized = normalizeInput(input);
    if (!normalized.ok) return normalized;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workflow preflight was cancelled', true));
    const hasWorkspace = normalized.value.workspaceId !== undefined;
    if (this.options.environmentPreflight === undefined && this.options.diagnosticsSnapshot === undefined && (!hasWorkspace || this.options.workspaceSnapshot === undefined)) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Workflow preflight providers are unavailable', true));
    }

    const [environment, diagnostics, workspace] = await Promise.all([
      this.readEnvironment(signal),
      this.readDiagnostics(actor, signal),
      hasWorkspace ? this.readWorkspace(actor, normalized.value, signal) : Promise.resolve(undefined),
    ]);
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Workflow preflight was cancelled', true));
    const sections: WorkflowPreflightSection[] = [environment, diagnostics];
    if (workspace !== undefined) sections.push(workspace);
    const status = sections.every((section) => section.ready)
      ? 'ready'
      : sections.some((section) => section.available || section.ready)
        ? 'degraded'
        : 'unavailable';
    const output: WorkflowPreflightOutput = {
      operation: 'workflow_preflight',
      status,
      environment,
      diagnostics,
      ...(workspace === undefined ? {} : { workspace }),
    };
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_SERIALIZED_BYTES) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Workflow preflight result exceeded the size limit', true));
    }
    return ok(output);
  }

  private async readEnvironment(signal?: AbortSignal): Promise<WorkflowEnvironmentSection> {
    if (this.options.environmentPreflight === undefined || signal?.aborted === true) return unavailableEnvironment();
    try {
      const result = await this.options.environmentPreflight.execute(signal);
      return result.ok ? projectEnvironment(result.value) : unavailableEnvironment();
    } catch {
      return unavailableEnvironment();
    }
  }

  private async readDiagnostics(actor: FileActor, signal?: AbortSignal): Promise<WorkflowDiagnosticsSection> {
    if (this.options.diagnosticsSnapshot === undefined || signal?.aborted === true) return unavailableDiagnostics();
    try {
      const result = await this.options.diagnosticsSnapshot.execute(actor, signal);
      return result.ok ? projectDiagnostics(result.value) : unavailableDiagnostics();
    } catch {
      return unavailableDiagnostics();
    }
  }

  private async readWorkspace(actor: FileActor, input: NormalizedInput, signal?: AbortSignal): Promise<WorkflowWorkspaceSection> {
    if (this.options.workspaceSnapshot === undefined || input.workspaceId === undefined || signal?.aborted === true) return unavailableWorkspace(input);
    try {
      const result = await this.options.workspaceSnapshot.execute(actor, {
        workspaceId: input.workspaceId,
        operation: 'usage',
        ...(input.path === undefined ? {} : { path: input.path }),
      }, signal);
      if (!result.ok || !isUsage(result.value)) return unavailableWorkspace(input);
      return {
        available: true,
        ready: !result.value.truncated,
        workspaceId: result.value.workspaceId,
        path: result.value.path,
        fileCount: result.value.fileCount,
        totalBytes: result.value.totalBytes,
        scannedEntries: result.value.scannedEntries,
        truncated: result.value.truncated,
      };
    } catch {
      return unavailableWorkspace(input);
    }
  }
}

interface NormalizedInput {
  readonly workspaceId?: string;
  readonly path?: string;
}

function normalizeInput(input: WorkflowPreflightInput): Result<NormalizedInput> {
  if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Workflow preflight input is invalid'));
  if (Object.keys(input).some((key) => key !== 'workspaceId' && key !== 'path')) return err(appError('INVALID_INPUT', 'Workflow preflight input is invalid'));
  const workspaceId = input.workspaceId === undefined ? undefined : typeof input.workspaceId === 'string' && input.workspaceId.trim().length > 0 && input.workspaceId.trim().length <= 128 ? input.workspaceId.trim() : undefined;
  if (input.workspaceId !== undefined && workspaceId === undefined) return err(appError('INVALID_INPUT', 'Workflow preflight workspaceId is invalid'));
  const path = input.path === undefined ? undefined : typeof input.path === 'string' && input.path.length > 0 && input.path.length <= MAX_PATH_LENGTH && !input.path.includes('\0') ? input.path : undefined;
  if (input.path !== undefined && path === undefined) return err(appError('INVALID_INPUT', 'Workflow preflight path is invalid'));
  if (path !== undefined && workspaceId === undefined) return err(appError('INVALID_INPUT', 'Workflow preflight path requires workspaceId'));
  return ok({ ...(workspaceId === undefined ? {} : { workspaceId }), ...(path === undefined ? {} : { path }) });
}

function projectEnvironment(value: unknown): WorkflowEnvironmentSection {
  const source = isRecord(value) ? value : {};
  const capabilities = isRecord(source.capabilities) ? source.capabilities : {};
  const checks = Object.values(capabilities).filter(isRecord);
  const status = safeStatus(source.status);
  const platform = safeText(source.platform, 'unknown', 32);
  const displayServer = safeText(source.displayServer, 'unknown', 32);
  const runtimeSource = isRecord(source.runtime) ? source.runtime : {};
  const runtime = {
    nodeVersion: safeText(runtimeSource.nodeVersion, 'unknown', 32),
    nodeMajor: safeNullableInteger(runtimeSource.nodeMajor),
  };
  const capabilitySource = isRecord(source.capabilities) ? source.capabilities : {};
  const notReady = safeStringArray(capabilitySource.notReady);
  const missingDependencies = safeStringArray(capabilitySource.missingDependencies);
  return {
    available: source.status !== 'unavailable',
    ready: status === 'ready',
    status,
    platform,
    displayServer,
    runtime,
    capabilities: {
      total: safeCount(capabilitySource.total, checks.length),
      available: safeCount(capabilitySource.available, checks.filter((entry) => entry.available === true).length),
      ready: safeCount(capabilitySource.ready, checks.filter((entry) => entry.ready === true).length),
      consentRequired: safeCount(capabilitySource.consentRequired, checks.filter((entry) => entry.requiresConsent === true).length),
      notReady,
      missingDependencies,
    },
  };
}

function projectDiagnostics(value: unknown): WorkflowDiagnosticsSection {
  const source = isRecord(value) ? value : {};
  const status = safeStatus(source.status);
  const health = projectHealth(source.health);
  const runtime = projectRuntime(source.runtime);
  const audit = projectAudit(source.audit);
  const dependencies = projectDependencies(source.dependencies);
  return { available: status !== 'unavailable', ready: status === 'ready', status, health, runtime, audit, dependencies };
}

function projectHealth(value: unknown): DiagnosticsSnapshotOutput['health'] {
  const source = isRecord(value) ? value : {};
  return { available: source.available === true, ready: source.ready === true, unavailableCount: safeCount(source.unavailableCount), consentRequiredCount: safeCount(source.consentRequiredCount), missingDependencies: safeStringArray(source.missingDependencies) };
}

function projectRuntime(value: unknown): DiagnosticsSnapshotOutput['runtime'] {
  const source = isRecord(value) ? value : {};
  return { available: source.available === true, ready: source.ready === true };
}

function projectAudit(value: unknown): DiagnosticsSnapshotOutput['audit'] {
  const source = isRecord(value) ? value : {};
  return { available: source.available === true, ready: source.ready === true, count: safeCount(source.count), truncated: source.truncated === true };
}

function projectDependencies(value: unknown): DiagnosticsSnapshotOutput['dependencies'] {
  const source = isRecord(value) ? value : {};
  return { ready: source.ready === true, missingDependencies: safeStringArray(source.missingDependencies) };
}

function unavailableEnvironment(): WorkflowEnvironmentSection {
  return { available: false, ready: false, status: 'unavailable', platform: 'unknown', displayServer: 'unknown', runtime: { nodeVersion: 'unknown', nodeMajor: null }, capabilities: { total: 0, available: 0, ready: 0, consentRequired: 0, notReady: [], missingDependencies: [] } };
}

function unavailableDiagnostics(): WorkflowDiagnosticsSection {
  return { available: false, ready: false, status: 'unavailable', health: { available: false, ready: false, unavailableCount: 0, consentRequiredCount: 0, missingDependencies: [] }, runtime: { available: false, ready: false }, audit: { available: false, ready: false, count: 0, truncated: false }, dependencies: { ready: false, missingDependencies: [] } };
}

function unavailableWorkspace(input: NormalizedInput): WorkflowWorkspaceSection {
  return { available: false, ready: false, workspaceId: input.workspaceId ?? 'unknown', path: input.path ?? '.', fileCount: 0, totalBytes: 0, scannedEntries: 0, truncated: false };
}

function safeStatus(value: unknown): 'ready' | 'degraded' | 'unavailable' { return typeof value === 'string' && SAFE_STATUS.has(value) ? value as 'ready' | 'degraded' | 'unavailable' : 'unavailable'; }
function safeText(value: unknown, fallback: string, max: number): string { return typeof value === 'string' && value.length <= max ? value : fallback; }
function safeNullableInteger(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeCount(value: unknown, fallback = 0): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : fallback; }
function safeStringArray(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 128).slice(0, 128) : []; }
function isUsage(value: unknown): value is WorkspaceSnapshotUsageOutput { return isRecord(value) && value.operation === 'usage' && typeof value.workspaceId === 'string' && typeof value.path === 'string' && safeCount(value.fileCount) === value.fileCount && safeCount(value.totalBytes) === value.totalBytes && safeCount(value.scannedEntries) === value.scannedEntries && typeof value.truncated === 'boolean'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
