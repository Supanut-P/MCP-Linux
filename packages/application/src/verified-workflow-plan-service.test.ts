import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@baitonghub-linux-mcp/domain';
import { prepareWorkflowContract } from '@baitonghub-linux-mcp/codex';
import { VerifiedWorkflowPlanService } from './verified-workflow-plan-service.js';
import type { LoadedVerifiedSkill } from './verified-skill-registry-service.js';

const actor = { clientId: 'owner', clientName: 'owner' };
const contract = { taskId: 't1', goal: 'Fix bounded bug', workspaceId: 'ws1', allowedFiles: ['src/a.ts'], dependencies: [], acceptanceCriteria: ['Regression passes'], acceptanceCommands: [{ executable: 'node', args: ['--test'], expectedExitCode: 0, timeoutSeconds: 10 }], contextReferences: [], workerRole: 'coding', plannerRequired: true, securitySensitive: true, stopConditions: ['Stop before deployment'] };
const skill = (content = 'Do not deploy'): LoadedVerifiedSkill => ({
  id: 'mcp-linux-release', name: 'Release', description: 'Reviewed guidance', source: 'repo-local', path: 'docs/skills/mcp-linux-release/SKILL.md',
  reviewRevision: 'review-2026-10-03.1', reviewStatus: 'reviewed', scope: 'single_document', sha256: 'a'.repeat(64), roles: ['lead', 'qa'],
  workspaceId: 'ws1', role: 'lead', rootFingerprint: 'root', licensePath: 'LICENSE', licenseSha256: 'b'.repeat(64), licenseReviewStatus: 'reviewed', reviewScope: 'single_document', scriptsLoaded: false, hooksLoaded: false, permissionsGranted: false, content, verification: 'verified',
});
const request = { contract, skillIds: ['mcp-linux-release'] };
function setup(load = vi.fn(async () => ok(skill()))): { load: typeof load; execute: ReturnType<typeof vi.fn<(actor: unknown, input: unknown) => Promise<ReturnType<typeof prepareWorkflowContract>>>>; service: VerifiedWorkflowPlanService } {
  const execute = vi.fn(async (_actor: unknown, input: unknown) => prepareWorkflowContract(input));
  return { load, execute, service: new VerifiedWorkflowPlanService({ plans: { execute }, skills: { load } }) };
}

describe('verified workflow preparation', () => {
  it('loads once, keeps immutable safety first, and includes guidance only for eligible roles', async () => {
    const { service, load } = setup();
    const result = await service.execute(actor, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.value).toMatchObject({ dispatch: 'caller_native', executionStarted: false, availability: 'not_verified' });
    const original = prepareWorkflowContract(contract);
    if (!original.ok) throw new Error('Invalid fixture');
    for (const role of result.value.rolePrompts) {
      expect(role.prompt.startsWith(original.value.rolePrompts.find((item) => item.role === role.role)!.prompt)).toBe(true);
      expect(role.prompt.includes('Verified source guidance')).toBe(role.role === 'lead' || role.role === 'qa');
      expect(Buffer.byteLength(role.prompt)).toBeLessThanOrEqual(role.role === 'qa' ? 65_536 : 32_768);
    }
    expect(result.value.verifiedSkills[0]).not.toHaveProperty('content');
    expect(original.value.rolePrompts.every((role) => !role.prompt.includes('Verified source guidance'))).toBe(true);
  });

  it('rejects forged fields, duplicate/oversize IDs and invalid contracts before loading', async () => {
    const { service, load } = setup();
    for (const input of [null, [], { ...request, approved: true }, { ...request, skillIds: [] }, { ...request, skillIds: ['x', 'x'] }, { ...request, skillIds: ['界'.repeat(50)] }, { ...request, contract: { ...contract, execute: true } }]) {
      expect((await service.execute(actor, input)).ok).toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('fails the whole plan on failed selection or prompt overflow without returning partial guidance', async () => {
    const failed = new VerifiedWorkflowPlanService({ plans: { execute: async (_actor, input): Promise<ReturnType<typeof prepareWorkflowContract>> => prepareWorkflowContract(input) }, skills: { load: async (): Promise<ReturnType<typeof err>> => err(appError('INVALID_INPUT', 'Unverified source')) } });
    expect(await failed.execute(actor, request)).toMatchObject({ ok: false });
    const { service } = setup(vi.fn(async () => ok(skill('x'.repeat(32_768)))));
    expect(await service.execute(actor, request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('stops on cancellation before dispatch or after a source read and sanitizes port exceptions', async () => {
    const controller = new AbortController(); controller.abort();
    const first = setup();
    expect(await first.service.execute(actor, request, controller.signal)).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(first.execute).not.toHaveBeenCalled();
    const later = new AbortController();
    const second = setup(vi.fn(async () => { later.abort(); return ok(skill()); }));
    expect(await second.service.execute(actor, request, later.signal)).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    const throwing = setup(vi.fn(async () => { throw new Error('SECRET_CANARY'); }));
    expect(JSON.stringify(await throwing.service.execute(actor, request))).not.toContain('SECRET_CANARY');
  });
});
