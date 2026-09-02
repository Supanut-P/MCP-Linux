import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityService } from '@baitonghub-linux-mcp/capabilities';
import { RemoteFleetRuntime, type RemoteFleetOperation } from './remote-fleet-runtime.js';

const MAX_HOSTS = 20;
const MAX_BASELINE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_PARALLEL = 4;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECTIONS = ['health', 'inventory', 'service-status'] as const;
type DiffSection = (typeof SECTIONS)[number];

export interface RemoteFleetDiffInput {
  readonly hostIds: readonly string[];
  readonly baseline: unknown;
  readonly maxParallel?: number;
}

export interface RemoteFleetDiffHost {
  readonly hostId: string;
  readonly status: 'changed' | 'unchanged' | 'unavailable';
  readonly baselinePresent: boolean;
  readonly currentStatus: 'ok' | 'error';
  readonly changedSections: readonly DiffSection[];
}

export interface RemoteFleetDiffOutput {
  readonly operation: 'remote_fleet_diff';
  readonly hosts: readonly RemoteFleetDiffHost[];
  readonly summary: {
    readonly requested: number;
    readonly changed: number;
    readonly unchanged: number;
    readonly unavailable: number;
    readonly maxParallel: number;
  };
}

export interface RemoteFleetDiffServiceOptions {
  readonly capabilities?: Pick<CapabilityService, 'execute'>;
  readonly runtime?: Pick<RemoteFleetRuntime, 'execute'>;
}

/** Compares a prior bounded remote_fleet snapshot with a fresh read-only snapshot. */
export class RemoteFleetDiffService {
  private readonly runtime: Pick<RemoteFleetRuntime, 'execute'>;

  public constructor(options: RemoteFleetDiffServiceOptions) {
    this.runtime = options.runtime ?? new RemoteFleetRuntime(options.capabilities);
  }

  public async execute(input: RemoteFleetDiffInput, signal?: AbortSignal): Promise<Result<RemoteFleetDiffOutput>> {
    const parsed = validateInput(input);
    if (!parsed.ok) return parsed;
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Remote fleet diff was cancelled', true));

    const current = await this.runtime.execute({
      hostIds: parsed.value.hostIds,
      operation: 'snapshot',
      maxParallel: parsed.value.maxParallel,
    }, signal);
    if (!current.ok) return current;
    const hosts = isRecord(current.value) && Array.isArray(current.value.hosts) ? current.value.hosts : [];
    const baseline = parsed.value.baseline;
    const outputHosts = parsed.value.hostIds.map((hostId) => compareHost(hostId, baseline, hosts));
    const changed = outputHosts.filter((host) => host.status === 'changed').length;
    const unchanged = outputHosts.filter((host) => host.status === 'unchanged').length;
    const unavailable = outputHosts.length - changed - unchanged;
    const output: RemoteFleetDiffOutput = {
      operation: 'remote_fleet_diff',
      hosts: outputHosts,
      summary: { requested: outputHosts.length, changed, unchanged, unavailable, maxParallel: parsed.value.maxParallel },
    };
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_OUTPUT_BYTES) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote fleet diff exceeded the size limit', true));
    return ok(output);
  }
}

interface NormalizedInput {
  readonly hostIds: readonly string[];
  readonly baseline: Record<string, unknown>;
  readonly maxParallel: number;
}

interface SnapshotHost {
  readonly hostId: string;
  readonly status: 'ok' | 'error';
  readonly value?: unknown;
}

