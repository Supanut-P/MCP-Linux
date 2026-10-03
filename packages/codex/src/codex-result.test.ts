import { describe, expect, it } from 'vitest';
import type { ManagedProcess, ProcessLogResult } from '@baitonghub-linux-mcp/process';
import { parseCodexResult } from './codex-result.js';
import type { ResolvedCodexSelection } from './codex-selection.js';

const selection: ResolvedCodexSelection = { role: 'lead', model: 'gpt-6.1-sol', effort: 'medium' };
const process = (state: ManagedProcess['state'] = 'exited', exitCode = 0): ManagedProcess => ({ processId: 'p', executable: 'codex', args: [], cwd: '.', state, startedAt: 'now', exitCode });
const logs = (...entries: Array<{ sequence: number; stream: 'stdout' | 'stderr'; text: string }>): ProcessLogResult => ({ entries, truncated: false, nextSequence: entries.length });
const message = (text = 'answer'): string => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
const completed = (usage: unknown = { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 }): string => JSON.stringify({ type: 'turn.completed', usage });
const run = (body: string, p = process(), truncated = false): ReturnType<typeof parseCodexResult> => parseCodexResult(p, { ...logs({ sequence: 0, stream: 'stdout', text: body }), truncated }, selection);

describe('parseCodexResult', () => {
  it('does not accept malformed items, unknown protocol events, conflicting terminal events or impossible cache usage', () => {
    for (const event of [{ type: 'item.completed' }, { type: 'item.completed', item: { type: 'agent_message', text: 1 } }, { type: 'unknown.future' }]) {
      expect(run(`${JSON.stringify(event)}\n${completed()}\n`).state).toBe('partial');
    }
    expect(run(`${completed()}\n${completed()}\n`).reasonCodes).toContain('CONFLICTING_TERMINAL');
    expect(run(`${completed({ input_tokens: 1, cached_input_tokens: 2, output_tokens: 1 })}\n`).usage).toBeNull();
    expect(Buffer.byteLength(run(`${message('🌏'.repeat(6000))}\n${completed()}\n`).finalText ?? '', 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });
  it('requires supported terminal evidence and zero exit', () => {
    const result = run(`${message()}\n${completed()}\n`);
    expect(result).toMatchObject({ state: 'completed', finalText: 'answer', usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4 }, protocolIncomplete: false });
    expect(run(`${message()}\n`, process())).toMatchObject({ state: 'partial', protocolIncomplete: true, reasonCodes: expect.arrayContaining(['MISSING_TERMINAL']) });
    expect(run(`${message()}\n${completed()}\n`, process('exited', 2)).state).toBe('failed');
  });
  it('joins split records, sorts by sequence, ignores stderr, and accepts CRLF', () => {
    const records = `${message('hello 🌏')}\r\n${completed()}\r\n`;
    const chunks = [records.slice(0, 10), records.slice(10, 39), records.slice(39)];
    const result = parseCodexResult(process(), { entries: [
      { sequence: 2, stream: 'stdout', text: chunks[2] },
      { sequence: 0, stream: 'stderr', text: `${completed()}\n` },
      { sequence: 0, stream: 'stdout', text: chunks[0] },
      { sequence: 1, stream: 'stdout', text: chunks[1] },
    ], truncated: false, nextSequence: 3 }, selection);
    expect(result).toMatchObject({ state: 'completed', finalText: 'hello 🌏' });
  });
  it('keeps malformed, oversized, evicted, invalid usage, and unterminated data incomplete', () => {
    expect(run(`${message()}\nnot-json\n${completed()}\n`).state).toBe('partial');
    expect(run(`${'x'.repeat(64 * 1024 + 1)}\n${completed()}\n`).reasonCodes).toContain('RECORD_LIMIT');
    expect(run(`${message()}\n${completed()}\n`, process(), true)).toMatchObject({ state: 'partial', reasonCodes: expect.arrayContaining(['LOG_EVICTED']) });
    expect(run(`${message()}\n${completed({ input_tokens: -1 })}\n`)).toMatchObject({ state: 'partial', usage: null, reasonCodes: expect.arrayContaining(['INVALID_USAGE']) });
    expect(run(`${message()}\n${completed()}`).protocolIncomplete).toBe(true);
  });
  it('bounds final text and caps total input', () => {
    const large = run(`${message('z'.repeat(20 * 1024))}\n${completed()}\n`);
    expect(large).toMatchObject({ state: 'completed', truncated: true, finalText: 'z'.repeat(16 * 1024) });
    const huge = run(`${' '.repeat(1024 * 1024 + 1)}\n${completed()}\n`);
    expect(huge).toMatchObject({ protocolIncomplete: true, reasonCodes: expect.arrayContaining(['INPUT_LIMIT']) });
  });
  it('maps provider errors, process failures, timeouts, cancellation, and uncertain termination distinctly', () => {
    expect(run('{"type":"error","message":"The model cannot be used with this account"}\n').reasonCodes).toContain('MODEL_UNAVAILABLE');
    expect(run(`${JSON.stringify({ type: 'error', message: 'private detail' })}\n`).state).toBe('failed');
    expect(run(`${JSON.stringify({ type: 'turn.failed', error: 'private detail' })}\n`).state).toBe('failed');
    expect(run('', process('timed_out', -1))).toMatchObject({ state: 'timed_out', reasonCodes: ['MISSING_TERMINAL', 'PROCESS_TIMED_OUT'] });
    expect(run('', process('stopped', -1)).state).toBe('cancelled');
    expect(run('', process('termination_unverified', -1)).state).toBe('unknown');
    expect(run('', process('starting', -1)).state).toBe('pending');
    expect(run('', process('running', -1)).state).toBe('running');
  });
});
