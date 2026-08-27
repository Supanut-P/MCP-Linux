import { describe, expect, it } from 'vitest';
import { PermissionV2Engine } from './permission-v2.js';
import { permissionProfiles } from './profiles.js';

describe('PermissionV2Engine', () => {
  it('allows unrestricted workspace reads and gates destructive operations', () => {
    const engine = new PermissionV2Engine();
    expect(engine.decide(permissionProfiles.full, { permission: 'filesystem.read', action: 'read .env', workspaceId: 'w', contextRead: true })).toMatchObject({ decision: 'ALLOW', contextAccess: 'unrestricted' });
    expect(engine.decide(permissionProfiles.balanced, { permission: 'filesystem.delete', action: 'delete', workspaceId: 'w' })).toMatchObject({ decision: 'ASK' });
  });

  it('keeps hard blocks independent from the selected profile', () => {
    const engine = new PermissionV2Engine();
    expect(engine.decide(permissionProfiles.full, { permission: 'system.admin', action: 'shutdown', workspaceId: 'w', hardBlocked: true }).decision).toBe('DENY');
  });
});