function validateInput(input: RemoteFleetDiffInput): Result<NormalizedInput> {
  if (!isRecord(input) || !Array.isArray(input.hostIds) || !isRecord(input.baseline)) return err(appError('INVALID_INPUT', 'Remote fleet diff input is invalid', false));
  let encoded: string;
  try { encoded = JSON.stringify(input.baseline); } catch { return err(appError('INVALID_INPUT', 'Remote fleet diff baseline is invalid', false)); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BASELINE_BYTES) return err(appError('INVALID_INPUT', 'Remote fleet diff baseline is too large', false));
  const hostIds = input.hostIds.filter((value): value is string => typeof value === 'string').map((value) => value.trim());
  if (hostIds.length !== input.hostIds.length || hostIds.length < 1 || hostIds.length > MAX_HOSTS || hostIds.some((value) => !HOST_ID.test(value)) || new Set(hostIds).size !== hostIds.length) {
    return err(appError('INVALID_INPUT', 'Remote fleet diff hostIds must contain 1-20 unique registered host IDs', false));
  }
  const maxParallel = input.maxParallel ?? MAX_PARALLEL;
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_PARALLEL) return err(appError('INVALID_INPUT', 'Remote fleet diff maxParallel must be between 1 and 4', false));
  if (!validBaseline(input.baseline, hostIds)) return err(appError('INVALID_INPUT', 'Remote fleet diff baseline is invalid', false));
  return ok({ hostIds, baseline: input.baseline, maxParallel });
}

function validBaseline(value: Record<string, unknown>, requested: readonly string[]): boolean {
  if (value.operation !== undefined && value.operation !== 'snapshot') return false;
  if (!Array.isArray(value.hosts) || value.hosts.length > MAX_HOSTS) return false;
  const seen = new Set<string>();
  for (const candidate of value.hosts) {
    if (!isRecord(candidate) || typeof candidate.hostId !== 'string' || !HOST_ID.test(candidate.hostId) || !requested.includes(candidate.hostId) || seen.has(candidate.hostId)) return false;
    if (candidate.status !== 'ok' && candidate.status !== 'error') return false;
    if (candidate.status === 'ok' && candidate.value !== undefined && !boundedJson(candidate.value)) return false;
    seen.add(candidate.hostId);
  }
  return true;
}

function compareHost(hostId: string, baseline: Record<string, unknown>, currentHosts: readonly unknown[]): RemoteFleetDiffHost {
  const previous = findHost(baseline.hosts, hostId);
  const current = findHost(currentHosts, hostId);
  const baselinePresent = previous !== undefined;
  const currentStatus = current?.status === 'ok' ? 'ok' : 'error';
  if (currentStatus !== 'ok') return { hostId, status: 'unavailable', baselinePresent, currentStatus, changedSections: [] };
  if (previous?.status !== 'ok' || current?.value === undefined || previous.value === undefined) {
    return { hostId, status: baselinePresent ? 'changed' : 'unavailable', baselinePresent, currentStatus, changedSections: [...SECTIONS] };
  }
  const changedSections = SECTIONS.filter((section) => hashSection(previous.value, section) !== hashSection(current.value, section));
  return { hostId, status: changedSections.length === 0 ? 'unchanged' : 'changed', baselinePresent, currentStatus, changedSections };
}

function findHost(value: unknown, hostId: string): SnapshotHost | undefined {
  if (!Array.isArray(value)) return undefined;
  const candidate = value.find((entry) => isRecord(entry) && entry.hostId === hostId);
  if (!isRecord(candidate) || (candidate.status !== 'ok' && candidate.status !== 'error')) return undefined;
  return {
    hostId,
    status: candidate.status,
    ...(candidate.value === undefined ? {} : { value: candidate.value }),
  };
}

function hashSection(value: unknown, section: DiffSection): string {
  const candidate = isRecord(value) ? value[section] : undefined;
  return createHash('sha256').update(stableJson(candidate), 'utf8').digest('hex').slice(0, 32);
}

function stableJson(value: unknown, depth = 0): string {
  if (depth > 8) return '"[depth]"';
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.slice(0, 1000).map((entry) => stableJson(entry, depth + 1)).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().slice(0, 200).map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  return '"[unsupported]"';
}

function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 16_384;
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((entry) => boundedJson(entry, depth + 1));
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length <= 200 && entries.every(([key, entry]) => key.length <= 256 && boundedJson(entry, depth + 1));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { RemoteFleetOperation };
