import { createHash, randomBytes } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { fleetHostFingerprint, fleetWorkspaceFingerprint, type FileActor, type FleetCatalogService, type WorkspaceChangesService } from '@baitonghub-linux-mcp/application';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { RemoteFleetRuntime } from './remote-fleet-runtime.js';
import type { RuntimeMetricsService } from './runtime-metrics-service.js';
import { projectIncidentObservation, validateStoredIncidentData, type IncidentSource } from './incident-projection.js';

type IncidentState = 'collecting' | 'complete' | 'partial' | 'unavailable' | 'interrupted';
interface IncidentRecord { readonly id: string; readonly ownerKey: string; readonly requestFingerprint: string; readonly runToken: string; readonly state: IncidentState; readonly header: unknown; readonly createdAt: number; readonly expiresAt: number; readonly updatedAt: number }
interface Evidence { readonly incidentId: string; readonly sequence: number; readonly hash: string; readonly payload: unknown }
export interface IncidentRepositoryPort {
  get(owner: string, id: string): IncidentRecord | null;
  create(record: IncidentRecord): boolean;
  append(owner: string, id: string, token: string, payload: unknown, now: number): Evidence | null;
  finish(owner: string, id: string, token: string, state: Exclude<IncidentState, 'collecting'>, now: number): boolean;
  listEvidence(owner: string, id: string, afterSequence?: number, limit?: number): readonly Evidence[];
  summary(owner: string, id: string): { readonly count: number; readonly bytes: number } | null;
}
interface Host { readonly id: string; readonly host: string; readonly port: number; readonly username: string; readonly secretRef: string; readonly pinnedFingerprint: string; readonly roots: readonly string[]; readonly createdAt: string }
interface Binding { readonly hostId: string; readonly fingerprint: string | null; readonly status: 'resolved' | 'stale' | 'unavailable' }
interface Header { readonly workspaceId: string; readonly workspaceFingerprint: string; readonly hosts: readonly Binding[]; readonly unit?: string }
interface Request { readonly operation: 'collect' | 'status' | 'report'; readonly incidentId: string; readonly workspaceId?: string; readonly hostIds?: readonly string[]; readonly selectionId?: string; readonly unit?: string; readonly userConfirmed?: boolean; readonly afterSequence?: number; readonly limit?: number }
export interface IncidentServiceOptions {
  readonly repository: IncidentRepositoryPort;
  readonly workspaces: WorkspaceRepository;
  readonly hosts: { get(id: string): Promise<Host | null> };
  readonly fleet?: Pick<RemoteFleetRuntime, 'execute'>;
  readonly catalog?: Pick<FleetCatalogService, 'execute'>;
  readonly metrics?: Pick<RuntimeMetricsService, 'execute'>;
  readonly changes?: Pick<WorkspaceChangesService, 'snapshot'>;
  readonly profileProvider?: () => PermissionProfile;
  /** Test harness injection only; never caller input. Upper bound remains 60 seconds. */
  readonly deadlineMs?: number;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/;
const REMOTE_SOURCES = ['health', 'service-status', 'journal', 'disk_usage'] as const;
const LOCAL_SOURCES = ['local_metrics', 'workspace_changes'] as const;

/** Durable observations only. Repeat collect never replays an external read. */
export class IncidentService {
  private readonly permissions = new DefaultPermissionEngine();
  private readonly deadlineMs: number;
  public constructor(private readonly options: IncidentServiceOptions) {
    this.deadlineMs = options.deadlineMs === undefined ? 60_000 : Math.max(1, Math.min(60_000, Number.isFinite(options.deadlineMs) ? Math.floor(options.deadlineMs) : 60_000));
  }

