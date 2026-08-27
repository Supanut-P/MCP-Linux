import { describe, expect, it } from 'vitest';
import { formatDoctorReport, runDoctorCommand } from './doctor.js';

const report = {
  exitCode: 0 as const,
  checks: [
    { id: 'os' as const, required: true, status: 'pass' as const, message: 'Windows x64' },
    { id: 'codex' as const, required: false, status: 'warn' as const, message: 'Codex is not installed' },
  ],
};

describe('doctor CLI command', () => {
  it('formats checks without exposing extra data', () => {
    expect(formatDoctorReport(report)).toBe('[PASS] os: Windows x64\n[WARN] codex: Codex is not installed');
  });

  it('returns the doctor exit code and writes the formatted report', async () => {
    const output: string[] = [];
    const exitCode = await runDoctorCommand({ run: async () => report }, (text) => output.push(text));

    expect(exitCode).toBe(0);
    expect(output).toEqual(['[PASS] os: Windows x64\n[WARN] codex: Codex is not installed']);
  });
});
