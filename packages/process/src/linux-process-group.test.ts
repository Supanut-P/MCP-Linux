import { describe, expect, it } from 'vitest';
import { memberMayExecute, parseLinuxProcessStat, sameLinuxGroupMember } from './linux-process-group.js';

function stat(state = 'S'): string {
  return `42 (name with ) spaces) ${[state, '1', '42', '42', ...Array<string>(15).fill('0'), '123'].join(' ')}\n`;
}

describe('bounded Linux stat identity', () => {
  it('parses the final parenthesis and preserves kernel identity fields', () => {
    const member = parseLinuxProcessStat(42, stat());
    expect(member).toEqual({ pid: 42, groupId: 42, sessionId: 42, startTime: '123', state: 'S' });
    expect(memberMayExecute(member)).toBe(true);
    expect(memberMayExecute({ ...member, state: 'Z' })).toBe(false);
    expect(sameLinuxGroupMember(member, { ...member, startTime: '124' })).toBe(false);
    expect(sameLinuxGroupMember(member, { ...member, sessionId: 43 })).toBe(false);
  });

  it('rejects malformed, wrong PID and unknown execution state', () => {
    for (const text of ['42', stat('?'), stat().replace('123', 'NaN')]) expect(() => parseLinuxProcessStat(42, text)).toThrow();
    expect(() => parseLinuxProcessStat(43, stat())).toThrow();
  });
});
