import path from 'node:path';
import type { PermissionDecision, PermissionProfile } from './types.js';

export type CommandSource = 'client' | 'project';

const SHELL_HOSTS = new Set(['bash', 'sh']);
const DELETE_EXECUTABLES = new Set([
  'rm', 'rmdir', 'unlink',
]);

export interface CommandPolicyOptions {
  /**
   * Full-access mode: Linux shell hosts are allowed.
   * Deletion commands always require confirmation. Every git subcommand is allowed.
   */
  readonly unrestricted?: boolean;
}

export class CommandPolicy {
  public constructor(private readonly options: CommandPolicyOptions = {}) {}

  public decide(profile: PermissionProfile, executable: string, source: CommandSource, args: readonly string[] = []): PermissionDecision {
    void args;
    const basename = path.basename(executable).toLowerCase();
    if (this.options.unrestricted !== true && SHELL_HOSTS.has(basename)) return 'DENY';
    if (DELETE_EXECUTABLES.has(basename)) return 'ASK';

    if (source === 'project') {
      if (!profile.allowedProjectExecutables.includes(basename)) return 'DENY';
      return profile.defaults.EXECUTE;
    }
    if (!profile.allowedProjectExecutables.includes(basename) && profile.name !== 'full') return 'ASK';
    return profile.defaults.EXECUTE;
  }
}
