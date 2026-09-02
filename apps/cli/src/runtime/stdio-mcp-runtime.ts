import path from 'node:path';
import { stat } from 'node:fs/promises';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import {
  CheckpointService,
  CodexService,
  FileService,
  GitService,
  ProcessService,
  ProjectService,
  ProjectSnapshotService,
  SearchService,
  WorkspaceInfoService,
  JsonWorkspaceIndexStore,
  WorkspaceIndexService,
  WorkspaceChangesService,
  WorkspaceQueryService,
  TargetCatalogService,
  SupportBundleService,
  type FileActor,
} from '@baitonghub-linux-mcp/application';
import { AuditService } from '@baitonghub-linux-mcp/audit';
import {
  createPlatformCapabilityRuntime,
  LocalCapabilityService,
} from '@baitonghub-linux-mcp/capabilities';
import { ALLOW_AI_DELETE_SETTING_KEY, DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY, DEFAULT_CODEX_TOOLS_ENABLED, DEFAULT_MCP_CALL_TIMEOUT_MS, DEFAULT_MCP_IDLE_TIMEOUT_MS, DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MCP_POLL_WAIT_SECONDS, DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, USER_SETTING_KEYS, LibsecretSecretStore, loadCheckpointEncryptionKey, parseBooleanSetting, parseCustomPermissionSettings, parseDestructiveAutoApprovalPolicy, parseIntegerSetting, parsePathList, parseStringRecordSetting, type DestructiveAutoApprovalPolicy } from '@baitonghub-linux-mcp/shared';
import {
  EXTENSIONS_SETTINGS_KEY,
  createLocalExtensionsService,
  type ExtensionsService,
} from '@baitonghub-linux-mcp/extensions';
import { ActivityTracker, AuditQueryService, DatabaseRuntimeService, RemoteRolloutRuntime, SharedActivitySnapshotLease, WorkspaceSnapshotService, composeActivitySinks, createFileActivitySink, currentSharedActivityOwner, mcpActivityLogPath, type AuditQueryEvent, type ActivitySink, type ActivitySinkEvent, type McpApplicationServices, type RemoteFleetAuditEvent, type RuntimeTaskSnapshot, type RuntimeTaskState, type ServerProfileName, type WorkspaceSnapshotRootInfo } from '@baitonghub-linux-mcp/mcp-server';
import { permissionProfiles, type PermissionProfile, type PermissionProfileName } from '@baitonghub-linux-mcp/permissions';
import {
  AesGcmCheckpointCipher,
  SqliteAuditRepository,
  SqliteCheckpointRepository,
  SqliteDatabase,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
  SqliteDatabaseTargetRepository,
  SqliteRemoteHostRepository,
  SqliteRemoteRolloutRepository,
} from '@baitonghub-linux-mcp/storage';
import { SecretPolicy, WorkspacePathGuard, WorkspaceService, type Workspace } from '@baitonghub-linux-mcp/workspace';
import { StrictWorkspaceRepository } from './strict-workspace-repository.js';

export interface StdioMcpRuntime {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly extensions: ExtensionsService;
  readonly activityTracker: ActivityTracker;
  readonly activityReady: Promise<void>;
  readonly remoteRolloutReady: Promise<void>;
  readonly profileProvider: () => PermissionProfile;
  readonly serverProfile: ServerProfileName;
  readonly allowAiDeleteProvider: () => boolean;
  readonly destructivePolicyProvider: () => DestructiveAutoApprovalPolicy;
  readonly codexToolsEnabled: boolean;
  close(): Promise<void>;
}

/** Builds Linux STDIO/HTTP MCP services within registered workspace roots. */
export interface StdioMcpRuntimeOptions {
  readonly permissionProfile?: PermissionProfileName;
  readonly serverProfile?: ServerProfileName;
  readonly strictAllowedRoots?: readonly string[];
}

