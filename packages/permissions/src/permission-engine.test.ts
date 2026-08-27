import { describe, expect, it } from 'vitest';
import { permissionProfiles } from './profiles.js';
import { DefaultPermissionEngine } from './permission-engine.js';
import type { OperationDescriptor, PermissionDecision, PermissionLevel } from './types.js';

const engine = new DefaultPermissionEngine();

function operation(level: PermissionLevel, action = 'test_action', destructive = false): OperationDescriptor {
  return { action, level, workspaceId: 'workspace-1', destructive };
}

describe('DefaultPermissionEngine', () => {
  it.each([
    ['safe', 'READ', 'ALLOW'],
    ['safe', 'WRITE', 'ASK'],
    ['safe', 'EXECUTE', 'ASK'],
    ['safe', 'DANGEROUS', 'DENY'],
    ['balanced', 'READ', 'ALLOW'],
    ['balanced', 'WRITE', 'ALLOW'],
    ['balanced', 'EXECUTE', 'ALLOW'],
    ['balanced', 'DANGEROUS', 'ASK'],
    ['full', 'READ', 'ALLOW'],
    ['full', 'WRITE', 'ALLOW'],
    ['full', 'EXECUTE', 'ALLOW'],
    ['full', 'DANGEROUS', 'ALLOW'],
  ] as const)('%s %s decision is %s', (profileName, level, expected) => {
    const decision = engine.decide(permissionProfiles[profileName], operation(level));

    expect(decision).toBe(expected satisfies PermissionDecision);
  });

  it('denies hard-blocked destructive actions even for Full Access', () => {
    const decision = engine.decide(
      permissionProfiles.full,
      operation('DANGEROUS', 'disk_format', true),
    );

    expect(decision).toBe('DENY');
  });

  it('allows git reset and git clean under Full Access', () => {
    expect(engine.decide(permissionProfiles.full, operation('DANGEROUS', 'git_reset', true))).toBe('ALLOW');
    expect(engine.decide(permissionProfiles.full, operation('DANGEROUS', 'git_clean', true))).toBe('ALLOW');
  });

  it('denies destructive workspace-root deletion for every profile', () => {
    const decision = engine.decide(
      permissionProfiles.full,
      { ...operation('DANGEROUS', 'delete_workspace_root', true), target: '.' },
    );

    expect(decision).toBe('DENY');
  });
});
