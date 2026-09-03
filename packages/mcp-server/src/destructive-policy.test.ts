import { describe, expect, it } from 'vitest';
import { inspectDestructiveOperation } from './destructive-policy.js';

describe('central destructive policy', () => {
  it.each([
    [['reset', '--hard'], true],
    [['clean', '-fd'], true],
    [['rm', 'file.txt'], true],
    [['checkout', '--', 'file.txt'], true],
    [['checkout', '-B', 'main', 'HEAD~1'], true],
    [['switch', '-C', 'main', 'HEAD~1'], true],
    [['branch', '-f', 'main', 'HEAD~1'], true],
    [['branch', '-D', 'old'], true],
    [['tag', '-f', 'v1'], true],
    [['stash', 'pop'], true],
    [['stash', 'clear'], true],
    [['reflog', 'expire', '--expire=now', '--all'], true],
    [['push', '--force', 'origin', 'main'], true],
    [['status', '--short'], false],
    [['diff'], false],
    [['reflog', 'show'], false],
  ])('classifies git %j destructive=%s', (args, destructive) => {
    expect(inspectDestructiveOperation('git', { args }).destructive).toBe(destructive);
  });

  it('detects destructive commands hidden behind process_start node scripts', () => {
    expect(inspectDestructiveOperation('process_start', {
      executable: 'node',
      args: ['-e', "require('fs').rmSync('x', { recursive: true })"],
    }).destructive).toBe(true);
  });

  it('detects Linux rm hidden behind process_start', () => {
    expect(inspectDestructiveOperation('process_start', {
      executable: 'rm',
      args: ['x.txt'],
    }).destructive).toBe(true);
  });

  it('treats opaque UI and delegated-agent mutation boundaries conservatively', () => {
    expect(inspectDestructiveOperation('dom_cdp', { action: 'click', parameters: { selector: '#submit' } }).destructive).toBe(true);
    expect(inspectDestructiveOperation('accessibility', { action: 'click', parameters: { name: 'OK' } }).destructive).toBe(true);
    expect(inspectDestructiveOperation('input_event', { operation: 'type_text', parameters: { text: 'del x' } }).destructive).toBe(true);
    expect(inspectDestructiveOperation('codex_run', { instruction: 'edit files' }).destructive).toBe(true);
    expect(inspectDestructiveOperation('mcp_call', { server: 'child', tool: 'read_file' }).destructive).toBe(true);
  });

  it('guards persistent removals exposed by upgrade tools', () => {
    expect(inspectDestructiveOperation('plugin_remove', { name: 'x' }).destructive).toBe(true);
    expect(inspectDestructiveOperation('hook_remove', { name: 'x' }).destructive).toBe(true);
  });

  it('classifies server administration mutations but leaves inspection and plans read-only', () => {
    expect(inspectDestructiveOperation('service', { operation: 'status', unit: 'demo.service' }).destructive).toBe(false);
    expect(inspectDestructiveOperation('service', { operation: 'restart', unit: 'demo.service' }).destructive).toBe(true);
    expect(inspectDestructiveOperation('package', { operation: 'show', packages: ['jq'] }).destructive).toBe(false);
    expect(inspectDestructiveOperation('package', { operation: 'install', packages: ['jq'] }).destructive).toBe(true);
    expect(inspectDestructiveOperation('schedule', { operation: 'plan', unit: 'demo' }).destructive).toBe(false);
    expect(inspectDestructiveOperation('schedule', { operation: 'remove', unit: 'demo' }).destructive).toBe(true);
  });

  it('keeps support bundle preview read-only but gates archive creation', () => {
    expect(inspectDestructiveOperation('support_bundle', { dry_run: true }).destructive).toBe(false);
    expect(inspectDestructiveOperation('support_bundle', { dry_run: false, userConfirmed: false }).destructive).toBe(true);
    expect(inspectDestructiveOperation('support_bundle', { dry_run: false, userConfirmed: true }).destructive).toBe(true);
  });
});