  public async execute(actor: FileActor, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const deadline = Date.now() + this.deadlineMs;
    try {
      const request = parseRequest(input);
      if (request === null || typeof actor.clientId !== 'string' || !actor.clientId.trim() || actor.clientId.includes('\0') || Buffer.byteLength(actor.clientId) > 512) return invalid();
      const permission = this.authorize(request);
      if (!permission.ok) return permission;
      if (signal?.aborted) return cancelled();
      const owner = hash(actor.clientId);
      const stored = this.options.repository.get(owner, request.incidentId);
      if (request.operation !== 'collect') return stored === null ? invalid() : this.view(request, stored, signal, deadline);
      const fingerprint = hash(JSON.stringify([request.workspaceId, request.hostIds === undefined ? null : [...request.hostIds].sort(), request.selectionId ?? null, request.unit ?? null]));
      if (stored !== null) return stored.requestFingerprint !== fingerprint ? invalid() : this.view({ ...request, operation: 'status' }, stored, signal, deadline);
      const header = await this.bind(actor, request, signal, deadline);
      if (!header.ok) return header;
      if (signal?.aborted) return cancelled();
      const currentPermission = this.authorize(request);
      if (!currentPermission.ok) return currentPermission;
      const now = Date.now();
      if (now >= deadline) return cancelled();
      const entry: IncidentRecord = { id: request.incidentId, ownerKey: owner, requestFingerprint: fingerprint, runToken: randomBytes(32).toString('hex'), state: 'collecting', header: header.value, createdAt: now, expiresAt: deadline, updatedAt: now };
      if (!this.options.repository.create(entry)) {
        const concurrent = this.options.repository.get(owner, request.incidentId);
        return concurrent?.requestFingerprint === fingerprint ? this.view({ ...request, operation: 'status' }, concurrent, signal, deadline) : invalid();
      }
      await this.collect(request, entry, header.value, signal);
      const finalPermission = this.authorize(request);
      if (!finalPermission.ok) return finalPermission;
      if (signal?.aborted) return cancelled();
      const completed = this.options.repository.get(owner, entry.id);
      return completed === null ? invalid() : this.view({ ...request, operation: 'status' }, completed, signal, deadline);
    } catch { return err(appError('INVALID_INPUT', 'Incident request or stored evidence could not be verified')); }
  }

  private authorize(request: Request): Result<void> {
    for (const level of request.operation === 'collect' ? ['READ', 'WRITE'] as const : ['READ'] as const) {
      const decision = this.permissions.decide(this.options.profileProvider?.() ?? permissionProfiles.balanced, { action: `incident_${request.operation}`, level, workspaceId: request.workspaceId ?? '', target: request.incidentId, destructive: false });
      if (decision === 'DENY' || (decision === 'ASK' && request.userConfirmed !== true)) return err(appError(decision === 'DENY' ? 'PERMISSION_DENIED' : 'PERMISSION_REQUIRED', 'Incident access requires current policy permission'));
    }
    return ok(undefined);
  }

  private async bind(actor: FileActor, request: Request, signal: AbortSignal | undefined, deadline: number): Promise<Result<Header>> {
    const workspace = await deadlineRead(() => this.options.workspaces.get(request.workspaceId!), deadline, signal);
    if (Date.now() >= deadline || signal?.aborted) return cancelled();
    if (workspace === null || workspace.archivedAt) return err(appError('WORKSPACE_NOT_FOUND', 'Registered incident workspace was not found'));
    let members: Array<{ hostId: string; status: Binding['status'] }> = request.hostIds?.map(hostId => ({ hostId, status: 'resolved' })) ?? [];
    let unit = request.unit;
    if (request.selectionId !== undefined) {
      const selection = await deadlineRead(async () => await this.options.catalog?.execute(actor, { operation: 'resolve', id: request.selectionId, userConfirmed: request.userConfirmed }, signal) ?? null, deadline, signal);
      if (selection == null || !selection.ok || !record(selection.value) || !Array.isArray(selection.value.members)) return invalid();
      if (selection.value.kind === 'mapping' && (selection.value.workspaceStatus !== 'resolved' || !record(selection.value.mapping))) return invalid();
      members = selection.value.members as typeof members;
      if (record(selection.value.mapping)) {
        if (selection.value.mapping.workspaceId !== workspace.id || typeof selection.value.mapping.serviceUnit !== 'string' || (unit !== undefined && unit !== selection.value.mapping.serviceUnit)) return invalid();
        unit = selection.value.mapping.serviceUnit;
      }
    }
    if (members.length < 1 || members.length > 20 || members.some(member => !record(member) || typeof member.hostId !== 'string' || !ID.test(member.hostId) || !['resolved', 'stale', 'unavailable'].includes(member.status)) || new Set(members.map(member => member.hostId)).size !== members.length || (unit !== undefined && !UNIT.test(unit))) return invalid();
    const bindings: Binding[] = [];
    for (const member of members) {
      if (signal?.aborted) return cancelled();
      const host = await deadlineRead(() => this.options.hosts.get(member.hostId), deadline, signal);
      if (Date.now() >= deadline || signal?.aborted) return cancelled();
      if (request.hostIds !== undefined && host === null) return err(appError('INVALID_INPUT', 'Registered incident host was not found'));
      bindings.push({ hostId: member.hostId, status: host === null ? 'unavailable' : member.status, fingerprint: host === null ? null : fleetHostFingerprint(host) });
    }
    return ok({ workspaceId: workspace.id, workspaceFingerprint: fleetWorkspaceFingerprint(workspace), hosts: bindings, ...(unit === undefined ? {} : { unit }) });
  }

