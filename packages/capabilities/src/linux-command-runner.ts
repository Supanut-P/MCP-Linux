import { spawn as spawnChild } from 'node:child_process';

export interface LinuxCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface LinuxSpawnOptions {
  readonly shell: false;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly input?: string;
  readonly maxBytes: number;
}

export type LinuxSpawn = (
  executable: string,
  args: readonly string[],
  options: LinuxSpawnOptions,
) => Promise<LinuxCommandResult | Omit<LinuxCommandResult, 'truncated'> & { readonly truncated?: boolean }>;

export interface LinuxCommandRunnerOptions {
  readonly allowedExecutables: readonly string[];
  readonly maxBytes?: number;
  readonly spawn?: LinuxSpawn;
}

/** Fixed-binary, argv-only subprocess boundary for Linux capability providers. */
export class LinuxCommandRunner {
  private readonly maxBytes: number;
  private readonly spawn: LinuxSpawn;

  public constructor(private readonly options: LinuxCommandRunnerOptions) {
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.spawn = options.spawn ?? spawnProcess;
  }

  public async run(executable: string, args: readonly string[], signal?: AbortSignal, cwd?: string): Promise<LinuxCommandResult> {
    if (!this.isAllowed(executable)) throw new Error('Executable is not allowlisted');
    if (signal !== undefined && signal.aborted) return { exitCode: null, stdout: '', stderr: '', truncated: false };
    const result = await this.spawn(executable, [...args], {
      shell: false,
      ...(cwd === undefined ? {} : { cwd }),
      maxBytes: this.maxBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated === true,
    };
  }

  private isAllowed(executable: string): boolean {
    if (this.options.allowedExecutables.includes(executable)) return true;
    const basename = executable.replace(/^.*[\\/]/, '');
    return this.options.allowedExecutables.includes(basename);
  }
}

async function spawnProcess(
  executable: string,
  args: readonly string[],
  options: LinuxSpawnOptions,
): Promise<LinuxCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(executable, [...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let truncated = false;
    let settled = false;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (outputBytes >= options.maxBytes) {
        truncated = true;
        return;
      }
      const remaining = options.maxBytes - outputBytes;
      const bytes = chunk.subarray(0, remaining);
      outputBytes += bytes.byteLength;
      if (bytes.byteLength < chunk.byteLength) truncated = true;
      if (target === 'stdout') stdout += bytes.toString('utf8');
      else stderr += bytes.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error: Error & { readonly code?: string }) => {
      if (settled) return;
      if (error.name === 'AbortError') {
        settled = true;
        resolve({ exitCode: null, stdout, stderr, truncated });
        return;
      }
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr, truncated });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
