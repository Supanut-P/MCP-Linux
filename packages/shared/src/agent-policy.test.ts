import { describe, expect, it } from 'vitest';
import {
  isProtectedCriticalPath,
  parseAllowedRoots,
  parseBooleanSetting,
  parseDestructiveAutoApprovalPolicy,
  parseStdioPermissionProfile,
  serializeAllowedRoots,
  serializeDestructiveAutoApprovalPolicy,
} from './agent-policy.js';

describe('agent policy settings', () => {
  it('parses boolean settings with a fallback', () => {
    expect(parseBooleanSetting('true')).toBe(true);
    expect(parseBooleanSetting('0', true)).toBe(false);
    expect(parseBooleanSetting('unknown', true)).toBe(true);
  });

  it('parses stdio profiles without accepting unknown values', () => {
    expect(parseStdioPermissionProfile('safe')).toBe('safe');
    expect(parseStdioPermissionProfile('CUSTOM')).toBe('custom');
    expect(parseStdioPermissionProfile('unknown')).toBe('full');
  });

  it('parses and serializes distinct allowed roots', () => {
    expect(parseAllowedRoots('D:\\one;D:\\two\nD:\\ONE')).toEqual(['D:\\one', 'D:\\two']);
    expect(serializeAllowedRoots(['D:\\one', 'D:\\one', 'E:\\two'])).toBe('D:\\one;E:\\two');
  });

  it('defaults every destructive auto-approval family off on a fresh install', () => {
    const parsed = parseDestructiveAutoApprovalPolicy(null, false);
    expect(parsed.protectCriticalFiles).toBe(true);
    expect(parsed.recoverableDelete).toBe(true);
    expect(Object.values(parsed.approvals).every((enabled) => enabled === false)).toBe(true);
  });

  it('migrates the legacy AI delete toggle without enabling other destructive families', () => {
    const parsed = parseDestructiveAutoApprovalPolicy(null, true);
    expect(parsed.protectCriticalFiles).toBe(true);
    expect(parsed.recoverableDelete).toBe(true);
    expect(parsed.approvals.delete_file).toBe(true);
    expect(Object.entries(parsed.approvals).filter(([key]) => key !== 'delete_file').every(([, enabled]) => enabled === false)).toBe(true);
  });

  it('round-trips the fine-grained destructive policy', () => {
    const parsed = parseDestructiveAutoApprovalPolicy(JSON.stringify({
      protectCriticalFiles: false,
      recoverableDelete: true,
      approvals: { git_rm: true, shell_rm_unlink: true },
    }));
    expect(parsed.approvals.git_rm).toBe(true);
    expect(parsed.approvals.shell_rm_unlink).toBe(true);
    expect(parsed.approvals.git_clean).toBe(false);
    expect(parseDestructiveAutoApprovalPolicy(serializeDestructiveAutoApprovalPolicy(parsed))).toEqual(parsed);
  });

  it('recognizes protected critical files without blocking templates', () => {
    for (const critical of ['.env', '.env.production', '.git/config', 'package.json', 'pnpm-lock.yaml', 'secrets.json', 'server.key', 'prod.sqlite']) {
      expect(isProtectedCriticalPath(critical), critical).toBe(true);
    }
    for (const safe of ['.env.example', '.env.sample', 'src/app.ts', 'notes.txt']) {
      expect(isProtectedCriticalPath(safe), safe).toBe(false);
    }
  });
});