  private async bindingStatus(header: Header, binding?: Binding, deadline = Date.now() + this.deadlineMs, signal?: AbortSignal): Promise<'ok' | 'stale' | 'unavailable'> {
    const workspace = await deadlineRead(() => this.options.workspaces.get(header.workspaceId), deadline, signal);
    if (workspace === null || workspace.archivedAt) return 'unavailable';
    if (fleetWorkspaceFingerprint(workspace) !== header.workspaceFingerprint) return 'stale';
    if (binding === undefined) return 'ok';
    if (binding.status !== 'resolved') return binding.status;
    const host = await deadlineRead(() => this.options.hosts.get(binding.hostId), deadline, signal);
    return host === null ? 'unavailable' : fleetHostFingerprint(host) !== binding.fingerprint ? 'stale' : 'ok';
  }

  private async collect(request: Request, entry: IncidentRecord, header: Header, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1, entry.expiresAt - Date.now()));
    const observe = async (source: IncidentSource, binding?: Binding): Promise<void> => {
      if (controller.signal.aborted || !this.authorize(request).ok) return;
      const before = await boundedRead(async () => ok(await this.bindingStatus(header, binding, entry.expiresAt, controller.signal)), controller.signal);
      if (controller.signal.aborted || !this.authorize(request).ok) return;
      let status: 'ok' | 'stale' | 'unavailable' | 'timeout' = before.ok ? before.value as 'ok' | 'stale' | 'unavailable' : 'timeout';
      let value: unknown;
      if (status === 'ok') {
        const result = await boundedRead(async () => {
          if (source === 'local_metrics') return await this.options.metrics?.execute({ operation: 'snapshot', scopes: ['host', 'runtime', 'tasks'] }, controller.signal) ?? unavailable();
          if (source === 'workspace_changes') return await this.options.changes?.snapshot(header.workspaceId, 17) ?? unavailable();
          if (this.options.fleet === undefined || binding === undefined || ((source === 'service-status' || source === 'journal') && header.unit === undefined)) return unavailable();
          const read = await this.options.fleet.execute({ hostIds: [binding.hostId], operation: source, ...(header.unit === undefined ? {} : { unit: header.unit }), lines: 100, maxParallel: 1 }, controller.signal);
          if (!read.ok || !record(read.value) || !Array.isArray(read.value.hosts)) return unavailable();
          const member = read.value.hosts[0];
          if (!record(member) || member.hostId !== binding.hostId || member.status !== 'ok') return record(member) && record(member.error) && member.error.code === 'PROCESS_TIMEOUT' ? cancelled() : unavailable();
          return ok({ value: member.value, truncated: member.truncated === true });
        }, controller.signal);
        if (!result.ok) status = result.error.code === 'PROCESS_TIMEOUT' ? 'timeout' : 'unavailable';
        else value = result.value;
        const after = await boundedRead(async () => ok(await this.bindingStatus(header, binding, entry.expiresAt, controller.signal)), controller.signal);
        if (!after.ok) status = 'timeout';
        else if (after.value !== 'ok') status = after.value as 'stale' | 'unavailable';
      }
      if (controller.signal.aborted || !this.authorize(request).ok) return;
      const remote = binding !== undefined && record(value) ? value : null;
      const projected = status === 'ok' ? projectIncidentObservation(source, remote === null ? value : remote.value) : { data: {}, truncated: false, gap: true };
      const observedAt = new Date().toISOString();
      this.options.repository.append(entry.ownerKey, entry.id, entry.runToken, { source, workspaceId: header.workspaceId, ...(binding === undefined ? {} : { hostId: binding.hostId }), observedAt, sourceTime: null, status, truncated: projected.truncated || remote?.truncated === true, gap: projected.gap || status !== 'ok', data: projected.data }, Date.now());
    };
    try {
      let index = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const binding = header.hosts[index++];
          if (binding === undefined || controller.signal.aborted) return;
          for (const source of REMOTE_SOURCES) await observe(source, binding);
        }
      };
      await Promise.all([...Array.from({ length: Math.min(4, header.hosts.length) }, () => worker()), ...LOCAL_SOURCES.map(source => observe(source))]);
      if (!this.authorize(request).ok) return;
      const rows = this.options.repository.listEvidence(entry.ownerKey, entry.id, 0, 32);
      // At most 82 observations. Page through all stored rows for final status.
      const all = [...rows];
      while (all.length < 128 && rows.length > 0) {
        const next = this.options.repository.listEvidence(entry.ownerKey, entry.id, all[all.length - 1]!.sequence, 32);
        if (!next.length) break;
        all.push(...next);
      }
      const good = all.filter(row => record(row.payload) && row.payload.status === 'ok' && row.payload.gap === false && row.payload.truncated === false).length;
      const expected = header.hosts.length * REMOTE_SOURCES.length + LOCAL_SOURCES.length;
      const state = controller.signal.aborted ? 'interrupted' : good === expected ? 'complete' : good > 0 ? 'partial' : 'unavailable';
      this.options.repository.finish(entry.ownerKey, entry.id, entry.runToken, state, Date.now());
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort(); }
  }

  private async view(request: Request, entry: IncidentRecord, signal: AbortSignal | undefined, deadline: number): Promise<Result<unknown>> {
    const header = parseHeader(entry.header);
    if (header === null) return invalid();
    const bindings = await Promise.all(header.hosts.map(async binding => ({ hostId: binding.hostId, status: await this.bindingStatus(header, binding, deadline, signal) })));
    const workspaceStatus = await this.bindingStatus(header, undefined, deadline, signal);
    if (signal?.aborted) return cancelled();
    const permission = this.authorize({ ...request, workspaceId: header.workspaceId });
    if (!permission.ok) return permission;
    const summary = this.options.repository.summary(entry.ownerKey, entry.id);
    if (summary === null) return invalid();
    const state = entry.state === 'collecting' && Date.now() > entry.expiresAt ? 'interrupted' : entry.state;
    const retained: Evidence[] = [];
    for (;;) {
      const page = this.options.repository.listEvidence(entry.ownerKey, entry.id, retained.at(-1)?.sequence ?? 0, 32);
      if (!page.length) break;
      retained.push(...page);
      if (retained.length > 128) return invalid();
    }
    if (retained.length !== summary.count || retained.some(row => !validObservation(row.payload, header))) return invalid();
    const keys = retained.map(row => { const payload = row.payload as Record<string, unknown>; return `${payload.hostId ?? ''}:${payload.source}`; });
    if (new Set(keys).size !== keys.length) return invalid();
    const expected = header.hosts.length * REMOTE_SOURCES.length + LOCAL_SOURCES.length;
    const good = retained.filter(row => { const payload = row.payload as Record<string, unknown>; return payload.status === 'ok' && payload.gap === false && payload.truncated === false; }).length;
    if ((state === 'complete' && good !== expected) || (state === 'partial' && (good === 0 || good >= expected)) || (state === 'unavailable' && good !== 0)) return invalid();
    const missing = [...header.hosts.flatMap(binding => REMOTE_SOURCES.map(source => ({ hostId: binding.hostId, source }))), ...LOCAL_SOURCES.map(source => ({ source }))]
      .filter(item => !keys.includes(`${'hostId' in item ? item.hostId : ''}:${item.source}`))
      .map(item => ({ ...item, status: state === 'collecting' ? 'pending' : state === 'interrupted' ? 'interrupted' : 'timeout', gap: true }));
    const rows = request.operation === 'report' ? this.options.repository.listEvidence(entry.ownerKey, entry.id, request.afterSequence ?? 0, request.limit ?? 16) : [];
    return ok({ incidentId: entry.id, state, workspaceId: header.workspaceId, requestFingerprint: entry.requestFingerprint, createdAt: entry.createdAt, expiresAt: entry.expiresAt, updatedAt: entry.updatedAt, hosts: header.hosts.map(binding => binding.hostId), ...(header.unit === undefined ? {} : { unit: header.unit }), expectedSources: expected, retainedSources: summary.count, missingSources: expected - summary.count, retainedBytes: summary.bytes,
      currentBindings: { workspaceStatus, hosts: bindings, registryDeadlineReached: Date.now() >= deadline }, missingObservations: missing,
      ...(request.operation !== 'report' ? {} : { evidence: rows.map(row => ({ reference: { incidentId: entry.id, sequence: row.sequence, hash: row.hash }, observation: row.payload })), nextAfterSequence: rows.length === (request.limit ?? 16) ? rows[rows.length - 1]!.sequence : null, timelineBasis: 'observedAt; provider event times remain unknown' }),
      boundary: 'Durable bounded metadata; raw messages omitted; gaps do not prove absence; current registry checks are not remote physical identity or execution approval; fixed CLI owner is not tenant authentication' });
  }
}

