import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { CodexDiscovery, DirectCodexCommandRunner, formatCodexDiscoveryError, type CodexCommandResult, type CodexCommandRunner, type CodexExecutableResolver } from './codex-discovery.js';

describe('CodexDiscovery', () => {
  it('discovers version and supported instruction capabilities without reading credentials', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const resolver: CodexExecutableResolver = { async resolve(): Promise<Result<string>> { return ok('/opt/codex/bin/codex'); } };
    const runner: CodexCommandRunner = {
      async run(executable, args): Promise<CodexCommandResult> {
        calls.push({ executable, args });
        return args[0] === '--version'
          ? { exitCode: 0, stdout: 'codex 0.42.1\\n', stderr: '' }
          : { exitCode: 0, stdout: 'Usage: codex [OPTIONS]\\nCommands:\\n  exec  run a task\\nOptions:\\n  --prompt <TEXT>\\n', stderr: '' };
      },
    };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toMatchObject({ ok: true, value: { status: {
      installed: true,
      executablePath: '/opt/codex/bin/codex',
      version: '0.42.1',
    } } });
    if (result.ok) expect(result.value.capabilities.instructionMode).toBe('exec-argument');
    expect(calls).toEqual([
      { executable: '/opt/codex/bin/codex', args: ['--version'] },
      { executable: '/opt/codex/bin/codex', args: ['--help'] },
    ]);
  });

  it('reports not installed without attempting any command or credential lookup', async () => {
    let runs = 0;
    const resolver: CodexExecutableResolver = {
      async resolve(): Promise<Result<string>> {
        return err({ code: 'EXECUTABLE_NOT_FOUND', message: 'not found', recoverable: true });
      },
    };
    const runner: CodexCommandRunner = { async run(): Promise<CodexCommandResult> { runs += 1; return { exitCode: 0, stdout: '', stderr: '' }; } };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toEqual({ ok: true, value: { status: { installed: false, capabilities: [] }, capabilities: { instructionMode: null, names: [] } } });
    expect(runs).toBe(0);
  });

  it('reports a sanitized spawn error and the version discovery stage', async () => {
    const fakeExecutable = path.join(os.homedir(), 'tools', 'codex');
    const resolver: CodexExecutableResolver = { async resolve(): Promise<Result<string>> { return ok(fakeExecutable); } };
    const runner: CodexCommandRunner = {
      async run(): Promise<CodexCommandResult> {
        return Object.assign(
          { exitCode: -1, stdout: '', stderr: '' },
          { spawnErrorCode: 'EACCES' as const },
        );
      },
    };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CODEX_NOT_AVAILABLE',
        message: 'Codex --version check failed',
        recoverable: true,
        details: {
          stage: '--version',
          executablePath: `$HOME${path.sep}tools${path.sep}codex`,
          spawnErrorCode: 'EACCES',
          exitCode: -1,
        },
      },
    });
  });

  it('reports the help discovery stage when help invocation cannot start', async () => {
    const fakeExecutable = path.join(path.parse(os.homedir()).root, 'tools', 'codex');
    const resolver: CodexExecutableResolver = { async resolve(): Promise<Result<string>> { return ok(fakeExecutable); } };
    let invocation = 0;
    const runner: CodexCommandRunner = {
      async run(): Promise<CodexCommandResult> {
        invocation += 1;
        return invocation === 1
          ? { exitCode: 0, stdout: 'codex 0.42.1\n', stderr: '' }
          : Object.assign(
            { exitCode: -1, stdout: '', stderr: '' },
            { spawnErrorCode: 'EPERM' as const },
          );
      },
    };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CODEX_NOT_AVAILABLE',
        message: 'Codex --help check failed',
        details: {
          stage: '--help',
          executablePath: path.basename(fakeExecutable),
          spawnErrorCode: 'EPERM',
          exitCode: -1,
        },
      },
    });
  });

  it('marks resolver failures with the resolve discovery stage', async () => {
    const resolver: CodexExecutableResolver = {
      async resolve(): Promise<Result<string>> {
        return err({ code: 'INTERNAL_ERROR', message: 'resolver failed', recoverable: true });
      },
    };
    const runner: CodexCommandRunner = { async run(): Promise<CodexCommandResult> { throw new Error('must not run'); } };

    const result = await new CodexDiscovery(resolver, runner).discover();

    expect(result).toMatchObject({ ok: false, error: { details: { stage: 'resolve' } } });
  });

  it('preserves ENOENT from a direct spawn failure', async () => {
    const missingExecutable = path.join(os.tmpdir(), `baitonghub-linux-mcp-missing-codex-${process.pid}-${Date.now()}`);

    const result = await new DirectCodexCommandRunner().run(missingExecutable, ['--version']);

    expect(result).toMatchObject({ exitCode: -1, spawnErrorCode: 'ENOENT' });
  });

  it('formats only the allowlisted discovery diagnostics for a user-facing error', () => {
    const message = formatCodexDiscoveryError({
      code: 'CODEX_NOT_AVAILABLE',
      message: 'Codex --version check failed',
      recoverable: true,
      details: {
        stage: '--version',
        executablePath: '$HOME/tools/codex',
        spawnErrorCode: 'EACCES',
        exitCode: -1,
        secret: 'must-not-display',
      },
    });

    expect(message).toBe('Codex --version check failed (stage=--version, executable=$HOME/tools/codex, spawnErrorCode=EACCES, exitCode=-1)');
    expect(message).not.toContain('must-not-display');
  });
});
