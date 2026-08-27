import { describe, expect, it } from 'vitest';
import { DoctorService, type DoctorProbeResult, type DoctorProbes } from './doctor-service.js';

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  const pass = (message: string): Promise<DoctorProbeResult> => Promise.resolve({ status: 'pass', message });
  return {
    os: () => pass('Windows x64'),
    database: () => pass('SQLite ready'),
    git: () => pass('Git ready'),
    ripgrep: () => pass('ripgrep ready'),
    workspaces: () => pass('1 workspace configured'),
    mcpPort: () => pass('MCP port available'),
    codex: () => Promise.resolve({ status: 'warn', message: 'Codex is not installed' }),
    ...overrides,
  };
}

describe('DoctorService', () => {
  it('returns deterministic checks and keeps optional Codex absence non-fatal', async () => {
    const report = await new DoctorService(probes()).run();

    expect(report.exitCode).toBe(0);
    expect(report.checks.map((check) => check.id)).toEqual([
      'os', 'database', 'git', 'ripgrep', 'workspaces', 'mcp-port', 'codex',
    ]);
    expect(report.checks.find((check) => check.id === 'codex')).toMatchObject({ status: 'warn', required: false });
  });

  it('returns a nonzero exit code for a fatal core check', async () => {
    const report = await new DoctorService(probes({
      database: () => Promise.resolve({ status: 'fail', message: 'database unavailable' }),
    })).run();

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((check) => check.id === 'database')).toMatchObject({ status: 'fail', required: true });
  });

  it('redacts credential-shaped diagnostic text', async () => {
    const report = await new DoctorService(probes({
      codex: () => Promise.resolve({ status: 'warn', message: 'TOKEN=do-not-print SECRET:also-private' }),
    })).run();
    const output = JSON.stringify(report);

    expect(output).not.toContain('do-not-print');
    expect(output).not.toContain('also-private');
    expect(output).toContain('[redacted]');
  });
});
