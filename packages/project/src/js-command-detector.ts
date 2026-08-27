import { appError, err, ok, type CommandSpec, type Result } from '@baitonghub-linux-mcp/domain';
import type { ProjectCommandKind, ProjectProfile } from './project-profile.js';

export class JsCommandDetector {
  public getCommand(profile: ProjectProfile, kind: ProjectCommandKind): Result<CommandSpec> {
    if (profile.scripts[kind] === undefined) {
      return err(appError('INVALID_INPUT', `Project script '${kind}' is not defined`));
    }
    if (profile.packageManager === 'unknown') {
      return err(appError('INVALID_INPUT', 'Project package manager could not be detected'));
    }
    return ok({
      executable: profile.packageManager,
      args: profile.packageManager === 'npm' ? ['run', kind] : [kind],
    });
  }
}
