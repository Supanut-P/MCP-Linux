import fs from 'node:fs';
import path from 'node:path';
import {
  STDIO_ALLOWED_ROOTS_SETTING_KEY,
  STDIO_PERMISSION_PROFILE_SETTING_KEY,
  STDIO_STRICT_ROOTS_SETTING_KEY,
  parseAllowedRoots,
  parseBooleanSetting,
  parseStdioPermissionProfile,
  resolveBaitonghubLinuxMcpPaths,
  type StdioPermissionProfileName,
} from '@baitonghub-linux-mcp/shared';
import { applyPendingSqliteRestoreSync, SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@baitonghub-linux-mcp/storage';
import { normalizeWorkspaceRoot, WorkspaceService, type Workspace } from '@baitonghub-linux-mcp/workspace';
import { createStdioMcpRuntime, type StdioMcpRuntime } from './stdio-mcp-runtime.js';
import { StrictWorkspaceRepository, canonicalizeAllowedRoots, requestedPathInsideAllowedRoot } from './strict-workspace-repository.js';

export interface HeadlessRuntimeOptions {
  readonly workspaceReference?: string;
  readonly profile?: string;
  readonly strictRoots?: boolean;
  readonly allowedRoots?: readonly string[];
  readonly resetWorkspaces?: boolean;
}

export interface HeadlessRuntime {
  readonly dataPath: string;
  readonly workspace: Workspace;
  readonly runtime: StdioMcpRuntime;
  readonly profile: StdioPermissionProfileName;
  readonly strictAllowedRoots?: readonly string[];
  readonly unrestricted: false;
}

/**
 * Bootstraps the headless Linux server runtime. Workspace roots are the only filesystem roots registered on
 * Linux; `/` is never added automatically.
 */
export async function createHeadlessRuntime(options: HeadlessRuntimeOptions = {}): Promise<HeadlessRuntime> {
  const dataPath = resolveBaitonghubLinuxMcpPaths(process.env, process.platform).dataPath;
  fs.mkdirSync(dataPath, { recursive: true });
  const sqlitePath = path.join(dataPath, 'baitonghub-linux-mcp.sqlite');
  const restore = applyPendingSqliteRestoreSync(sqlitePath, path.join(dataPath, 'backups'));
  if (restore.error !== undefined) process.stderr.write(`baitonghub-linux-mcp restore warning: ${restore.error}\n`);

  const database = new SqliteDatabase(sqlitePath, { backupDirectory: path.join(dataPath, 'backups') });
  try {
    const rawWorkspaceRepository = new SqliteWorkspaceRepository(database);
    const settingsRepository = new SqliteSettingsRepository(database);
    const profile = parseStdioPermissionProfile(
      options.profile ?? process.env.BAITONGHUB_LINUX_MCP_STDIO_PROFILE ?? settingsRepository.get(STDIO_PERMISSION_PROFILE_SETTING_KEY),
      'full',
    );
    const strictRootsEnabled = options.strictRoots === true
      || parseBooleanSetting(process.env.BAITONGHUB_LINUX_MCP_STRICT_ROOTS ?? settingsRepository.get(STDIO_STRICT_ROOTS_SETTING_KEY), false);
    const configuredAllowedRoots = options.allowedRoots !== undefined && options.allowedRoots.length > 0
      ? options.allowedRoots
      : parseAllowedRoots(process.env.BAITONGHUB_LINUX_MCP_ALLOWED_ROOTS).length > 0
        ? parseAllowedRoots(process.env.BAITONGHUB_LINUX_MCP_ALLOWED_ROOTS)
        : parseAllowedRoots(settingsRepository.get(STDIO_ALLOWED_ROOTS_SETTING_KEY));
    const strictAllowedRoots = strictRootsEnabled ? await canonicalizeAllowedRoots(configuredAllowedRoots) : undefined;
    const rawWorkspaceService = new WorkspaceService(rawWorkspaceRepository);

    if (options.resetWorkspaces === true || process.env.BAITONGHUB_LINUX_MCP_RESET_WORKSPACES === '1' || process.env.BAITONGHUB_LINUX_MCP_RESET_WORKSPACES === 'true') {
      for (const existing of await rawWorkspaceService.list()) await rawWorkspaceService.delete(existing.id);
      process.stderr.write('baitonghub-linux-mcp: cleared previous workspaces\n');
    }

    const workspaceRepository = strictAllowedRoots === undefined
      ? rawWorkspaceRepository
      : new StrictWorkspaceRepository(rawWorkspaceRepository, strictAllowedRoots);
    const workspaceService = new WorkspaceService(workspaceRepository);
    const previouslyRegistered = await rawWorkspaceService.list();
    const reference = options.workspaceReference?.trim() || process.env.BAITONGHUB_LINUX_MCP_WORKSPACE?.trim();
    const byId = reference === undefined ? undefined : previouslyRegistered.find((entry) => entry.id === reference);
    const requestedPath = byId !== undefined
      ? byId.realRootPath
      : path.resolve(reference || strictAllowedRoots?.[0] || previouslyRegistered[0]?.realRootPath || process.cwd());
    if (!fs.existsSync(requestedPath)) throw new Error(`workspace path does not exist: ${requestedPath}`);

    let workspace: Workspace;
    if (strictAllowedRoots !== undefined) {
      process.env.BAITONGHUB_LINUX_MCP_CAPABILITY_ROOTS = strictAllowedRoots.join(';');
      for (const root of strictAllowedRoots) {
        const normalized = normalizeWorkspaceRoot(root).toLowerCase();
        const existing = (await workspaceService.list()).find((entry) => normalizeWorkspaceRoot(entry.realRootPath).toLowerCase() === normalized);
        if (existing === undefined) {
          const added = await workspaceService.add(path.basename(root) || root, root);
          if (!added.ok) throw new Error(`could not register strict root ${root}: ${added.error.message}`);
        }
      }
      const selectedAllowedRoot = await requestedPathInsideAllowedRoot(requestedPath, strictAllowedRoots);
      const selectedNorm = normalizeWorkspaceRoot(selectedAllowedRoot).toLowerCase();
      const selected = (await workspaceService.list()).find((entry) => normalizeWorkspaceRoot(entry.realRootPath).toLowerCase() === selectedNorm);
      if (selected === undefined) throw new Error(`strict root was not registered: ${selectedAllowedRoot}`);
      workspace = selected;
    } else {
      const requestedNorm = normalizeWorkspaceRoot(requestedPath).toLowerCase();
      let selected = (await workspaceService.list()).find((entry) => normalizeWorkspaceRoot(entry.realRootPath).toLowerCase() === requestedNorm);
      if (selected === undefined) {
        const added = await workspaceService.add(path.basename(requestedPath) || 'Workspace', requestedPath);
        if (!added.ok) throw new Error(`could not register ${requestedPath}: ${added.error.message}`);
        selected = added.value;
      }
      process.env.BAITONGHUB_LINUX_MCP_CAPABILITY_ROOTS = (await workspaceService.list()).map((entry) => entry.realRootPath).join(';');
      workspace = selected;
    }

    database.close();
    const runtime = createStdioMcpRuntime(dataPath, workspace, false, {
      permissionProfile: profile,
      ...(strictAllowedRoots === undefined ? {} : { strictAllowedRoots }),
    });
    await runtime.activityReady;
    return { dataPath, workspace, runtime, profile, ...(strictAllowedRoots === undefined ? {} : { strictAllowedRoots }), unrestricted: false };
  } catch (error) {
    database.close();
    throw error;
  }
}
