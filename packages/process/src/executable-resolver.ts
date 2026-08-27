import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '@baitonghub-linux-mcp/domain';

export interface ExecutableResolver {
  resolve(executable: string): Promise<Result<string>>;
}

export class PathExecutableResolver implements ExecutableResolver {
  public constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  public async resolve(executable: string): Promise<Result<string>> {
    if (executable.trim().length === 0) return err({ code: 'INVALID_INPUT', message: 'Executable is required', recoverable: false });
    const pathEntries = (this.environment.PATH ?? '').split(path.delimiter).filter(Boolean);
    const hasPath = path.isAbsolute(executable) || executable.includes(path.sep) || executable.includes('/') || executable.includes('\\');
    const candidates = hasPath ? [executable] : pathEntries.map((entry) => path.join(entry, executable));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.F_OK);
        if ((await stat(candidate)).isFile()) return ok(candidate);
      } catch {
        continue;
      }
    }
    return err({ code: 'EXECUTABLE_NOT_FOUND', message: `Executable '${executable}' was not found`, recoverable: true });
  }

}
