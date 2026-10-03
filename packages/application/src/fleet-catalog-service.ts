import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { WorkspaceRepository, Workspace } from '@baitonghub-linux-mcp/workspace';
import type { FileActor } from './file-service.js';

interface Host {
  readonly id: string; readonly host: string; readonly port: number; readonly username: string;
  readonly secretRef: string; readonly pinnedFingerprint: string; readonly roots: readonly string[]; readonly createdAt: string;
}
interface Entry {
  readonly id: string; readonly ownerKey: string; readonly kind: 'group' | 'mapping'; readonly payload: unknown;
  readonly revision: number; readonly createdAt: string; readonly updatedAt: string;
}
export interface FleetCatalogRepositoryPort {
  get(ownerKey: string, id: string): Entry | null;
  list(ownerKey: string): readonly Entry[];
  put(ownerKey: string, id: string, kind: Entry['kind'], payload: unknown, expectedRevision: number, now: string): Entry | null;
  remove(ownerKey: string, id: string, expectedRevision: number): boolean;
}
interface Binding { readonly hostId: string; readonly fingerprint: string }
interface Payload { readonly hosts: readonly Binding[]; readonly serviceUnit?: string; readonly workspaceId?: string; readonly workspaceFingerprint?: string }
interface Request { readonly operation: 'put_group' | 'put_mapping' | 'list' | 'resolve' | 'remove'; readonly id?: string; readonly expectedRevision?: number; readonly hostIds?: readonly string[]; readonly hostId?: string; readonly serviceUnit?: string; readonly workspaceId?: string; readonly userConfirmed?: boolean }
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/;
const SHA = /^[a-f0-9]{64}$/;

/** Local selection metadata only. Ownership does not create remote host tenancy. */
export class FleetCatalogService {
  private readonly permissions = new DefaultPermissionEngine();
  public constructor(
    private readonly repository: FleetCatalogRepositoryPort,
    private readonly hosts: { get(id: string): Promise<Host | null> },
    private readonly workspaces: WorkspaceRepository,
    private readonly profileProvider: () => PermissionProfile = () => permissionProfiles.balanced,
    private readonly audit?: (event: { readonly ownerKey: string; readonly operation: string; readonly id?: string; readonly revision?: number }) => Promise<void>,
  ) {}

