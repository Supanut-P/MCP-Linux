import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const ids = ['small_edit', 'bugfix', 'refactor', 'context_retrieval', 'incident_diagnosis', 'resume'];
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-benchmark-report-'));
  const fixtures = [];
  const runs = [];
  await writeFile(path.join(directory, 'context.txt'), 'Explicit fixture context.');
  await writeFile(path.join(directory, 'usage.jsonl'), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 } }) + '\n');
  for (const id of ids) {
    const source = JSON.stringify({ id, source: 'fixture' });
    const acceptance = JSON.stringify({ id, expected: 'fixture' });
    await writeFile(path.join(directory, `source-${id}.json`), source);
    await writeFile(path.join(directory, `acceptance-${id}.json`), acceptance);
    const sourceFingerprint = sha(source), acceptanceFingerprint = sha(acceptance);
    fixtures.push({ id, sourceFingerprint, acceptanceFingerprint, variants: { single: [{ id: 'lead-1', role: 'lead' }], routed: [{ id: 'lead-1', role: 'lead' }] } });
    for (const variant of ['single', 'routed']) runs.push({ fixtureId: id, variant, sourceFingerprint, acceptanceFingerprint, outcome: 'passed', safetyPassed: true, invocations: [{ id: 'lead-1', role: 'lead', provider: 'fixture', model: 'fixture', effort: 'low', contextPath: 'context.txt', logPath: 'usage.jsonl', elapsedMs: 1, logTruncated: false }] });
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schema: 1, fixtures }));
  await writeFile(path.join(directory, 'runs.json'), JSON.stringify(runs));
  return directory;
}
async function report(directory: string): Promise<{ stdout: string; stderr: string }> {
  return execute(process.execPath, [path.join(root, 'scripts/report-workflow-benchmark.mjs'), '--evidence-dir', directory], { cwd: root, maxBuffer: 256 * 1024 });
}
async function cleanup(directory: string): Promise<void> {
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mcp-benchmark-report-')) throw new Error('Unexpected cleanup target');
  await rm(directory, { recursive: true, force: true });
}
describe('bounded workflow benchmark evidence CLI', () => {
  it('verifies source and evidence hashes without exposing raw context/logs, and rejects changed source', async () => {
    const directory = await fixture();
    try {
      const result = await report(directory);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.report.single.medianTotalTokens).toBe(25);
      expect(parsed.report.routed.passedRuns).toBe(6);
      expect(parsed.report.status).toBe('missed');
      expect(parsed.artifacts.every((x: { sha256: string }) => /^[a-f0-9]{64}$/.test(x.sha256))).toBe(true);
      expect(result.stdout).not.toContain('Explicit fixture context.');
      await writeFile(path.join(directory, 'source-bugfix.json'), 'changed');
      await expect(report(directory)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('WORKFLOW_BENCHMARK_INVALID') });
    } finally { await cleanup(directory); }
  });
  it.skipIf(process.platform === 'win32')('rejects linked evidence files before report construction', async () => {
    const directory = await fixture();
    try {
      await rm(path.join(directory, 'context.txt'));
      await symlink(path.join(directory, 'source-bugfix.json'), path.join(directory, 'context.txt'));
      await expect(report(directory)).rejects.toMatchObject({ code: 1 });
    } finally { await cleanup(directory); }
  });
});
