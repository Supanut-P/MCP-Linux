import { describe, expect, it, vi } from 'vitest';
import { appError, err } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry } from '../tool-registry.js';
import type { PermissionProfile } from '@baitonghub-linux-mcp/permissions';

describe('verified skill MCP boundary', () => {
  it('advertises only available READ services in core, rejects forged approvals and never invokes Codex', async () => {
    const unavailable = async (): Promise<ReturnType<typeof err>> => err(appError('CAPABILITY_UNAVAILABLE', 'Fixture stopped'));
    const list = vi.fn(unavailable), load = vi.fn(unavailable), execute = vi.fn(unavailable), run = vi.fn();
    const registry = new ToolRegistry({ verifiedSkills: { list, load }, verifiedWorkflowPlan: { execute }, codex: { run } as never }, { clientId: 'owner', clientName: 'owner' }, { serverProfileProvider: (): 'core' => 'core' });
    for (const name of ['skills_verified_list', 'skills_verified_load', 'workflow_plan_verified']) expect(registry.list().find((tool) => tool.name === name)).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    expect((await registry.invoke('skills_verified_load', { workspaceId: 'w', role: 'worker', skillId: 'mcp-linux-development', approved: true, sha256: 'forged' })).isError).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect((await registry.invoke('skills_verified_list', { workspaceId: 'w', role: 'qa' })).isError).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    await registry.invoke('skills_verified_load', { workspaceId: 'w', role: 'lead', skillId: 'mcp-linux-release' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(new ToolRegistry({}, { clientId: 'owner', clientName: 'owner' }).list().some((tool) => tool.name.startsWith('skills_verified') || tool.name === 'workflow_plan_verified')).toBe(false);
  });
  it('enforces the active READ denial before source loading despite review metadata', async () => {
    const load = vi.fn(async () => err(appError('CAPABILITY_UNAVAILABLE', 'Must not reach service')));
    const profile: PermissionProfile = { name: 'custom', defaults: { READ: 'DENY', WRITE: 'DENY', EXECUTE: 'DENY', DANGEROUS: 'DENY' }, allowedProjectExecutables: [] };
    const registry = new ToolRegistry({ verifiedSkills: { list: load, load } }, { clientId: 'owner', clientName: 'owner' }, { profileProvider: (): PermissionProfile => profile });
    expect(await registry.invoke('skills_verified_load', { workspaceId: 'w', role: 'lead', skillId: 'mcp-linux-development' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(load).not.toHaveBeenCalled();
  });
});
