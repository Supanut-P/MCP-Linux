import { describe, expect, it } from 'vitest';
import { createApprovalReceipt } from './approval-receipt.js';

describe('approval receipts', () => {
  it('is stable for the same non-secret metadata and changes by actor', () => {
    const input = { toolName: 'remote_rollout', actorId: 'actor-a', workspaceId: 'workspace-1', targetSummary: 'host:vm103 service:app.service', previewHash: 'a'.repeat(64), profile: 'full', decision: 'ALLOW' } as const;
    expect(createApprovalReceipt(input)).toEqual(createApprovalReceipt(input));
    expect(createApprovalReceipt(input).id).not.toBe(createApprovalReceipt({ ...input, actorId: 'actor-b' }).id);
  });

  it('stores only a target hash and redacts credential-like target text before hashing', () => {
    const receipt = createApprovalReceipt({ toolName: 'support_bundle', actorId: 'actor-a', targetSummary: '/workspace/support.tar.gz api_key=super-secret', profile: 'full', decision: 'CONFIRMED' });
    expect(receipt).not.toHaveProperty('targetSummary');
    expect(JSON.stringify(receipt)).not.toMatch(/workspace\/support|super-secret|api_key/i);
    expect(receipt.targetSummaryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not include confirmation time for denied decisions', () => {
    const receipt = createApprovalReceipt({ toolName: 'remote_rollout', actorId: 'actor-a', profile: 'balanced', decision: 'DENY' });
    expect(receipt).not.toHaveProperty('confirmedAt');
  });
});
