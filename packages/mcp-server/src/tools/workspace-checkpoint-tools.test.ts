import { describe, expect, it } from 'vitest';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import { ContextEconomyRuntime } from '../context-economy.js';
import { workspaceCheckpointTools } from './workspace-checkpoint-tools.js';

describe('workspace_checkpoint tool', () => {
  it('is advertised as a bounded state operation with strict input', () => {
    const actor: FileActor = { clientId: 'client-a', clientName: 'Client A' };
    const tools = workspaceCheckpointTools({
      actor,
      services: { workspaceCheckpoint: { execute: async () => ({ ok: true as const, value: { operation: 'list' as const, checkpoints: [], count: 0, truncated: false } }) } },
      contextEconomy: new ContextEconomyRuntime(),
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'workspace_checkpoint', permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(tools[0]?.parse({ operation: 'create', workspaceId: 'ws-1', unexpected: true })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