async function boundedRead(read: () => Promise<Result<unknown>>, signal: AbortSignal): Promise<Result<unknown>> {
  if (signal.aborted) return cancelled();
  let onAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<Result<unknown>>(resolve => { onAbort = (): void => resolve(cancelled()); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); });
    if (signal.aborted) return cancelled();
    return await Promise.race([read(), stopped]);
  } catch { return unavailable(); }
  finally { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort); }
}
async function deadlineRead<T>(read: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T | null> {
  if (Date.now() >= deadline || signal?.aborted) return null;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
  try { const result = await boundedRead(async () => ok(await read()), controller.signal); return result.ok ? result.value as T : null; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseRequest(value: unknown): Request | null {
  if (!record(value) || typeof value.incidentId !== 'string' || !ID.test(value.incidentId) || !['collect', 'status', 'report'].includes(String(value.operation))) return null;
  const allowed = value.operation === 'collect' ? ['workspaceId', 'hostIds', 'selectionId', 'unit'] : value.operation === 'report' ? ['afterSequence', 'limit'] : [];
  if (Object.keys(value).some(key => !['operation', 'incidentId', 'userConfirmed', ...allowed].includes(key)) || (value.userConfirmed !== undefined && typeof value.userConfirmed !== 'boolean')) return null;
  if (value.operation === 'collect') {
    if (typeof value.workspaceId !== 'string' || !ID.test(value.workspaceId) || (value.hostIds === undefined) === (value.selectionId === undefined)) return null;
    if (value.selectionId !== undefined && (typeof value.selectionId !== 'string' || !ID.test(value.selectionId))) return null;
    if (value.hostIds !== undefined && (!Array.isArray(value.hostIds) || value.hostIds.length < 1 || value.hostIds.length > 20 || value.hostIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(value.hostIds).size !== value.hostIds.length)) return null;
    if (value.unit !== undefined && (typeof value.unit !== 'string' || !UNIT.test(value.unit))) return null;
  }
  if (value.afterSequence !== undefined && (!Number.isSafeInteger(value.afterSequence) || Number(value.afterSequence) < 0 || Number(value.afterSequence) > 128)) return null;
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 32)) return null;
  return value as unknown as Request;
}
function parseHeader(value: unknown): Header | null {
  if (!record(value) || Object.keys(value).some(key => !['workspaceId', 'workspaceFingerprint', 'hosts', 'unit'].includes(key)) || typeof value.workspaceId !== 'string' || !ID.test(value.workspaceId) || typeof value.workspaceFingerprint !== 'string' || !SHA.test(value.workspaceFingerprint) || !Array.isArray(value.hosts) || value.hosts.length < 1 || value.hosts.length > 20 || (value.unit !== undefined && (typeof value.unit !== 'string' || !UNIT.test(value.unit)))) return null;
  if (value.hosts.some(binding => !record(binding) || Object.keys(binding).some(key => !['hostId', 'fingerprint', 'status'].includes(key)) || typeof binding.hostId !== 'string' || !ID.test(binding.hostId) || !['resolved', 'stale', 'unavailable'].includes(String(binding.status)) || (binding.fingerprint !== null && (typeof binding.fingerprint !== 'string' || !SHA.test(binding.fingerprint))) || (binding.status === 'resolved' && binding.fingerprint === null)) || new Set(value.hosts.map(binding => (binding as Binding).hostId)).size !== value.hosts.length) return null;
  return value as unknown as Header;
}
function validObservation(value: unknown, header: Header): boolean {
  if (!record(value) || Object.keys(value).some(key => !['source', 'workspaceId', 'hostId', 'observedAt', 'sourceTime', 'status', 'truncated', 'gap', 'data'].includes(key)) || value.workspaceId !== header.workspaceId || value.sourceTime !== null || typeof value.observedAt !== 'string' || value.observedAt.length !== 24 || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt || !['ok', 'stale', 'unavailable', 'timeout'].includes(String(value.status)) || typeof value.truncated !== 'boolean' || typeof value.gap !== 'boolean') return false;
  const source = value.source as IncidentSource;
  if (!(REMOTE_SOURCES as readonly string[]).includes(source) && !(LOCAL_SOURCES as readonly string[]).includes(source)) return false;
  if ((REMOTE_SOURCES as readonly string[]).includes(source) ? !header.hosts.some(binding => binding.hostId === value.hostId) : value.hostId !== undefined) return false;
  const emptyGap = value.gap === true && record(value.data) && Object.keys(value.data).length === 0;
  return value.status === 'ok' ? emptyGap || validateStoredIncidentData(source, value.data) : emptyGap;
}
function invalid(): Result<never> { return err(appError('INVALID_INPUT', 'Incident request, owned record or selection is invalid')); }
function unavailable(): Result<never> { return err(appError('CAPABILITY_UNAVAILABLE', 'Incident source unavailable', true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Incident operation cancelled or timed out', true)); }
