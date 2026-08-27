import { describe, expect, it } from 'vitest';
import { permissionProfiles } from './profiles.js';
import { CommandPolicy } from './command-policy.js';

const policy = new CommandPolicy();

describe('CommandPolicy', () => {
  it('allows a detected project package command in Balanced', () => {
    expect(policy.decide(permissionProfiles.balanced, 'pnpm', 'project')).toBe('ALLOW');
  });

  it('asks before an unknown client executable in Balanced', () => {
    expect(policy.decide(permissionProfiles.balanced, 'custom-tool', 'client')).toBe('ASK');
  });

  it('denies shell hosts even when presented as a project command', () => {
    expect(policy.decide(permissionProfiles.balanced, 'bash', 'project')).toBe('DENY');
    expect(policy.decide(permissionProfiles.full, 'sh', 'project')).toBe('DENY');
  });

  it('asks before delete/remove executables', () => {
    expect(policy.decide(permissionProfiles.full, 'rm', 'client', ['-rf', 'tmp'])).toBe('ASK');
    expect(policy.decide(permissionProfiles.full, 'unlink', 'client', ['file.txt'])).toBe('ASK');
  });

  it('asks before every execute operation in Safe', () => {
    expect(policy.decide(permissionProfiles.safe, 'pnpm', 'project')).toBe('ASK');
  });
});

describe('CommandPolicy unrestricted', () => {
  const unrestricted = new CommandPolicy({ unrestricted: true });

  it('allows shell hosts in unrestricted mode', () => {
    expect(unrestricted.decide(permissionProfiles.full, 'bash', 'client')).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'sh', 'client')).toBe('ALLOW');
  });

  it('asks before delete/remove executables in unrestricted mode', () => {
    expect(unrestricted.decide(permissionProfiles.full, 'rm', 'client', ['-rf', 'tmp'])).toBe('ASK');
    expect(unrestricted.decide(permissionProfiles.full, 'unlink', 'client', ['file.txt'])).toBe('ASK');
  });

  it('allows every git subcommand including rm, clean, and reset', () => {
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['init'])).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['rm', '-rf', 'old.txt'])).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['clean', '-fd'])).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['reset', '--hard'])).toBe('ALLOW');
    expect(unrestricted.decide(permissionProfiles.full, 'git', 'client', ['push', '-u', 'origin', 'main'])).toBe('ALLOW');
  });
});
