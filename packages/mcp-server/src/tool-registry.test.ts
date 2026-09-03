import { afterEach, describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@baitonghub-linux-mcp/domain';
import type { Result } from '@baitonghub-linux-mcp/domain';
import type { TargetCatalogEntry, TargetCatalogKind } from '@baitonghub-linux-mcp/application';
import { permissionProfiles } from '@baitonghub-linux-mcp/permissions';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, type DestructiveAutoApprovalPolicy } from '@baitonghub-linux-mcp/shared';
import type { ActivitySinkEvent } from './activity-tracker.js';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';
import { CODEX_TOOL_NAMES } from './tools/codex-tools.js';
import { UPGRADE_TOOL_CATALOG } from './upgrade-catalog.js';

const actor = { clientId: 'client-1', clientName: 'test' };

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP tool registry', () => {
  it('returns the exact deterministic tool order', () => {
    const registry = new ToolRegistry({}, actor);

    expect(registry.list().map((tool) => tool.name)).toEqual([
      'workspace_list', 'workspace_register', 'workspace_info', 'workspace_tree', 'project_snapshot', 'read_file', 'read_files',
      'search_files', 'search_text', 'git_status', 'git_diff', 'git_log', 'git', 'write_file',
      'apply_patch', 'move_file', 'copy_file', 'delete_file', 'restore_deleted_file', 'process_start', 'process_list', 'process_status',
      'process_logs', 'process_stop', 'project_dev', 'project_test', 'project_lint',
      'project_typecheck', 'project_build', 'shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'vision_annotated_capture', 'ui_target_action', 'window', 'health',
      'system_info', 'runtime_metrics', 'journal', 'service_logs', 'network', 'service', 'package', 'schedule', 'notification', 'file_dialog', 'clipboard', 'web_fetch', 'container', 'archive', 'dependency_audit', 'remote_host', 'remote_fleet', 'artifact_verify', 'http_probe', 'storage_usage', 'backup', 'db_inspect', 'db_query',
      'skills_list', 'skills_read', 'mcp_list', 'mcp_describe', 'mcp_call',
      'workspace_context', 'workspace_context_continue', 'workspace_full_scan', 'workspace_full_scan_continue',
      'workspace_snapshot', 'search_all', 'read_many_files',
      'read_file_page', 'read_file_page_continue',
      'workspace_index', 'workspace_index_status', 'workspace_index_watch', 'workspace_index_stop', 'workspace_changes',
      'session_handoff', 'verify_incremental',
      ...UPGRADE_TOOL_CATALOG.filter((entry) => !['db_inspect', 'db_query', 'remote_fleet', 'remote_rollout', 'remote_rollout_resume', 'support_bundle'].includes(entry.name)).map((entry) => entry.name),
      'policy_explain',
      'tool_batch',
    ]);
  });

  it('hides Codex delegation tools by default and exposes them only when explicitly enabled', () => {
    const hidden = new ToolRegistry({}, actor);
    const enabled = new ToolRegistry({}, actor, { codexToolsEnabled: true });

    expect(hidden.list().filter((tool) => tool.name.startsWith('codex_'))).toHaveLength(0);
    expect(enabled.list().filter((tool) => tool.name.startsWith('codex_')).map((tool) => tool.name)).toEqual([...CODEX_TOOL_NAMES]);
    expect(enabled.list()).toHaveLength(hidden.list().length + CODEX_TOOL_NAMES.length);
  });

  it('filters the advertised and dispatchable surface by explicit server profile', async () => {
    const core = new ToolRegistry({ capabilities: { listTools: (): readonly string[] => ['health', 'runtime_metrics', 'remote_host', 'service'], execute: async (): Promise<ReturnType<typeof ok>> => ok({}) } }, actor, {
      serverProfileProvider: (): 'core' => 'core',
    });
    const coreNames = new Set(core.list().map((tool) => tool.name));
    expect(coreNames.has('workspace_list')).toBe(true);
    expect(coreNames.has('health')).toBe(true);
    expect(coreNames.has('service')).toBe(false);
    expect(coreNames.has('remote_host')).toBe(false);
    await expect(core.invoke('service', { operation: 'status' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(core.invoke('health', { operation: 'check_tool', tool: 'runtime_metrics' })).resolves.toMatchObject({ structuredContent: { serverProfile: 'core' } });

    const fleet = new ToolRegistry({ capabilities: { listTools: (): readonly string[] => ['remote_host'], execute: async (): Promise<ReturnType<typeof ok>> => ok({}) } }, actor, {
      serverProfileProvider: (): 'fleet' => 'fleet',
    });
    const fleetNames = new Set(fleet.list().map((tool) => tool.name));
    expect(fleetNames.has('remote_host')).toBe(true);
    expect(fleetNames.has('remote_fleet')).toBe(true);
    expect(fleetNames.has('service')).toBe(false);
  });

  it('advertises and dispatches the sanitized target catalog only when the registry is wired', async () => {
    const registry = new ToolRegistry({
      targetCatalog: {
        list: async (kind: TargetCatalogKind | undefined): Promise<Result<readonly TargetCatalogEntry[]>> => ok(kind === 'remote-host'
          ? [{ id: 'vm103', kind: 'remote-host', displayName: 'VM103', provider: 'openssh', readOnly: true, rootCount: 1, createdAt: '2026-09-01T00:00:00.000Z' }]
          : []),
        describe: async (): Promise<Result<TargetCatalogEntry>> => ok({ id: 'vm103', kind: 'remote-host', displayName: 'VM103', provider: 'openssh', readOnly: true, rootCount: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
      },
    }, actor);
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'target_catalog')).toBe(false);
    expect(registry.list().map((tool) => tool.name)).toContain('target_catalog');
    expect(registry.list().find((tool) => tool.name === 'target_catalog')?.parse({ operation: 'list', kind: 'remote-host' })).toMatchObject({ ok: true });
    await expect(registry.invoke('target_catalog', { operation: 'list', kind: 'remote-host' })).resolves.toMatchObject({
      structuredContent: { value: [{ id: 'vm103', kind: 'remote-host' }] },
    });
  });

  it('advertises remote_rollout only when the durable rollout service is wired', () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'remote_rollout')).toBe(false);
    const registry = new ToolRegistry({ remoteRollout: { execute: async (): Promise<Result<unknown>> => ok({}) } }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('remote_rollout');
    expect(registry.list().find((tool) => tool.name === 'remote_rollout')?.parse({
      operation: 'plan', workspaceId: 'workspace-1', hostIds: ['vm103'], unit: 'baitonghub-linux-mcp.service', canaryCount: 1,
    })).toMatchObject({ ok: true });
  });

  it('advertises remote_rollout_resume only when the resume service is wired', () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'remote_rollout_resume')).toBe(false);
    const registry = new ToolRegistry({ remoteRolloutResume: { resume: async (): Promise<Result<unknown>> => ok({}) } }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('remote_rollout_resume');
    expect(registry.list().find((tool) => tool.name === 'remote_rollout_resume')?.parse({ operation: 'preview', rolloutId: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace-1' })).toMatchObject({ ok: true });
  });

  it('advertises and dispatches bounded audit_query only when the audit port is wired', async () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'audit_query')).toBe(false);
    const registry = new ToolRegistry({
      auditQuery: {
        execute: async (): Promise<Result<unknown>> => ok({ entries: [], count: 0, truncated: false }),
      },
    }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('audit_query');
    const tool = registry.list().find((candidate) => candidate.name === 'audit_query');
    expect(tool?.parse({ tool: 'read_file', limit: 5 })).toMatchObject({ ok: true });
    await expect(registry.invoke('audit_query', { tool: 'read_file', limit: 5 })).resolves.toMatchObject({
      structuredContent: { entries: [], count: 0, truncated: false },
    });
  });

  it('dispatches the manifest branch of the backwards-compatible workspace_snapshot tool', async () => {
    const registry = new ToolRegistry({
      workspaceSnapshot: {
        execute: async (_actor, input): Promise<Result<unknown>> => ok({ workspaceId: input.workspaceId, entries: [], count: 0, truncated: false }),
      },
    }, actor);
    const tool = registry.list().find((candidate) => candidate.name === 'workspace_snapshot');
    expect(tool?.parse({ workspaceId: 'workspace-1', operation: 'manifest', maxEntries: 10, hashMode: 'none' })).toMatchObject({ ok: true });
    await expect(registry.invoke('workspace_snapshot', { workspaceId: 'workspace-1', operation: 'manifest', maxEntries: 10 })).resolves.toMatchObject({
      structuredContent: { workspaceId: 'workspace-1', entries: [], count: 0, truncated: false },
    });
  });

  it('advertises and dispatches bounded task_events only when the event service is wired', async () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'task_events')).toBe(false);
    const registry = new ToolRegistry({
      taskEvents: {
        execute: async (_actor, input): Promise<Result<unknown>> => ok({ taskId: input.taskId, state: 'completed', events: [], count: 0, truncated: false }),
      },
    }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('task_events');
    expect(registry.list().find((tool) => tool.name === 'task_events')?.parse({ taskId: 'task-1', limit: 10 })).toMatchObject({ ok: true });
    await expect(registry.invoke('task_events', { taskId: 'task-1', limit: 10 })).resolves.toMatchObject({
      structuredContent: { taskId: 'task-1', state: 'completed', events: [], count: 0, truncated: false },
    });
  });

  it('advertises and dispatches bounded task_history only when the history service is wired', async () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'task_history')).toBe(false);
    const registry = new ToolRegistry({
      taskHistory: {
        execute: async (_actor, input): Promise<Result<unknown>> => ok({ entries: [], count: 0, truncated: false, limit: input.limit }),
      },
    }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('task_history');
    expect(registry.list().find((tool) => tool.name === 'task_history')?.parse({ state: 'completed', limit: 10 })).toMatchObject({ ok: true });
    await expect(registry.invoke('task_history', { state: 'completed', limit: 10 })).resolves.toMatchObject({
      structuredContent: { entries: [], count: 0, truncated: false },
    });
  });

  it('advertises and dispatches diagnostics_snapshot only when the diagnostics service is wired', async () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'diagnostics_snapshot')).toBe(false);
    const registry = new ToolRegistry({ diagnosticsSnapshot: { execute: async (): Promise<Result<unknown>> => ok({ status: 'ready' }) } }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('diagnostics_snapshot');
    expect(registry.list().find((tool) => tool.name === 'diagnostics_snapshot')?.parse({})).toMatchObject({ ok: true });
    await expect(registry.invoke('diagnostics_snapshot', {})).resolves.toMatchObject({ structuredContent: { status: 'ready' } });
  });

  it('advertises and dispatches remote_fleet_diff only when the diff service is wired', async () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'remote_fleet_diff')).toBe(false);
    const registry = new ToolRegistry({ remoteFleetDiff: { execute: async (): Promise<Result<unknown>> => ok({ operation: 'remote_fleet_diff', hosts: [], summary: { requested: 0 } }) } }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('remote_fleet_diff');
    expect(registry.list().find((tool) => tool.name === 'remote_fleet_diff')?.parse({ hostIds: ['vm1'], baseline: { hosts: [] } })).toMatchObject({ ok: true });
    await expect(registry.invoke('remote_fleet_diff', { hostIds: ['vm1'], baseline: { hosts: [] } })).resolves.toMatchObject({ structuredContent: { operation: 'remote_fleet_diff' } });
  });

  it('advertises and dispatches release_verify only when the verification service is wired', async () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'release_verify')).toBe(false);
    const registry = new ToolRegistry({ releaseVerify: { execute: async (): Promise<Result<unknown>> => ok({ operation: 'release_verify', verified: true, artifacts: [], reasonCodes: [] }) } }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('release_verify');
    expect(registry.list().find((tool) => tool.name === 'release_verify')?.parse({ workspaceId: 'workspace-1', metadataPath: 'dist/meta.json', checksumsPath: 'dist/sums', artifacts: [{ path: 'dist/app.deb', sha256: 'a'.repeat(64) }] })).toMatchObject({ ok: true });
    await expect(registry.invoke('release_verify', { workspaceId: 'workspace-1', metadataPath: 'dist/meta.json', checksumsPath: 'dist/sums', artifacts: [{ path: 'dist/app.deb', sha256: 'a'.repeat(64) }] })).resolves.toMatchObject({ structuredContent: { operation: 'release_verify', verified: true } });
  });

  it('advertises and dispatches environment_preflight only when the service is wired', async () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'environment_preflight')).toBe(false);
    const registry = new ToolRegistry({ environmentPreflight: { execute: async (): Promise<Result<unknown>> => ok({ operation: 'environment_preflight', status: 'ready' }) } }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('environment_preflight');
    expect(registry.list().find((tool) => tool.name === 'environment_preflight')?.parse({})).toMatchObject({ ok: true });
    await expect(registry.invoke('environment_preflight', {})).resolves.toMatchObject({ structuredContent: { operation: 'environment_preflight', status: 'ready' } });
  });

  it('explains active profile and registered-root policy without dispatching the target tool', async () => {
    let called = false;
    const registry = new ToolRegistry({
      capabilities: {
        listTools: (): readonly string[] => ['shell', 'health'],
        execute: async (): Promise<Result<unknown>> => { called = true; return ok({}); },
      },
    }, actor, { profileProvider: (): typeof permissionProfiles.balanced => permissionProfiles.balanced, serverProfileProvider: (): 'core' => 'core' });
    await expect(registry.invoke('policy_explain', { tool: 'shell', workspaceId: 'workspace-1', operation: 'run' })).resolves.toMatchObject({
      structuredContent: { tool: 'shell', allowed: true, reasonCode: 'OK', registeredRootRequired: true, requiresConsent: false },
    });
    expect(called).toBe(false);
    await expect(registry.invoke('policy_explain', { tool: 'shell' })).resolves.toMatchObject({
      structuredContent: { allowed: false, reasonCode: 'REGISTERED_ROOT_REQUIRED' },
    });
  });

  it('advertises support_bundle only when the redaction service is wired', () => {
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'support_bundle')).toBe(false);
    const registry = new ToolRegistry({ supportBundle: { execute: async (): Promise<Result<unknown>> => ok({ dry_run: true }) } }, actor);
    expect(registry.list().map((tool) => tool.name)).toContain('support_bundle');
    expect(registry.list().find((tool) => tool.name === 'support_bundle')?.parse({ workspaceId: 'workspace-1', destination: 'support.tar.gz', include: ['health'] })).toMatchObject({ ok: true });
  });

  it('dispatches bounded workspace change snapshots and diffs', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry({
      workspaceChanges: {
        snapshot: async (workspaceId, maxEvents): Promise<Result<unknown>> => { calls.push(`snapshot:${workspaceId}:${maxEvents}`); return ok({ workspaceId, events: [], latestSequence: 4, truncated: false }); },
        diff: async (workspaceId, afterSequence, maxEvents): Promise<Result<unknown>> => { calls.push(`diff:${workspaceId}:${afterSequence}:${maxEvents}`); return ok({ workspaceId, events: [], latestSequence: 4, truncated: false }); },
      },
    }, actor);
    expect(registry.list().find((tool) => tool.name === 'workspace_changes')?.parse({ operation: 'diff', workspaceId: 'workspace-1', afterSequence: 3 })).toMatchObject({ ok: true });
    await registry.invoke('workspace_changes', { operation: 'snapshot', workspaceId: 'workspace-1' });
    await registry.invoke('workspace_changes', { operation: 'diff', workspaceId: 'workspace-1', afterSequence: 3, maxEvents: 10 });
    expect(calls).toEqual(['snapshot:workspace-1:50', 'diff:workspace-1:3:10']);
  });

  it('records a stable approval receipt for denied and confirmed dangerous calls', async () => {
    const events: ActivitySinkEvent[] = [];
    const registry = new ToolRegistry({
      capabilities: { listTools: (): readonly string[] => ['service'], execute: async (): Promise<Result<unknown>> => ok({ restarted: true }) },
      supportBundle: { execute: async (input): Promise<Result<unknown>> => ok({ receiptId: (input as Record<string, unknown>)._approvalReceiptId }) },
    }, actor, { activity: { async record(event): Promise<void> { events.push(event); } } });

    await registry.invoke('service', { operation: 'restart', unit: 'app.service' });
    await registry.invoke('support_bundle', { workspaceId: 'workspace-1', destination: 'support.tar.gz', include: ['health'], dry_run: true });

    const denied = events.find((event) => event.toolName === 'service' && event.phase === 'completed');
    const preview = events.find((event) => event.toolName === 'support_bundle' && event.phase === 'completed');
    expect(denied?.approvalReceipt).toMatchObject({ toolName: 'service', actorId: 'client-1', decision: 'CONFIRMATION_REQUIRED', targetSummaryHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(preview?.approvalReceipt).toMatchObject({ toolName: 'support_bundle', actorId: 'client-1', decision: 'ALLOW' });
    expect(events.some((event) => event.approvalReceipt?.targetSummaryHash === 'app.service')).toBe(false);
  });

  it('does not advertise a fixed drive letter in workspace registration metadata', () => {
    const registry = new ToolRegistry({}, actor);
    const registration = registry.list().find((tool) => tool.name === 'workspace_register');
    expect(registration?.description).not.toContain('E:\\');
  });

  it('exposes the Khai-Hub-compatible local capability contract', async () => {
    const registry = new ToolRegistry({}, actor);
    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));

    expect(byName.get('shell')?.parse({ operation: 'run', executable: 'node', arguments: [] })).toMatchObject({ ok: true });
    expect(byName.get('dom_cdp')?.parse({ action: 'query', parameters: { selector: '#app' } })).toMatchObject({ ok: true });
    expect(byName.get('accessibility')?.parse({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(byName.get('input_event')?.parse({ operation: 'click', parameters: { x: 1, y: 2 } })).toMatchObject({ ok: true });
    expect(byName.get('vision')?.parse({ action: 'capture_display' })).toMatchObject({ ok: true });
    expect(byName.get('window')?.parse({ operation: 'list' })).toMatchObject({ ok: true });
    expect(byName.get('window')?.parse({ operation: 'set_window_frame', parameters: { x: 0, y: 0, width: 800, height: 600 } })).toMatchObject({ ok: true });
    expect(byName.get('health')?.parse({ operation: 'check_all' })).toMatchObject({ ok: true });
    expect(byName.get('health')?.parse({ operation: 'check_tool', tool: 'runtime_metrics' })).toMatchObject({ ok: true });
    expect(byName.get('health')?.parse({ operation: 'check_tool', tool: 'service_logs' })).toMatchObject({ ok: true });
    expect(byName.get('system_info')?.parse({ operation: 'disk', path: '/' })).toMatchObject({ ok: true });
    expect(byName.get('runtime_metrics')?.parse({ operation: 'snapshot', scopes: ['host', 'runtime'] })).toMatchObject({ ok: true });
    expect(byName.get('runtime_metrics')?.parse({ operation: 'snapshot', scopes: ['host', 'unknown'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(new ToolRegistry({}, actor).invoke('health', { operation: 'check_tool', tool: 'runtime_metrics' })).resolves.toMatchObject({
      structuredContent: { tool: 'runtime_metrics', provider: 'node:os+activity', available: true, ready: true },
    });
    expect(byName.get('journal')?.parse({ unit: 'caddy.service', lines: 100 })).toMatchObject({ ok: true });
    expect(byName.get('journal')?.parse({ unit: '../../etc/passwd.service' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(byName.get('service_logs')?.parse({ operation: 'tail', unit: 'caddy.service', lines: 50 })).toMatchObject({ ok: true });
    expect(byName.get('service_logs')?.parse({ operation: 'read', unit: '../../etc/passwd.service' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(byName.get('network')?.parse({ operation: 'listeners', limit: 50 })).toMatchObject({ ok: true });
    expect(byName.get('service')?.parse({ operation: 'status', unit: 'caddy.service' })).toMatchObject({ ok: true });
    expect(byName.get('service')?.parse({ operation: 'restart', unit: '../../etc/passwd.service' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(byName.get('package')?.parse({ operation: 'install', packages: ['jq'], dry_run: true })).toMatchObject({ ok: true });
    expect(byName.get('package')?.parse({ operation: 'install', packages: ['../../etc/passwd'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(byName.get('schedule')?.parse({ operation: 'list' })).toMatchObject({ ok: true });
    expect(byName.get('remote_host')?.parse({ hostId: 'vm103', operation: 'system_info' })).toMatchObject({ ok: true });
    expect(byName.get('remote_fleet')?.parse({ hostIds: ['vm103'], operation: 'health' })).toMatchObject({ ok: true });
    expect(byName.get('remote_fleet')?.parse({ hostIds: ['vm103'], operation: 'disk_usage', path: '/srv/app' })).toMatchObject({ ok: true });
    expect(byName.get('remote_fleet')?.parse({ hostIds: ['vm103'], operation: 'checksum', path: '/srv/app/app.tar' })).toMatchObject({ ok: true });
    expect(byName.get('remote_fleet')?.parse({ hostIds: ['vm103'], operation: 'network' })).toMatchObject({ ok: true });
    expect(byName.get('remote_fleet')?.parse({ hostIds: ['vm103'], operation: 'snapshot', maxParallel: 2 })).toMatchObject({ ok: true });
    expect(byName.get('artifact_verify')?.parse({ workspaceId: 'workspace-1', path: 'dist/app.js' })).toMatchObject({ ok: true });
    expect(byName.get('http_probe')?.parse({ url: 'https://example.com', method: 'HEAD' })).toMatchObject({ ok: true });
    expect(byName.get('storage_usage')?.parse({ workspaceId: 'workspace-1', path: '.', operation: 'largest_files' })).toMatchObject({ ok: true });
    expect(byName.get('backup')?.parse({ operation: 'plan', workspaceId: 'workspace-1', source: '.' })).toMatchObject({ ok: true });
    expect(byName.get('db_inspect')?.parse({ targetId: 'pg-main' })).toMatchObject({ ok: true });
    expect(byName.get('db_query')?.parse({ targetId: 'pg-main', sql: 'SELECT 1' })).toMatchObject({ ok: true });
  });

  it('allows workspace discovery under the balanced tunnel profile', async () => {
    const registry = new ToolRegistry({
      workspaceInfo: {
        list: async (): Promise<ReturnType<typeof ok>> => ok([{ id: 'workspace-1', displayName: 'Workspace' }]),
      },
    }, actor, {
      profileProvider: (): typeof permissionProfiles.balanced => permissionProfiles.balanced,
    });

    await expect(registry.invoke('workspace_list', {})).resolves.toMatchObject({
      structuredContent: { value: [{ id: 'workspace-1', displayName: 'Workspace' }] },
    });
    expect(registry.list().find((tool) => tool.name === 'workspace_list')?.annotations)
      .toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('does not advertise Windows-only capabilities when the platform service filters them', () => {
    const registry = new ToolRegistry({
      capabilities: {
        listTools: (): readonly string[] => [
          'shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window',
          'health', 'system_info', 'notification', 'file_dialog', 'clipboard', 'web_fetch',
        ],
        execute: async (): Promise<ReturnType<typeof ok>> => ok({}),
      },
    }, actor);
    const names = registry.list().map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(['vision_annotated_capture', 'ui_target_action']));
    expect(names).not.toEqual(expect.arrayContaining([
      'audio', 'screen_record', 'office', 'scheduler', 'wsl_exec', 'wsl_fs',
    ]));
  });

  it('forces MCP command execution to return immediately and caps follow-up waits', async () => {
    const calls: Array<{ tool: string; input: unknown }> = [];
    const registry = new ToolRegistry({
      capabilities: {
        async execute(tool, input): Promise<ReturnType<typeof ok>> {
          calls.push({ tool, input });
          return ok({ accepted: true });
        },
      },
    }, actor);
    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));

    expect(byName.get('shell')?.description).toContain('ALWAYS forced to execution=background');
    expect(byName.get('shell')?.description).toContain('reconnect-safe resume');
    expect(byName.get('shell')?.parse({ operation: 'run', executable: 'node', arguments: [] })).toMatchObject({ ok: true, value: { execution: 'background' } });
    expect(byName.get('shell')?.parse({ operation: 'resume', workspaceId: 'workspace-1', task_id: 'task-1', resume_token: 'A'.repeat(43) })).toMatchObject({ ok: true });
    expect(byName.get('shell')?.parse({ operation: 'resume', task_id: 'task-1', resume_token: 'A'.repeat(43) })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await registry.invoke('shell', { operation: 'run', executable: 'node', arguments: ['--version'], execution: 'foreground' });
    await registry.invoke('shell', { operation: 'wait', task_id: 'task-1', timeout_seconds: 60 });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tool: 'shell', input: { operation: 'run', execution: 'background' } });
    expect(calls[1]).toMatchObject({ tool: 'shell', input: { operation: 'wait', timeout_seconds: 5 } });
  });

  it('uses the live configured MCP poll window and clamps it to the supported 5-60 second range', async () => {
    const waits: number[] = [];
    let configured = 30;
    const registry = new ToolRegistry({
      runtimeTiming: (): { mcpPollWaitSeconds: number } => ({ mcpPollWaitSeconds: configured }),
      capabilities: {
        async execute(_tool, input): Promise<ReturnType<typeof ok>> {
          const request = input as { operation?: string; timeout_seconds?: number };
          if (request.operation === 'wait' && request.timeout_seconds !== undefined) waits.push(request.timeout_seconds);
          return ok({ accepted: true });
        },
      },
    }, actor);

    await registry.invoke('shell', { operation: 'wait', task_id: 'task-1', timeout_seconds: 60 });
    configured = 1;
    await registry.invoke('shell', { operation: 'wait', task_id: 'task-1', timeout_seconds: 60 });
    expect(waits).toEqual([30, 5]);
    expect(registry.list().find((tool) => tool.name === 'shell')?.description).toContain('do not keep polling in the same chat turn');
  });

  it('blocks dangerous capability execution under the safe profile before reaching the backend', async () => {
    let executed = false;
    const registry = new ToolRegistry({
      capabilities: {
        async execute(): Promise<ReturnType<typeof ok>> {
          executed = true;
          return ok({ executed: true });
        },
      },
    }, actor, {
      profileProvider: (): typeof permissionProfiles.safe => permissionProfiles.safe,
    });

    const response = await registry.invoke('dom_cdp', { action: 'query', parameters: { selector: 'body' } });

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED' } },
    });
    expect(executed).toBe(false);
  });

  it('blocks confirmed-required administration mutations before capability dispatch', async () => {
    let calls = 0;
    const registry = new ToolRegistry({
      capabilities: {
        listTools: (): readonly string[] => ['service', 'package', 'schedule'],
        async execute(): Promise<ReturnType<typeof ok>> { calls += 1; return ok({ executed: true }); },
      },
    }, actor);
    await expect(registry.invoke('service', { operation: 'restart', unit: 'demo.service' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('package', { operation: 'install', packages: ['jq'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('schedule', { operation: 'remove', unit: 'demo' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(calls).toBe(0);
  });

  it('rejects invalid workspace IDs, line ranges, oversized results, and process log queries at the schema boundary', async () => {
    const registry = new ToolRegistry({}, actor);

    await expect(registry.invoke('read_file', { workspaceId: '', path: 'src\\file.ts' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke('read_file', { workspaceId: 'workspace-1', path: 'src\\file.ts', startLine: 10, endLine: 2 })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'x', maxResults: 501 })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke('process_logs', { workspaceId: 'workspace-1', processId: 'process-1', tailLines: 10001 })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
  });

  it('marks read-only and destructive annotations accurately and excludes forbidden tools', () => {
    const registry = new ToolRegistry({}, actor);
    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));

    expect(byName.get('read_file')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('delete_file')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('git')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('write_file')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('skills_list')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('mcp_call')?.permission).toBe('DANGEROUS');
    expect(byName.get('tool_batch')?.permission).toBe('DANGEROUS');
    expect(byName.get('tool_batch')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('workspace_context')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('read_file_page')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(registry.list().some((tool) => ['run_shell', 'powershell', 'cmd', 'git_reset', 'git_clean', 'kill_pid'].includes(tool.name))).toBe(false);
  });

  it('maps application errors without exposing internal details', async () => {
    const services: McpApplicationServices = {
      file: { async readFile(): Promise<ReturnType<typeof err>> { return err(appError('INTERNAL_ERROR', 'internal stack must not escape', true)); } },
    };

    const response = await new ToolRegistry(services, actor).invoke('read_file', { workspaceId: 'workspace-1', path: 'src\\file.ts' });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL_ERROR', recoverable: true } } });
    expect(response.content[0]?.text).not.toContain('stack');
  });

  it('does not impose a default 90-second response cutoff on long-running tools', async () => {
    vi.useFakeTimers();
    const services: McpApplicationServices = {
      search: {
        async searchText() {
          await new Promise((resolve) => setTimeout(resolve, 95_000));
          return ok({ matches: [], truncated: false });
        },
        async searchFiles() {
          return ok({ paths: [], truncated: false });
        },
      },
    };
    const registry = new ToolRegistry(services, actor);
    let settled = false;
    const pending = registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'slow-but-valid' });
    void pending.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(90_001);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(4_999);
    await expect(pending).resolves.toMatchObject({ structuredContent: { matches: [], truncated: false } });
  });

  it('returns a recoverable timeout before a slow tool can outlive the MCP response budget', async () => {
    const services: McpApplicationServices = {
      search: {
        async searchText() {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return ok({ matches: [], truncated: false });
        },
        async searchFiles() {
          return ok({ paths: [], truncated: false });
        },
      },
    };
    const registry = new ToolRegistry(services, actor, { maxToolDurationMs: 10 });

    const started = Date.now();
    const response = await registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'slow' });

    expect(Date.now() - started).toBeLessThan(70);
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT', recoverable: true } },
    });
  });

  it('aborts a timed-out invocation before allowing the next MCP call to succeed', async () => {
    let firstInvocationAborted = false;
    const services: McpApplicationServices = {
      search: {
        async searchText(_actor, _workspaceId, request, signal) {
          if (request.query === 'fast') return ok({ matches: [], truncated: false });
          return new Promise<ReturnType<typeof ok>>((resolve) => {
            signal?.addEventListener('abort', () => {
              firstInvocationAborted = true;
              resolve(ok({ matches: [], truncated: true }));
            }, { once: true });
          });
        },
        async searchFiles() {
          return ok({ paths: [], truncated: false });
        },
      },
    };
    const registry = new ToolRegistry(services, actor, { maxToolDurationMs: 15 });

    await expect(registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'slow' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT', recoverable: true } },
    });
    expect(firstInvocationAborted).toBe(true);

    const followUp = await registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'fast' });
    expect(followUp.isError).not.toBe(true);
    expect(followUp.structuredContent).toMatchObject({ matches: [], truncated: false });
  });

  it('maps thrown application exceptions to INTERNAL_ERROR and sends redacted diagnostics', async () => {
    const diagnostics: unknown[] = [];
    const services: McpApplicationServices = {
      search: {
        async searchText(): Promise<never> {
          throw new Error('Authorization: Bearer secret-token');
        },
        async searchFiles() {
          return ok({ paths: [], truncated: false });
        },
      },
    };

    const response = await new ToolRegistry(services, actor, { diagnostic: (event: unknown): void => { diagnostics.push(event); } })
      .invoke('search_text', { workspaceId: 'workspace-1', query: 'needle' });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL_ERROR', message: 'Operation failed' } } });
    expect(response.content[0]?.text).not.toContain('secret-token');
    expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
    expect(diagnostics).toHaveLength(1);
  });

  it('records activity sink events for successful tool calls', async () => {
    const events: Array<{ phase: string; toolName: string; resultCode: string }> = [];
    const services: McpApplicationServices = {
      file: {
        async readFile() {
          return ok({ path: 'src\\file.ts', content: 'hello', truncated: false });
        },
        async readFiles() {
          return ok({ files: [] });
        },
        async writeFile() {
          return ok({ path: 'x' });
        },
        async applyPatch() {
          return ok({ paths: [] });
        },
        async moveFile() {
          return ok({ from: 'a', to: 'b' });
        },
        async copyFile() {
          return ok({ sourcePath: 'a', destinationPath: 'b' });
        },
        async deleteFile() {
          return ok({ path: 'x' });
        },
      },
    };

    const response = await new ToolRegistry(services, actor, {
      activity: {
        async record(event: ActivitySinkEvent): Promise<void> {
          events.push({ phase: event.phase, toolName: event.toolName, resultCode: event.resultCode });
        },
      },
    }).invoke('read_file', { workspaceId: 'workspace-1', path: 'src\\file.ts' });

    expect(response.isError).not.toBe(true);
    expect(events).toEqual([
      { phase: 'started', toolName: 'read_file', resultCode: 'STARTED' },
      { phase: 'completed', toolName: 'read_file', resultCode: 'SUCCESS' },
    ]);
  });

  it('attributes shell cwd and task follow-ups to the matching registered workspace for activity logs', async () => {
    const events: ActivitySinkEvent[] = [];
    let taskSequence = 0;
    const registry = new ToolRegistry({
      workspaceInfo: {
        async info(): Promise<ReturnType<typeof err>> { return err(appError('WORKSPACE_NOT_FOUND', 'not used')); },
        async list(): Promise<ReturnType<typeof ok>> {
          return ok([
            { id: 'machine-root', displayName: 'srv', rootPath: '/srv', realRootPath: '/srv' },
            { id: 'workspace-project', displayName: 'baitonghub-linux-mcp', rootPath: '/srv/baitonghub-linux-mcp', realRootPath: '/srv/baitonghub-linux-mcp' },
          ]);
        },
      },
      capabilities: {
        async execute(tool, input): Promise<ReturnType<typeof ok>> {
          expect(tool).toBe('shell');
          const request = input as { operation?: string; task_id?: string };
          if (request.operation === 'run') {
            taskSequence += 1;
            return ok({ task_id: `task-${taskSequence}`, state: 'running' });
          }
          return ok({ task_id: request.task_id, state: 'completed', exit_code: 0 });
        },
      },
    }, actor, {
      activity: { async record(event: ActivitySinkEvent): Promise<void> { events.push(event); } },
    });

    await registry.invoke('shell', { operation: 'run', executable: 'node', arguments: ['--version'], cwd: '/srv/baitonghub-linux-mcp/packages/mcp-server' });
    await registry.invoke('shell', { operation: 'wait', task_id: 'task-1' });
    await registry.invoke('shell', { operation: 'run', executable: 'node', arguments: ['--version'], cwd: '/tmp/outside' });

    expect(events.slice(0, 4).map((event) => ({ phase: event.phase, workspaceId: event.workspaceId }))).toEqual([
      { phase: 'started', workspaceId: 'workspace-project' },
      { phase: 'completed', workspaceId: 'workspace-project' },
      { phase: 'started', workspaceId: 'workspace-project' },
      { phase: 'completed', workspaceId: 'workspace-project' },
    ]);
    expect(events.slice(4).every((event) => event.workspaceId === undefined)).toBe(true);
  });

  it('executes tool_batch children through the registry and records each child activity', async () => {
    const events: Array<{ phase: string; toolName: string; resultCode: string }> = [];
    const registry = new ToolRegistry({
      file: {
        async readFile(input): Promise<ReturnType<typeof ok>> {
          return ok({ path: input.path, content: `content:${input.path}`, truncated: false });
        },
      },
    }, actor, {
      activity: {
        async record(event: ActivitySinkEvent): Promise<void> {
          events.push({ phase: event.phase, toolName: event.toolName, resultCode: event.resultCode });
        },
      },
    });

    const response = await registry.invoke('tool_batch', {
      parallel: true,
      calls: [
        { id: 'read-a', tool: 'read_file', arguments: { workspaceId: 'workspace-1', path: 'a.txt' } },
        { id: 'read-b', tool: 'read_file', arguments: { workspaceId: 'workspace-1', path: 'b.txt' } },
      ],
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ summary: { total: 2, succeeded: 2, failed: 0 } });
    expect(events.filter((event) => event.phase === 'started').map((event) => event.toolName)).toEqual([
      'tool_batch', 'read_file', 'read_file',
    ]);
    expect(events.filter((event) => event.phase === 'completed').map((event) => event.toolName).sort()).toEqual([
      'read_file', 'read_file', 'tool_batch',
    ]);
  });

  it('keeps successful batch siblings when one child returns an MCP error', async () => {
    const registry = new ToolRegistry({
      file: {
        async readFile(input): Promise<ReturnType<typeof ok>> {
          return ok({ path: input.path, content: 'ok', truncated: false });
        },
      },
    }, actor);

    const response = await registry.invoke('tool_batch', {
      parallel: true,
      calls: [
        { id: 'good-a', tool: 'read_file', arguments: { workspaceId: 'workspace-1', path: 'a.txt' } },
        { id: 'bad', tool: 'does_not_exist', arguments: {} },
        { id: 'good-b', tool: 'read_file', arguments: { workspaceId: 'workspace-1', path: 'b.txt' } },
      ],
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      summary: { total: 3, succeeded: 2, failed: 1 },
      results: [
        { id: 'good-a', status: 'succeeded' },
        { id: 'bad', status: 'failed', error: { code: 'INVALID_INPUT' } },
        { id: 'good-b', status: 'succeeded' },
      ],
    });
  });
  it('requires explicit confirmation before destructive git commands reach the backend', async () => {
    let executed = 0;
    const registry = new ToolRegistry({
      git: {
        async run(): Promise<ReturnType<typeof ok>> {
          executed += 1;
          return ok({ exitCode: 0, stdout: '', stderr: '' });
        },
      },
    }, actor);

    const blocked = await registry.invoke('git', { workspaceId: 'workspace-1', args: ['reset', '--hard'] });
    expect(blocked).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(executed).toBe(0);

    const allowed = await registry.invoke('git', { workspaceId: 'workspace-1', args: ['reset', '--hard'], userConfirmed: true });
    expect(allowed.isError).not.toBe(true);
    expect(executed).toBe(1);
  });

  it('allows only scoped delete_file to bypass chat confirmation when the AI delete policy is enabled', async () => {
    let deletes = 0;
    const registry = new ToolRegistry({
      file: {
        async deleteFile(): Promise<ReturnType<typeof ok>> { deletes += 1; return ok(undefined); },
      } as McpApplicationServices['file'],
      capabilities: {
        async execute(): Promise<ReturnType<typeof ok>> { return ok({ ok: true }); },
      },
    }, actor, {
      allowAiDeleteProvider: (): boolean => true,
      workspaceScopeResolver: async (workspaceId): Promise<WorkspaceScope | null> => workspaceId === 'workspace-1'
        ? { workspaceId, rootPath: '/srv/project' }
        : null,
    });

    const deleted = await registry.invoke('delete_file', { workspaceId: 'workspace-1', path: 'tmp.txt' });
    expect(deleted.isError).not.toBe(true);
    expect(deletes).toBe(1);
    await expect(registry.invoke('shell', { operation: 'run', executable: 'rm', arguments: ['tmp.txt'] }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
  });

  it('auto-approves only enabled destructive command families inside the active project', async () => {
    const capabilityInputs: unknown[] = [];
    let gitRuns = 0;
    const registry = new ToolRegistry({
      capabilities: {
        async execute(_tool, input): Promise<ReturnType<typeof ok>> { capabilityInputs.push(input); return ok({ ok: true }); },
      },
      git: {
        async run(): Promise<ReturnType<typeof ok>> { gitRuns += 1; return ok({ exitCode: 0, stdout: '', stderr: '' }); },
      } as McpApplicationServices['git'],
    }, actor, {
      destructivePolicyProvider: (): DestructiveAutoApprovalPolicy => ({
        ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
        approvals: {
          ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals,
          git_rm: true,
          shell_rm_unlink: true,
        },
      }),
      workspaceScopeResolver: async (workspaceId): Promise<WorkspaceScope | null> => workspaceId === 'workspace-1'
        ? { workspaceId, rootPath: '/srv/project' }
        : null,
    });

    const gitRm = await registry.invoke('git', { workspaceId: 'workspace-1', args: ['rm', '--', 'src/old.ts'] });
    expect(gitRm.isError).not.toBe(true);
    expect(gitRuns).toBe(1);

    const shellRm = await registry.invoke('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['src/old.tmp'] });
    expect(shellRm.isError).not.toBe(true);
    expect(capabilityInputs).toHaveLength(1);
    expect(capabilityInputs[0]).toMatchObject({ userConfirmed: true });

    await expect(registry.invoke('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['../outside.tmp'] }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('git', { workspaceId: 'workspace-1', args: ['clean', '-fd'] }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
  });

  it('resolves destructive scope from each call workspaceId and fails closed when scope is missing or crossed', async () => {
    let deletes = 0;
    const roots = new Map([
      ['workspace-a', '/srv/project-a'],
      ['workspace-b', '/opt/project-b'],
    ]);
    const registry = new ToolRegistry({
      workspaceInfo: {
        async info(_actor, workspaceId): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
          const rootPath = roots.get(workspaceId);
          return rootPath === undefined
            ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'))
            : ok({ id: workspaceId, rootPath, realRootPath: rootPath });
        },
      },
      file: {
        async deleteFile(): Promise<ReturnType<typeof ok>> { deletes += 1; return ok(undefined); },
      } as McpApplicationServices['file'],
    }, actor, {
      destructivePolicyProvider: (): DestructiveAutoApprovalPolicy => ({
        ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
        approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, delete_file: true },
      }),
    });

    const [deletedA, deletedB] = await Promise.all([
      registry.invoke('delete_file', { workspaceId: 'workspace-a', path: 'tmp-a.txt' }),
      registry.invoke('delete_file', { workspaceId: 'workspace-b', path: 'tmp-b.txt' }),
    ]);
    expect(deletedA.isError).not.toBe(true);
    expect(deletedB.isError).not.toBe(true);
    expect(deletes).toBe(2);

    await expect(registry.invoke('delete_file', { workspaceId: 'workspace-a', path: '/opt/project-b/cross.txt' }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('delete_file', { path: 'no-workspace.txt' }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(deletes).toBe(2);
  });
  it('allows non-destructive git commands without confirmation', async () => {
    let executed = 0;
    const registry = new ToolRegistry({
      git: {
        async run(): Promise<ReturnType<typeof ok>> {
          executed += 1;
          return ok({ exitCode: 0, stdout: '', stderr: '' });
        },
      },
    }, actor);

    const response = await registry.invoke('git', { workspaceId: 'workspace-1', args: ['status', '--short'] });
    expect(response.isError).not.toBe(true);
    expect(executed).toBe(1);
  });

  it('requires explicit confirmation for remote DELETE, child MCP calls, and destructive shell commands', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry({
      capabilities: {
        async execute(tool): Promise<ReturnType<typeof ok>> {
          calls.push(tool);
          return ok({ ok: true });
        },
      },
      extensions: {
        async callMcpTool(): Promise<ReturnType<typeof ok>> { calls.push('mcp_call'); return ok({ ok: true }); },
      } as McpApplicationServices['extensions'],
    }, actor);

    await expect(registry.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'DELETE' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('shell', { operation: 'run', executable: 'git', arguments: ['clean', '-fd'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('mcp_call', { server: 'child', tool: 'delete_file', arguments: { path: 'x' } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(calls).toEqual([]);

    expect((await registry.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'DELETE', userConfirmed: true })).isError).not.toBe(true);
    expect((await registry.invoke('shell', { operation: 'run', executable: 'git', arguments: ['clean', '-fd'], userConfirmed: true })).isError).not.toBe(true);
    expect((await registry.invoke('mcp_call', { server: 'child', tool: 'delete_file', arguments: { path: 'x' }, userConfirmed: true })).isError).not.toBe(true);
    expect(calls).toEqual(['web_fetch', 'shell', 'mcp_call']);
  });

  it('guards opaque execution and UI side-effect boundaries', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry({
      capabilities: {
        async execute(tool): Promise<ReturnType<typeof ok>> { calls.push(tool); return ok({ ok: true }); },
      },
      process: {
        async start(): Promise<ReturnType<typeof ok>> { calls.push('process_start'); return ok({ processId: 'p1' }); },
      } as McpApplicationServices['process'],
      codex: {
        async run(): Promise<ReturnType<typeof ok>> { calls.push('codex_run'); return ok({ codexTaskId: 'c1' }); },
      } as McpApplicationServices['codex'],
    }, actor, { codexToolsEnabled: true });

    await expect(registry.invoke('process_start', { workspaceId: 'workspace-1', executable: 'rm', args: ['x.txt'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('codex_run', { workspaceId: 'workspace-1', instruction: 'edit the project' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('dom_cdp', { action: 'evaluate', parameters: { expression: 'fetch("/api/item/1", {method:"DELETE"})' } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('accessibility', { action: 'click', parameters: { name: 'button' } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(calls).toEqual([]);
  });

});
