import { appError, err } from '@baitonghub-linux-mcp/domain';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../tool-registry.js';
import { workflowPlanSchema } from './schemas.js';

const contract = {
  taskId: 'fix-version-links',
  goal: 'Update current release references',
  workspaceId: 'registered-project',
  allowedFiles: ['scripts/set-version.mjs'],
  dependencies: [],
  acceptanceCriteria: ['Current references update and history stays intact'],
  acceptanceCommands: [{ executable: 'node', args: ['--test'], expectedExitCode: 0, timeoutSeconds: 30 }],
  contextReferences: ['docs/harness/contracts/v1.38-native-workflow.md'],
  workerRole: 'debugging' as const,
  plannerRequired: false,
  securitySensitive: false,
  stopConditions: ['Stop before external writes'],
};

describe('workflow plan MCP surface', () => {
  it('prepares only through the registered service without implicit Codex execution', async () => {
    const execute = vi.fn(async (...input: unknown[]) => { void input; return err(appError('CAPABILITY_UNAVAILABLE', 'Fixture preparation stopped')); });
    const run = vi.fn();
    const registry = new ToolRegistry({ workflowPlan: { execute }, codex: { run } as never }, { clientId: 'owner', clientName: 'owner' }, { serverProfileProvider: (): 'core' => 'core' });
    const tool = registry.list().find((item) => item.name === 'workflow_plan');
    expect(tool).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    const response = await registry.invoke('workflow_plan', contract);
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'CAPABILITY_UNAVAILABLE' } } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual(contract);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not advertise an unavailable planning service', () => {
    const registry = new ToolRegistry({}, { clientId: 'owner', clientName: 'owner' });
    expect(registry.list().some((tool) => tool.name === 'workflow_plan')).toBe(false);
  });

  it('rejects extra authority fields before dispatch', async () => {
    const execute = vi.fn(async (...input: unknown[]) => { void input; return err(appError('CAPABILITY_UNAVAILABLE', 'Fixture preparation stopped')); });
    const registry = new ToolRegistry({ workflowPlan: { execute } }, { clientId: 'owner', clientName: 'owner' });
    const response = await registry.invoke('workflow_plan', { ...contract, userConfirmed: true, execute: true });
    expect(response.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires explicit stop conditions and bounds acceptance commands', () => {
    expect(workflowPlanSchema.safeParse(contract).success).toBe(true);
    expect(workflowPlanSchema.safeParse({ ...contract, stopConditions: [] }).success).toBe(false);
    expect(workflowPlanSchema.safeParse({ ...contract, acceptanceCommands: [{ ...contract.acceptanceCommands[0], timeoutSeconds: 601 }] }).success).toBe(false);
    expect(workflowPlanSchema.safeParse({ ...contract, workerRole: 'administrator' }).success).toBe(false);
  });
});