  public async execute(actor: FileActor, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    try {
      const request = parseRequest(input);
      if (request === null || typeof actor.clientId !== 'string' || !actor.clientId.trim() || actor.clientId.includes('\0') || Buffer.byteLength(actor.clientId) > 512) return invalid();
      if (signal?.aborted) return cancelled();
      const ownerKey = hash(actor.clientId);
      const mutating = !['list', 'resolve'].includes(request.operation);
      const authorize = (): Result<void> => {
        for (const level of mutating ? ['READ', 'WRITE'] as const : ['READ'] as const) {
          const decision = this.permissions.decide(this.profileProvider(), { action: `fleet_catalog_${request.operation}`, level, workspaceId: request.workspaceId ?? '', target: request.id ?? '', destructive: false });
          if (decision === 'DENY' || (decision === 'ASK' && request.userConfirmed !== true)) return err(appError(decision === 'DENY' ? 'PERMISSION_DENIED' : 'PERMISSION_REQUIRED', 'Fleet catalog requires current policy permission'));
        }
        return ok(undefined);
      };
      const initialPermission = authorize();
      if (!initialPermission.ok) return initialPermission;
      let result: unknown;
      if (request.operation === 'list') {
        result = { entries: this.repository.list(ownerKey).map(entry => this.project(entry)), boundary: 'Metadata ownership only; registrations remain global' };
      } else if (request.operation === 'put_group' || request.operation === 'put_mapping') {
        const ids = request.operation === 'put_group' ? request.hostIds! : [request.hostId!];
        const bindings: Binding[] = [];
        for (const id of ids) {
          const host = await this.hosts.get(id);
          if (host === null) return err(appError('INVALID_INPUT', 'Registered host was not found'));
          bindings.push({ hostId: id, fingerprint: hostHash(host) });
        }
        let payload: Payload = { hosts: bindings };
        if (request.operation === 'put_mapping') {
          const workspace = await this.workspaces.get(request.workspaceId!);
          if (workspace === null || workspace.archivedAt) return err(appError('WORKSPACE_NOT_FOUND', 'Registered workspace was not found'));
          payload = { ...payload, serviceUnit: request.serviceUnit!, workspaceId: workspace.id, workspaceFingerprint: workspaceHash(workspace) };
        }
        if (signal?.aborted) return cancelled();
        const currentPermission = authorize();
        if (!currentPermission.ok) return currentPermission;
        const stored = this.repository.put(ownerKey, request.id!, request.operation === 'put_group' ? 'group' : 'mapping', payload, request.expectedRevision!, new Date().toISOString());
        if (stored === null) return conflict();
        result = this.project(stored);
      } else {
        const stored = this.repository.get(ownerKey, request.id!);
        if (stored === null) return conflict();
        const payload = parsePayload(stored);
        if (payload === null) return invalid();
        if (request.operation === 'remove') {
          if (!this.repository.remove(ownerKey, stored.id, request.expectedRevision!)) return conflict();
          result = { id: stored.id, removed: true };
        } else {
          const members = [];
          for (const binding of payload.hosts) {
            const current = await this.hosts.get(binding.hostId);
            const status = current === null ? 'unavailable' : hostHash(current) !== binding.fingerprint ? 'stale' : 'resolved';
            members.push({ hostId: binding.hostId, status });
          }
          let workspaceStatus: 'resolved' | 'unavailable' | 'stale' | undefined;
          if (stored.kind === 'mapping') {
            const workspace = await this.workspaces.get(payload.workspaceId!);
            workspaceStatus = workspace === null || workspace.archivedAt ? 'unavailable' : workspaceHash(workspace) !== payload.workspaceFingerprint ? 'stale' : 'resolved';
          }
          if (signal?.aborted) return cancelled();
          const currentPermission = authorize();
          if (!currentPermission.ok) return currentPermission;
          const usable = members.filter(member => member.status === 'resolved');
          result = { ...this.project(stored), members, ...(workspaceStatus === undefined ? {} : { workspaceStatus }),
            resolvedHostIds: stored.kind === 'group' || workspaceStatus === 'resolved' ? usable.map(member => member.hostId) : [],
            ...(stored.kind === 'mapping' && workspaceStatus === 'resolved' && usable.length === 1 ? { mapping: { hostId: usable[0]!.hostId, serviceUnit: payload.serviceUnit, workspaceId: payload.workspaceId } } : {}),
            summary: { resolved: usable.length, stale: members.filter(member => member.status === 'stale').length, unavailable: members.filter(member => member.status === 'unavailable').length },
            boundary: 'Selection only; later operations independently validate current registration and authority' };
        }
      }
      await this.audit?.({ ownerKey, operation: request.operation, ...(request.id === undefined ? {} : { id: request.id }), ...(request.expectedRevision === undefined ? {} : { revision: request.expectedRevision }) });
      if (signal?.aborted) return cancelled();
      const finalPermission = authorize();
      if (!finalPermission.ok) return finalPermission;
      return ok(result);
    } catch { return err(appError('INVALID_INPUT', 'Fleet catalog state or request could not be verified')); }
  }
  private project(entry: Entry): { id: string; kind: Entry['kind']; revision: number; createdAt: string; updatedAt: string } {
    if (parsePayload(entry) === null) throw new Error('Invalid catalog payload');
    return { id: entry.id, kind: entry.kind, revision: entry.revision, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function hostHash(host: Host): string { return hash(JSON.stringify([host.id, host.host, host.port, host.username, host.secretRef, host.pinnedFingerprint, [...host.roots], host.createdAt])); }
function workspaceHash(workspace: Workspace): string { return hash(JSON.stringify([workspace.id, workspace.rootPath, workspace.realRootPath, workspace.createdAt])); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseRequest(value: unknown): Request | null {
  if (!record(value) || typeof value.operation !== 'string') return null;
  const fields: Record<string, readonly string[]> = { list: [], resolve: ['id'], remove: ['id', 'expectedRevision'], put_group: ['id', 'expectedRevision', 'hostIds'], put_mapping: ['id', 'expectedRevision', 'hostId', 'serviceUnit', 'workspaceId'] };
  const allowed = fields[value.operation];
  if (allowed === undefined || Object.keys(value).some(key => !['operation', 'userConfirmed', ...allowed].includes(key)) || (value.userConfirmed !== undefined && typeof value.userConfirmed !== 'boolean')) return null;
  if (value.operation !== 'list' && (typeof value.id !== 'string' || !ID.test(value.id))) return null;
  if (allowed.includes('expectedRevision') && (typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision >= Number.MAX_SAFE_INTEGER)) return null;
  if (value.operation === 'put_group' && (!Array.isArray(value.hostIds) || value.hostIds.length < 1 || value.hostIds.length > 20 || value.hostIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(value.hostIds).size !== value.hostIds.length)) return null;
  if (value.operation === 'put_mapping' && (typeof value.hostId !== 'string' || !ID.test(value.hostId) || typeof value.workspaceId !== 'string' || !ID.test(value.workspaceId) || typeof value.serviceUnit !== 'string' || !UNIT.test(value.serviceUnit))) return null;
  return value as unknown as Request;
}
function parsePayload(entry: Entry): Payload | null {
  const value = entry.payload;
  if (!record(value) || Object.keys(value).some(key => !['hosts', 'serviceUnit', 'workspaceId', 'workspaceFingerprint'].includes(key)) || !Array.isArray(value.hosts) || value.hosts.length < 1 || value.hosts.length > 20) return null;
  if (value.hosts.some(binding => !record(binding) || Object.keys(binding).some(key => !['hostId', 'fingerprint'].includes(key)) || typeof binding.hostId !== 'string' || !ID.test(binding.hostId) || typeof binding.fingerprint !== 'string' || !SHA.test(binding.fingerprint))) return null;
  if (new Set(value.hosts.map(binding => (binding as Binding).hostId)).size !== value.hosts.length) return null;
  if (entry.kind === 'mapping' ? value.hosts.length !== 1 || typeof value.serviceUnit !== 'string' || !UNIT.test(value.serviceUnit) || typeof value.workspaceId !== 'string' || !ID.test(value.workspaceId) || typeof value.workspaceFingerprint !== 'string' || !SHA.test(value.workspaceFingerprint) : Object.keys(value).length !== 1) return null;
  return value as unknown as Payload;
}
function invalid(): Result<never> { return err(appError('INVALID_INPUT', 'Fleet catalog request or stored payload is invalid')); }
function conflict(): Result<never> { return err(appError('INVALID_INPUT', 'Owned catalog entry, revision or quota does not match')); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Fleet catalog request cancelled', true)); }