export function createStdioMcpRuntime(
  dataPath: string,
  workspace: Workspace,
  _unrestricted: boolean = false,
  options: StdioMcpRuntimeOptions = {},
): StdioMcpRuntime {
  void _unrestricted;
  const databaseFilename = path.join(dataPath, 'baitonghub-linux-mcp.sqlite');
  const database = new SqliteDatabase(databaseFilename, { backupDirectory: path.join(dataPath, 'backups') });
  const rawWorkspaceRepository = new SqliteWorkspaceRepository(database);
  const workspaceRepository = options.strictAllowedRoots === undefined
    ? rawWorkspaceRepository
    : new StrictWorkspaceRepository(rawWorkspaceRepository, options.strictAllowedRoots);
  const workspaceIndex = new WorkspaceIndexService(workspaceRepository, new JsonWorkspaceIndexStore(path.join(dataPath, 'workspace-index')));
  const workspaceChanges = new WorkspaceChangesService(workspaceIndex);
  const settingsRepository = new SqliteSettingsRepository(database);
  const auditRepository = new SqliteAuditRepository(database);
  const auditService = new AuditService(auditRepository);
  const auditQuery = new AuditQueryService({
    list: async (query, limit): Promise<readonly AuditQueryEvent[]> => auditRepository.listScoped(query, limit),
  });
  const strictRoots = options.strictAllowedRoots !== undefined;
  const effectiveUnrestricted = false;
  const checkpointRepository = new SqliteCheckpointRepository(database, new AesGcmCheckpointCipher(loadCheckpointEncryptionKey(dataPath, {
    // Headless Linux prefers Secret Service/libsecret; an explicit base64 env key
    // remains supported for non-interactive service accounts and CI.
    useLinuxSecretService: process.platform === 'linux',
  })));
  const workspaceService = new WorkspaceService(workspaceRepository);
  const workspaceInfoService = new WorkspaceInfoService(workspaceRepository, workspaceService, effectiveUnrestricted);
  const workspaceSnapshot = new WorkspaceSnapshotService({
    info: async (actor, workspaceId): Promise<Result<WorkspaceSnapshotRootInfo>> => {
      const result = await workspaceInfoService.info(actor, workspaceId);
      return result.ok ? ok({ id: result.value.id, realRootPath: result.value.realRootPath }) : err(result.error);
    },
  });
  const databaseTargets = new SqliteDatabaseTargetRepository(database);
  const remoteHosts = new SqliteRemoteHostRepository(database);
  const targetCatalog = new TargetCatalogService(databaseTargets, remoteHosts);
  const secretStore = new LibsecretSecretStore();
  const profileName = options.permissionProfile ?? 'full';
  const activeProfile = profileName === 'custom' ? customPermissionProfile(settingsRepository) : permissionProfiles[profileName];
  const profileProvider = (): PermissionProfile => activeProfile;
  const serverProfile = options.serverProfile ?? 'full';
  const destructivePolicyProvider = (): DestructiveAutoApprovalPolicy => parseDestructiveAutoApprovalPolicy(
    settingsRepository.get(DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY),
    parseBooleanSetting(settingsRepository.get(ALLOW_AI_DELETE_SETTING_KEY), false),
  );
  const allowAiDeleteProvider = (): boolean => destructivePolicyProvider().approvals.delete_file;

  const projectService = new ProjectService(workspaceRepository);
  const processService = new ProcessService(workspaceRepository, {
    projectService,
    profileProvider,
    defaultTimeoutMsProvider: (): number => parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.processTimeoutMs), DEFAULT_PROCESS_TIMEOUT_MS, 1_000, 4 * 60 * 60_000),
    unrestricted: effectiveUnrestricted,
  });
  const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository, {
    profile: activeProfile,
  });
  const pathGuard = new WorkspacePathGuard(new SecretPolicy(), { unrestricted: effectiveUnrestricted, trustedWorkspaceAccess: !strictRoots });
  const fileService = new FileService(workspaceRepository, pathGuard, undefined, {
    checkpointService,
    profileProvider,
    unrestricted: effectiveUnrestricted,
    trustedWorkspaceAccess: !strictRoots,
    allowDeleteWithoutConfirmation: allowAiDeleteProvider,
    protectCriticalFiles: (): boolean => destructivePolicyProvider().protectCriticalFiles,
    recoverableDelete: (): boolean => destructivePolicyProvider().recoverableDelete,
    recoveryTrashRoot: path.join(dataPath, 'recovery-trash'),
  });
  const gitService = new GitService(workspaceRepository);
  const workspaceQuery = new WorkspaceQueryService(workspaceRepository, pathGuard);
  const extensions = createLocalExtensionsService({
    settingsJson: settingsRepository.get(EXTENSIONS_SETTINGS_KEY),
    workspaceRootProvider: async (): Promise<string> => workspace.realRootPath,
    callTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpCallTimeoutMs), DEFAULT_MCP_CALL_TIMEOUT_MS, 1_000, 60 * 60_000),
    idleTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpIdleTimeoutMs), DEFAULT_MCP_IDLE_TIMEOUT_MS, 30_000, 24 * 60 * 60_000),
  });
  const codexService = new CodexService(workspaceRepository, {
    auditService,
    profileProvider,
  });
  const actor: FileActor = { clientId: 'cli-mcp-stdio', clientName: 'baitonghub-linux-mcp cli MCP' };
  const capabilityService = createStdioCapabilityService(dataPath, workspace.realRootPath, async () => {
    const listed = await workspaceRepository.list();
    const roots = listed.map((entry) => entry.realRootPath);
    if (roots.length === 0) return [workspace.realRootPath];
    return roots;
  }, effectiveUnrestricted, options.strictAllowedRoots, () => parsePathList(settingsRepository.get(USER_SETTING_KEYS.capabilityRoots)),
  () => parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.shellSynchronousWaitSeconds), DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS), remoteHosts, secretStore,
  async (workspaceId: string): Promise<string | null> => (await workspaceRepository.get(workspaceId))?.realRootPath ?? null);
  const databaseRuntime = new DatabaseRuntimeService({ workspaceInfo: workspaceInfoService }, actor, { targetRegistry: databaseTargets, secrets: secretStore });
  const remoteRolloutRepository = new SqliteRemoteRolloutRepository(database);
  const remoteRollouts = new RemoteRolloutRuntime({
    capabilities: capabilityService,
    repository: remoteRolloutRepository,
    audit: async (event): Promise<void> => auditService.record({
      actorId: actor.clientId,
      actorName: actor.clientName,
      workspaceId: event.workspaceId,
      action: 'remote_rollout_host',
      targetSummary: `host:${event.hostId} service:${event.unit}`,
      resultCode: event.resultCode,
      durationMs: event.durationMs,
      metadata: { rolloutId: event.rolloutId, phase: event.phase },
    }),
  });
  const remoteRolloutReady = remoteRollouts.reconcile();
  const supportBundle = new SupportBundleService({
    workspaceRepository,
    pathGuard,
    sources: {
      doctor: async (): Promise<unknown> => ({ status: 'ok', platform: process.platform, node: process.version }),
      health: async (): Promise<unknown> => {
        const result = await capabilityService.execute('health', { operation: 'check_all' });
        return result.ok ? result.value : { available: false, reason: result.error.code };
      },
      runtime: async (): Promise<unknown> => ({ product: 'Baitonghub-Linux-mcp', platform: process.platform, arch: process.arch, node: process.version }),
      auditSummary: async (): Promise<unknown> => {
        const events = await auditRepository.list(200);
        const resultCodes = Object.fromEntries([...new Set(events.map((event) => event.resultCode))].map((code) => [code, events.filter((event) => event.resultCode === code).length]));
        return { count: events.length, resultCodes, latestTimestamp: events[0]?.timestamp };
      },
      recentErrors: async (): Promise<unknown> => (await auditRepository.list(200)).filter((event) => !['SUCCESS', 'STARTED'].includes(event.resultCode)).slice(0, 200),
      packageFiles: async (): Promise<unknown> => ['baitonghub-linux-mcp-node', 'mcp-stdio.cjs', 'mcp-http.cjs', 'package.json'],
    },
    archive: {
      create: async (sourceDirectory: string, outputPath: string, signal?: AbortSignal): Promise<Result<{ readonly bytes: number }>> => {
        const result = await capabilityService.execute('archive', { operation: 'create', source: sourceDirectory, output: outputPath, userConfirmed: true }, signal);
        if (!result.ok) return result;
        try { return ok({ bytes: (await stat(outputPath)).size }); } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Support archive output was not created', true)); }
      },
    },
  });
  const sharedActivityLease = createSharedActivityLease(process.env.TUNNEL_CLIENT_PROFILE_DIR);
  const activityReady = sharedActivityLease.then(async (lease) => lease?.initialize());
  const sharedActivitySink: ActivitySink = {
    async record(event: ActivitySinkEvent): Promise<void> {
      await (await sharedActivityLease)?.record(event);
    },
  };
  const durableActivitySink = composeActivitySinks([
    createFileActivitySink(mcpActivityLogPath(dataPath)),
    {
      async record(event: ActivitySinkEvent): Promise<void> {
        await auditService.recordMcpTool({
          actorId: actor.clientId,
          actorName: actor.clientName,
          ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          toolName: event.toolName,
          callId: event.callId,
          phase: event.phase,
          ...(event.targetSummary === undefined ? {} : { targetSummary: event.targetSummary }),
          resultCode: event.resultCode,
          ...(event.resultMessage === undefined ? {} : { resultMessage: event.resultMessage }),
          ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
          ...(event.traceParent === undefined ? {} : { traceParent: event.traceParent }),
          ...(event.approvalReceipt === undefined ? {} : { approvalReceipt: event.approvalReceipt }),
          durationMs: event.durationMs,
          timestamp: event.timestamp,
        });
      },
    },
  ]);
  const activityTracker = new ActivityTracker({
    async record(event: ActivitySinkEvent): Promise<void> {
      // Publish starts before slower durable evidence so updater quiet-time
      // cannot overlap a newly accepted remote call. Publish completion last.
      await composeActivitySinks(event.phase === 'started'
        ? [sharedActivitySink, durableActivitySink]
        : [durableActivitySink, sharedActivitySink]).record(event);
    },
  });
  const runtimeTaskSnapshot = createRuntimeTaskSnapshotProvider(workspaceRepository, processService, remoteRollouts, actor);
  const services: McpApplicationServices = {
    runtimeStatePath: path.join(dataPath, 'upgrade-runtime.json'),
    runtimeTiming: () => ({
      mcpPollWaitSeconds: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpPollWaitSeconds), DEFAULT_MCP_POLL_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
    }),
    runtimeTaskSnapshot,
    localProviders: () => ({
      ...(settingsRepository.get(USER_SETTING_KEYS.pdfProviderPath)?.trim() ? { pdfProvider: settingsRepository.get(USER_SETTING_KEYS.pdfProviderPath)!.trim() } : {}),
      lspCommands: parseStringRecordSetting(settingsRepository.get(USER_SETTING_KEYS.lspCommands)),
    }),
    capabilities: capabilityService,
    extensions,
    workspaceInfo: workspaceInfoService,
    workspaceQuery,
    projectSnapshot: new ProjectSnapshotService(workspaceRepository, {
      projectService,
      gitService,
      workspaceQuery,
      processService,
    }),
    project: projectService,
    file: fileService,
    search: new SearchService(workspaceRepository),
    workspaceIndex,
    workspaceChanges,
    workspaceSnapshot,
    git: gitService,
    process: processService,
    codex: codexService,
    database: databaseRuntime,
    targetCatalog,
    remoteRollout: remoteRollouts,
    remoteRolloutResume: remoteRollouts,
    remoteRolloutTasks: remoteRollouts,
    remoteFleetAudit: async (event: RemoteFleetAuditEvent): Promise<void> => auditService.record({
      actorId: actor.clientId,
      actorName: actor.clientName,
      action: 'remote_fleet_host',
      targetSummary: `host:${event.hostId}`,
      resultCode: event.resultCode,
      durationMs: event.durationMs,
      metadata: { operation: event.operation, ...(event.truncated === true ? { truncated: true } : {}) },
    }),
    supportBundle,
    auditQuery,
  };

  return {
    services,
    actor,
    extensions,
    activityTracker,
    activityReady,
    remoteRolloutReady,
    profileProvider,
    serverProfile,
    allowAiDeleteProvider,
    destructivePolicyProvider,
    codexToolsEnabled: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.codexToolsEnabled), DEFAULT_CODEX_TOOLS_ENABLED),
    close: async (): Promise<void> => {
      await (await sharedActivityLease)?.close();
      await extensions.close().catch(() => undefined);
      await workspaceIndex.close().catch(() => undefined);
      database.close();
    },
  };
}

