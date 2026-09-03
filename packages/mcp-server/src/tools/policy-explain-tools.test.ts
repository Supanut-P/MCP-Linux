import { describe, expect, it } from 'vitest';
import { permissionProfiles } from '@baitonghub-linux-mcp/permissions';
import type { Result } from '@baitonghub-linux-mcp/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { policyExplainTools } from './policy-explain-tools.js';
import type { McpToolContext, McpToolDefinition } from './tool-types.js';

function makeContext(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    actor: { clientId: 'test', clientName: 'test' },
    contextEconomy: new ContextEconomyRuntime(),
    services: {},
    serverProfile: 'full',
    ...overrides,
  } as McpToolContext;
}

function executePolicy(
  input: unknown,
  context: McpToolContext,
  visible: readonly McpToolDefinition[],
  profile = permissionProfiles.full,
): Promise<Result<unknown>> {
  const tool = policyExplainTools(context, () => visible, () => profile)[0];
  return tool.execute(input, new AbortController().signal);
}

describe('policy_explain', () => {
  it('reports profile approval without executing or granting a write tool', async () => {
    const visible = [{
      name: 'write_file',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
    }] as unknown as McpToolDefinition[];
    const result = await executePolicy({ tool: 'write_file', workspaceId: 'workspace-1' }, makeContext(), visible, permissionProfiles.safe);

    expect(result).toMatchObject({
      ok: true,
      value: {
        tool: 'write_file',
        allowed: false,
        available: true,
        reasonCode: 'PROFILE_REQUIRES_APPROVAL',
        permission: 'WRITE',
        requiredProfile: 'balanced',
      },
    });
  });

  it('reports capability and registered-root prerequisites as separate reasons', async () => {
    const visible = [{
      name: 'shell',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
    }] as unknown as McpToolDefinition[];
    const missingCapability = await executePolicy({ tool: 'shell', workspaceId: 'workspace-1' }, makeContext({
      services: { capabilities: { listTools: () => [], execute: async () => ({ ok: true, value: {} }) } } as never,
    }), visible, permissionProfiles.balanced);
    expect(missingCapability).toMatchObject({ ok: true, value: { reasonCode: 'CAPABILITY_UNAVAILABLE', available: false, allowed: false } });

    const missingRoot = await executePolicy({ tool: 'shell' }, makeContext({
      services: { capabilities: { listTools: () => ['shell'], execute: async () => ({ ok: true, value: {} }) } } as never,
    }), visible, permissionProfiles.balanced);
    expect(missingRoot).toMatchObject({ ok: true, value: { reasonCode: 'REGISTERED_ROOT_REQUIRED', available: true, allowed: false } });
  });

  it('returns a generic unavailable result for hidden or unknown tools', async () => {
    const result = await executePolicy({ tool: 'secret_internal_tool' }, makeContext(), []);
    expect(result).toMatchObject({
      ok: true,
      value: { tool: 'secret_internal_tool', available: false, allowed: false, reasonCode: 'TOOL_NOT_AVAILABLE' },
    });
  });

  it('reports confirmation requirements for destructive operations', async () => {
    const visible = [{
      name: 'shell',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
    }] as unknown as McpToolDefinition[];
    const result = await executePolicy({ tool: 'shell', workspaceId: 'workspace-1', executable: 'rm', arguments: ['-f', 'file'] }, makeContext({
      services: { capabilities: { listTools: () => ['shell'], execute: async () => ({ ok: true, value: {} }) } } as never,
    }), visible, permissionProfiles.full);
    expect(result).toMatchObject({ ok: true, value: { reasonCode: 'CONFIRMATION_REQUIRED', requiresConsent: true, allowed: false } });
  });
});
