import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { WorkflowRole } from '@baitonghub-linux-mcp/codex';
import type { WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { FileActor, FileService } from './file-service.js';
import { VERIFIED_SKILL_LICENSE, VERIFIED_SKILL_MANIFEST, type VerifiedSkillPin } from './verified-skill-manifest.js';

export type VerifiedSkillMetadata = Omit<VerifiedSkillPin, 'roles'> & { readonly roles: readonly WorkflowRole[] };
export interface VerifiedSkillListRequest {
  readonly workspaceId: string;
  readonly role: WorkflowRole;
  readonly query?: string;
}
export interface VerifiedSkillLoadRequest {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly role: WorkflowRole;
}
export interface VerifiedSkillList {
  readonly workspaceId: string;
  readonly role: WorkflowRole;
  readonly skills: readonly VerifiedSkillMetadata[];
  readonly verification: 'not_checked';
}
export interface LoadedVerifiedSkill extends VerifiedSkillMetadata {
  readonly workspaceId: string;
  readonly role: WorkflowRole;
  readonly rootFingerprint: string;
  readonly licensePath: string;
  readonly licenseSha256: string;
  readonly licenseReviewStatus: 'reviewed';
  readonly reviewScope: 'single_document';
  readonly scriptsLoaded: false;
  readonly hooksLoaded: false;
  readonly permissionsGranted: false;
  readonly content: string;
  readonly verification: 'verified';
}

export class VerifiedSkillRegistryService {
  public constructor(private readonly dependencies: {
    readonly workspaces: WorkspaceRepository;
    readonly files: Pick<FileService, 'readContextFile'>;
  }) {}

  public async list(actor: FileActor, request: VerifiedSkillListRequest, signal?: AbortSignal): Promise<Result<VerifiedSkillList>> {
    void actor;
    if (aborted(signal)) return cancelled();
    if (!validWorkspaceId(request?.workspaceId) || !validRole(request?.role) ||
      (request.query !== undefined && !validQuery(request.query))) return invalid();
    try {
      const workspace = await this.dependencies.workspaces.get(request.workspaceId);
      if (aborted(signal)) return cancelled();
      if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      const query = request.query?.toLocaleLowerCase();
      const skills = VERIFIED_SKILL_MANIFEST
        .filter((skill) => skill.roles.includes(request.role))
        .filter((skill) => query === undefined || `${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query))
        .map(metadata);
      return ok({ workspaceId: request.workspaceId, role: request.role, skills, verification: 'not_checked' });
    } catch {
      return failed();
    }
  }

  public async load(actor: FileActor, request: VerifiedSkillLoadRequest, signal?: AbortSignal): Promise<Result<LoadedVerifiedSkill>> {
    if (aborted(signal)) return cancelled();
    if (!validWorkspaceId(request?.workspaceId) || !validId(request?.skillId) || !validRole(request?.role)) return invalid();
    const pin = VERIFIED_SKILL_MANIFEST.find((skill) => skill.id === request.skillId);
    if (pin === undefined || !pin.roles.includes(request.role)) return invalid();
    try {
      const workspace = await this.dependencies.workspaces.get(request.workspaceId);
      if (aborted(signal)) return cancelled();
      if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      const skillResult = await this.dependencies.files.readContextFile(actor, request.workspaceId, { path: pin.path, maxBytes: 65_536 }, signal);
      if (aborted(signal)) return cancelled();
      if (!skillResult.ok || skillResult.value.status !== 'available' || skillResult.value.sourceSha256 !== pin.sha256) return invalid();
      const licenseResult = await this.dependencies.files.readContextFile(actor, request.workspaceId, { path: VERIFIED_SKILL_LICENSE.path, maxBytes: 16_384 }, signal);
      if (aborted(signal)) return cancelled();
      if (!licenseResult.ok || licenseResult.value.status !== 'available' || licenseResult.value.sourceSha256 !== VERIFIED_SKILL_LICENSE.sha256 ||
        skillResult.value.rootFingerprint !== licenseResult.value.rootFingerprint) return invalid();
      return ok({
        ...metadata(pin), workspaceId: request.workspaceId, role: request.role,
        rootFingerprint: skillResult.value.rootFingerprint, licensePath: VERIFIED_SKILL_LICENSE.path,
        licenseSha256: VERIFIED_SKILL_LICENSE.sha256, licenseReviewStatus: 'reviewed', reviewScope: 'single_document',
        scriptsLoaded: false, hooksLoaded: false, permissionsGranted: false,
        content: skillResult.value.text, verification: 'verified',
      });
    } catch {
      return aborted(signal) ? cancelled() : failed();
    }
  }
}

function metadata(pin: VerifiedSkillPin): VerifiedSkillMetadata { return { ...pin, roles: [...pin.roles] }; }
function validWorkspaceId(value: unknown): value is string { return validId(value); }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128 && !value.includes('\0'); }
function validQuery(value: unknown): value is string { return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 1024 && !value.includes('\0'); }
function validRole(value: unknown): value is WorkflowRole { return value === 'lead' || value === 'worker' || value === 'qa' || value === 'planner'; }
function aborted(signal?: AbortSignal): boolean { return signal?.aborted === true; }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Verified skill request was cancelled', true)); }
function invalid(): Result<never> { return err(appError('INVALID_INPUT', 'Verified skill request could not be validated')); }
function failed(): Result<never> { return err(appError('INTERNAL_ERROR', 'Verified skill source could not be verified', true)); }