function customPermissionProfile(settingsRepository: SqliteSettingsRepository): PermissionProfile {
  const custom = parseCustomPermissionSettings(settingsRepository.get(USER_SETTING_KEYS.customPermissionProfile));
  return {
    name: 'custom',
    defaults: { READ: custom.read, WRITE: custom.write, EXECUTE: custom.execute, DANGEROUS: custom.dangerous },
    allowedProjectExecutables: [...new Set([...permissionProfiles.custom.allowedProjectExecutables, ...custom.allowedExecutables])],
  };
}

function createRuntimeTaskSnapshotProvider(
  workspaceRepository: { list(): Promise<readonly { readonly id: string }[]> },
  processService: Pick<ProcessService, 'list'>,
  remoteRollouts: Pick<RemoteRolloutRuntime, 'listTasks'>,
  actor: FileActor,
): () => Promise<RuntimeTaskSnapshot> {
  return async (): Promise<RuntimeTaskSnapshot> => {
    const byState: Partial<Record<RuntimeTaskState, number>> = {};
    const add = (state: RuntimeTaskState): void => {
      byState[state] = (byState[state] ?? 0) + 1;
    };
    for (const workspace of await workspaceRepository.list()) {
      const processes = await processService.list(actor, workspace.id);
      if (!processes.ok) continue;
      for (const process of processes.value) {
        switch (process.state) {
          case 'starting': add('queued'); break;
          case 'running': add('running'); break;
          case 'exited': add('completed'); break;
          case 'failed': add('failed'); break;
          case 'stopped': add('cancelled'); break;
          case 'timed_out': add('timed_out'); break;
          case 'termination_unverified': add('termination_unverified'); break;
        }
      }
    }
    for (const task of await remoteRollouts.listTasks(actor)) {
      if (task.status === 'working') add('running');
      else if (task.status === 'completed') add('completed');
      else if (task.status === 'failed') add('failed');
      else add('cancelled');
    }
    return { byState };
  };
}

