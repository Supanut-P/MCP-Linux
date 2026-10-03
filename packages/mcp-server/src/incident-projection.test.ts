import { describe, expect, it } from 'vitest';
import { projectIncidentObservation, validateStoredIncidentData } from './incident-projection.js';

describe('incident observation projection', () => {
  it('omits journal content and bounds its fingerprint input', () => {
    const canary = 'journal-secret-canary';
    const result = projectIncidentObservation('journal', { output: `MESSAGE=${canary}\n`, exitCode: 0 });
    expect(result.data).toMatchObject({ lineCount: 1, messageOmitted: true });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(projectIncidentObservation('journal', { output: 'x'.repeat(256 * 1024 + 1) })).toMatchObject({ truncated: true, gap: true, data: { messageOmitted: true } });
  });

  it('keeps only allowlisted service states and byte counts', () => {
    expect(projectIncidentObservation('service-status', { output: 'ActiveState=active\nSubState=running\nUnit=secret-unit\n' })).toMatchObject({ data: { activeState: 'active', subState: 'running' }, gap: false });
    expect(projectIncidentObservation('service-status', { output: 'ActiveState=active;token=bad\nSubState=running' })).toMatchObject({ data: {}, gap: true });
    expect(projectIncidentObservation('disk_usage', { output: '9007199254740992 /secret/path\n' })).toMatchObject({ data: {}, gap: true });
    expect(JSON.stringify(projectIncidentObservation('disk_usage', { output: '12 /secret/path\n' }))).not.toContain('/secret/path');
  });

  it('projects local numeric metrics without task identifiers or arbitrary strings', () => {
    const canary = 'metrics-secret-canary';
    const result = projectIncidentObservation('local_metrics', {
      host: { load1: 0.5, memoryTotalBytes: Number.MAX_SAFE_INTEGER + 1, address: canary },
      runtime: { requestTotal: 7, activeCount: 2, revision: 9, secret: canary },
      tasks: { total: 1, byState: { running: 1, ignored: 5 }, taskId: canary },
      error: canary,
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(canary);
    expect(text).not.toContain('address');
    expect(result).toMatchObject({ gap: true, data: { locality: 'mcp_server', host: { load1: 0.5 }, runtime: { requestTotal: 7, activeCount: 2, revision: 9 }, tasks: { total: 1, byState: { running: 1 } } } });
    const clean = projectIncidentObservation('local_metrics', {
      host: { load1: 0.125, load5: 0, load15: 2.5, memoryTotalBytes: 100, memoryFreeBytes: 50, uptimeSeconds: 20 },
      runtime: { requestTotal: 2, activeCount: 1, revision: 4 },
      tasks: { total: 3, byState: { queued: 1, running: 2 } },
    });
    expect(clean).toEqual({ gap: false, truncated: false, data: {
      locality: 'mcp_server', host: { load1: 0.125, load5: 0, load15: 2.5, memoryTotalBytes: 100, memoryFreeBytes: 50, uptimeSeconds: 20 },
      runtime: { requestTotal: 2, activeCount: 1, revision: 4 }, tasks: { total: 3, byState: { queued: 1, running: 2 } },
    } });
  });

  it('hashes bounded watcher paths and canonicalizes valid observed times', () => {
    const path = 'private/path-canary.txt';
    const result = projectIncidentObservation('workspace_changes', {
      latestSequence: 9, count: 1, truncated: false,
      events: [{ sequence: 9, kind: 'modified', observedAt: '2026-10-03T01:02:03+07:00', relativePath: path }],
      workspaceId: 'workspace-canary',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(path);
    expect(text).not.toContain('workspace-canary');
    expect(result).toMatchObject({ gap: false, data: { events: [{ sequence: 9, kind: 'modified', observedAt: '2026-10-02T18:02:03.000Z' }] } });
    expect(projectIncidentObservation('workspace_changes', { latestSequence: 1, events: Array.from({ length: 17 }, (_, i) => ({ sequence: i + 1, kind: 'deleted', observedAt: 'bad', relativePath: 'x' })) })).toMatchObject({ truncated: true, gap: true });
    expect(projectIncidentObservation('workspace_changes', { latestSequence: 1, events: [{ sequence: 1, kind: 'delete', observedAt: '2026-10-03T01:02:03Z', relativePath: '../private' }] })).toMatchObject({ gap: true, data: { events: [] } });
    expect(projectIncidentObservation('workspace_changes', { latestSequence: 1, events: [{ sequence: 1, kind: 'deleted', observedAt: '2026-02-30T01:02:03Z', relativePath: 'safe/file' }] })).toMatchObject({ gap: true, data: { events: [] } });
  });

  it('fails closed for cyclic values and never echoes provider errors', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const canary = 'provider-error-canary';
    const bad = projectIncidentObservation('journal', cyclic);
    const errored = projectIncidentObservation('health', { output: '', error: canary });
    expect(bad).toMatchObject({ gap: true, data: {} });
    expect(JSON.stringify(errored)).not.toContain(canary);
    expect(errored).toMatchObject({ gap: true, data: {} });
    expect(projectIncidentObservation('health', { output: '', exitCode: 0 })).toMatchObject({ gap: false, data: { reachable: true } });
    expect(projectIncidentObservation('health', { output: '', exitCode: 1 })).toMatchObject({ gap: true, data: {} });
  });

  it('rejects corrupted stored projections even when their JSON is valid', () => {
    expect(validateStoredIncidentData('health', { reachable: true })).toBe(true);
    expect(validateStoredIncidentData('health', { reachable: true, output: 'secret' })).toBe(false);
    expect(validateStoredIncidentData('journal', { lineCount: 1, byteCount: 10, messageOmitted: true, contentHash: 'a'.repeat(64), message: 'canary' })).toBe(false);
    expect(validateStoredIncidentData('workspace_changes', {
      events: [{ sequence: 1, kind: 'modified', observedAt: '2026-10-02T18:02:03.000Z', pathFingerprint: 'b'.repeat(64) }], latestSequence: 1, count: 1,
    })).toBe(true);
    expect(validateStoredIncidentData('workspace_changes', {
      events: [{ sequence: 1, kind: 'modified', observedAt: 'yesterday', pathFingerprint: 'b'.repeat(64), relativePath: 'secret/path' }], latestSequence: 1, count: 1,
    })).toBe(false);
    expect(validateStoredIncidentData('local_metrics', { locality: 'mcp_server', host: { load1: 0.125 }, tasks: { byState: { running: 1 } } })).toBe(true);
    expect(validateStoredIncidentData('local_metrics', { locality: 'mcp_server', host: { load1: 0.125, address: 'secret' } })).toBe(false);
  });
});
