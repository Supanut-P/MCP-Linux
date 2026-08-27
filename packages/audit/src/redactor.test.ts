import { describe, expect, it } from 'vitest';
import { codexInstructionSummary, Redactor } from './redactor.js';

describe('Redactor', () => {
  it('redacts bearer tokens, API key values, and secret-like environment keys recursively', () => {
    const value = {
      headers: { Authorization: 'Bearer super-secret-token' },
      env: { API_KEY: 'api-secret', NORMAL_VALUE: 'safe' },
      note: 'Authorization: Bearer inline-token TOKEN=inline-secret sk-proj-secret',
    };

    const redacted = new Redactor().redact(value);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('api-secret');
    expect(serialized).not.toContain('inline-token');
    expect(serialized).not.toContain('inline-secret');
    expect(serialized).not.toContain('sk-proj-secret');
    expect(redacted).toMatchObject({ env: { NORMAL_VALUE: 'safe' } });
  });

  it('summarizes Codex instructions by task id, byte length, and SHA-256 only', () => {
    const summary = codexInstructionSummary('task-1', 'review this file');

    expect(summary).toEqual({
      codexTaskId: 'task-1',
      instructionLength: 16,
      instructionSha256: '4b7cf767f78b3e0f3410ebb983d8152d58562eda4f0ee184156f9faf477fe234',
    });
    expect(JSON.stringify(summary)).not.toContain('review this file');
  });
});