async function createSharedActivityLease(profileDirectory: string | undefined): Promise<SharedActivitySnapshotLease | null> {
  if (profileDirectory === undefined || profileDirectory.trim().length === 0) return null;
  return new SharedActivitySnapshotLease({ profileDirectory: path.resolve(profileDirectory), owner: await currentSharedActivityOwner() });
}

function createStdioCapabilityService(
  dataPath: string,
  restrictedRoot: string,
  workspaceRootsProvider: () => Promise<readonly string[]>,
  _unrestricted: boolean,
  strictAllowedRoots?: readonly string[],
  configuredRootsProvider: () => readonly string[] = () => [],
  synchronousWaitSecondsProvider: () => number = () => DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS,
  remoteHostRegistry?: import('@baitonghub-linux-mcp/capabilities').RemoteHostRegistry,
  secretStore?: import('@baitonghub-linux-mcp/shared').SecretStore,
  workspaceRootProvider?: (workspaceId: string) => Promise<string | null>,
): LocalCapabilityService {
  const capabilityRootsProvider = async (): Promise<readonly string[]> => {
    const workspaceRoots = await workspaceRootsProvider();
    if (strictAllowedRoots !== undefined) return workspaceRoots.length > 0 ? workspaceRoots : strictAllowedRoots;
    const configuredRoots = [...readCapabilityRoots(process.env.BAITONGHUB_LINUX_MCP_CAPABILITY_ROOTS), ...configuredRootsProvider()];
    const roots = [...workspaceRoots, ...configuredRoots];
    return roots.length === 0 ? [restrictedRoot] : roots;
  };
  const initialCapabilityRoots = strictAllowedRoots ?? [
    dataPath,
    restrictedRoot,
  ];
  return createPlatformCapabilityRuntime({
    dataPath,
    initialAllowedRoots: initialCapabilityRoots,
    allowedRootsProvider: capabilityRootsProvider,
    unrestricted: false,
    maxSynchronousWaitSecondsProvider: synchronousWaitSecondsProvider,
    platform: process.platform,
    ...(remoteHostRegistry === undefined ? {} : { remoteHostRegistry }),
    ...(secretStore === undefined ? {} : { secretStore }),
    ...(workspaceRootProvider === undefined ? {} : { workspaceRootProvider }),
  }).service;
}

function readCapabilityRoots(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return value.split(';').map((root) => root.trim()).filter((root) => root.length > 0).map((root) => path.resolve(root));
}
