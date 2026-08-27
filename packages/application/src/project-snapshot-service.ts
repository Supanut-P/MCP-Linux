import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { GitStatusResult } from '@baitonghub-linux-mcp/git';
import type { ManagedProcess, ProcessLogResult } from '@baitonghub-linux-mcp/process';
import type { ProjectProfile } from '@baitonghub-linux-mcp/project';
import type { WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { FileActor } from './file-service.js';
import { GitService } from './git-service.js';
import { ProcessService } from './process-service.js';
import { ProjectService } from './project-service.js';
import { WorkspaceQueryService } from './workspace-query-service.js';

export const MAX_SNAPSHOT_TREE_ENTRIES = 200;
export const MAX_SNAPSHOT_PROCESS_ERRORS = 20;
export const MAX_SNAPSHOT_ERROR_BYTES = 1024;

export interface ProjectSnapshotGitSummary {
  readonly repository: boolean;
  readonly changedFiles: number;
  readonly stagedFiles: number;
  readonly clean: boolean;
}

export interface ProjectSnapshotProcessSummary {
  readonly processId: string;
  readonly executable: string;
  readonly state: ManagedProcess['state'];
}

export interface ProjectSnapshotProcessError {
  readonly processId: string;
  readonly message: string;
}

export interface ProjectSnapshot {
  readonly project: ProjectProfile;
  readonly git: ProjectSnapshotGitSummary;
  readonly tree: {
    readonly entries: import('@baitonghub-linux-mcp/filesystem').TreeResult['entries'];
    readonly truncated: boolean;
  };
  readonly runningProcesses: readonly ProjectSnapshotProcessSummary[];
  readonly recentProcessErrors: readonly ProjectSnapshotProcessError[];
}

export interface ProjectSnapshotProcessPort {
  list(actor: FileActor, workspaceId: string): Promise<Result<readonly ManagedProcess[]>>;
  logs(actor: FileActor, workspaceId: string, processId: string, query: { readonly tailLines?: number }): Promise<Result<ProcessLogResult>>;
}

export interface ProjectSnapshotServiceDependencies {
  readonly projectService?: Pick<ProjectService, 'detect'>;
  readonly gitService?: Pick<GitService, 'status'>;
  readonly workspaceQuery?: Pick<WorkspaceQueryService, 'tree'>;
  readonly processService?: ProjectSnapshotProcessPort;
}

export class ProjectSnapshotService {
  private readonly projectService: Pick<ProjectService, 'detect'>;
  private readonly gitService: Pick<GitService, 'status'>;
  private readonly workspaceQuery: Pick<WorkspaceQueryService, 'tree'>;
  private readonly processService: ProjectSnapshotProcessPort;

  public constructor(
    workspaces: WorkspaceRepository,
    dependencies: ProjectSnapshotServiceDependencies = {},
  ) {
    this.projectService = dependencies.projectService ?? new ProjectService(workspaces);
    this.gitService = dependencies.gitService ?? new GitService(workspaces);
    this.workspaceQuery = dependencies.workspaceQuery ?? new WorkspaceQueryService(workspaces);
    this.processService = dependencies.processService ?? new ProcessService(workspaces);
  }

  public async snapshot(actor: FileActor, workspaceId: string): Promise<Result<ProjectSnapshot>> {
    const [project, git, tree, processes] = await Promise.all([
      this.projectService.detect(workspaceId),
      this.gitService.status(actor, workspaceId),
      this.workspaceQuery.tree(actor, workspaceId, { maxDepth: 1, maxEntries: MAX_SNAPSHOT_TREE_ENTRIES }),
      this.processService.list(actor, workspaceId),
    ]);
    if (!project.ok) return project;
    if (!git.ok && git.error.code !== 'GIT_NOT_REPOSITORY') return git;
    if (!tree.ok) return tree;
    if (!processes.ok) return processes;

    const processErrors = await collectProcessErrors(this.processService, actor, workspaceId, processes.value);
    return ok({
      project: project.value,
      git: toGitSummary(git),
      tree: tree.value,
      runningProcesses: processes.value.filter(isRunning).map(toProcessSummary),
      recentProcessErrors: processErrors,
    });
  }
}

function toGitSummary(result: Result<GitStatusResult>): ProjectSnapshotGitSummary {
  if (!result.ok) return { repository: false, changedFiles: 0, stagedFiles: 0, clean: true };
  const stagedFiles = result.value.entries.filter((entry) => entry.indexStatus !== ' ').length;
  return {
    repository: true,
    changedFiles: result.value.entries.length,
    stagedFiles,
    clean: result.value.entries.length === 0,
  };
}

function isRunning(process: ManagedProcess): boolean {
  return process.state === 'starting' || process.state === 'running';
}

function toProcessSummary(process: ManagedProcess): ProjectSnapshotProcessSummary {
  return { processId: process.processId, executable: process.executable, state: process.state };
}

async function collectProcessErrors(
  processService: ProjectSnapshotProcessPort,
  actor: FileActor,
  workspaceId: string,
  processes: readonly ManagedProcess[],
): Promise<readonly ProjectSnapshotProcessError[]> {
  const errors: ProjectSnapshotProcessError[] = [];
  const candidates = processes.filter((process) => process.state === 'failed' || process.state === 'timed_out').slice(-MAX_SNAPSHOT_PROCESS_ERRORS);
  for (const process of candidates) {
    const logs = await processService.logs(actor, workspaceId, process.processId, { tailLines: 20 });
    if (!logs.ok) continue;
    for (const entry of logs.value.entries) {
      if (entry.stream !== 'stderr' || entry.text.trim().length === 0) continue;
      errors.push({ processId: process.processId, message: redactProcessError(entry.text).slice(-MAX_SNAPSHOT_ERROR_BYTES) });
      if (errors.length >= MAX_SNAPSHOT_PROCESS_ERRORS) return errors;
    }
  }
  return errors;
}

function redactProcessError(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}
