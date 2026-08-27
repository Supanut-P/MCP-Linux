import type { PermissionDecision, PermissionProfile, OperationDescriptor } from './types.js';

const HARD_BLOCKED_ACTIONS = new Set([
  'arbitrary_elevation',
  'delete_outside_workspace',
  'delete_workspace_root',
  'disk_format',
  'kill_unowned_process',
  'registry_delete',
  'system_reboot',
  'system_shutdown',
]);

export interface PermissionEngine {
  decide(profile: PermissionProfile, operation: OperationDescriptor): PermissionDecision;
}

export class DefaultPermissionEngine implements PermissionEngine {
  public decide(profile: PermissionProfile, operation: OperationDescriptor): PermissionDecision {
    if (operation.destructive && HARD_BLOCKED_ACTIONS.has(operation.action.toLowerCase())) {
      return 'DENY';
    }
    return profile.defaults[operation.level];
  }
}
