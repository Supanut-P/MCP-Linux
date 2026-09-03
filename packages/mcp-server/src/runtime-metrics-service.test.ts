import { describe, expect, it } from 'vitest';
import { ActivityTracker } from './activity-tracker.js';
import { RuntimeMetricsService, type RuntimeMetricsOs } from './runtime-metrics-service.js';

const fakeOs: RuntimeMetricsOs = {
  loadavg: (): readonly number[] => [1.25, 0.75, 0.5],
  totalmem: (): number => 16 * 1024 ** 3,
  freemem: (): number => 6 * 1024 ** 3,
  uptime: (): number => 1234.75,
};

describe('RuntimeMetricsService', () => {
  it('returns deterministic host, runtime, and owned-task metrics without sensitive metadata', async () => {
    const activity = new ActivityTracker();
    await activity.begin('read_file', { workspaceId: 'workspace-secret', path: '/srv/private.txt' });
    const service = new RuntimeMetricsService({
      activity,
      os: fakeOs,
      taskSnapshot: async (): Promise<{ byState: { running: number; completed: number; failed: number } }> => ({ byState: { running: 2, completed: 1, failed: 0 } }),
    });

    const result = await service.execute({ operation: 'snapshot', scopes: ['host', 'runtime', 'tasks'] });

    expect(result).toEqual({
      ok: true,
      value: {
        host: {
          load1: 1.25,
          load5: 0.75,
          load15: 0.5,
          memoryTotalBytes: 16 * 1024 ** 3,
          memoryFreeBytes: 6 * 1024 ** 3,
          uptimeSeconds: 1234,
        },
        runtime: { requestTotal: 1, activeCount: 1, revision: 1 },
        tasks: {
          total: 3,
          byState: { queued: 0, running: 2, completed: 1, failed: 0, cancelled: 0, timed_out: 0, termination_unverified: 0 },
        },
      },
    });
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toMatch(/hostname|command|environment|path|client|actor|secret|token|workspace-secret/i);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('allows host/runtime-only snapshots without a task provider', async () => {
    const service = new RuntimeMetricsService({ activity: new ActivityTracker(), os: fakeOs });

    await expect(service.execute({ operation: 'snapshot', scopes: ['runtime', 'host'] })).resolves.toMatchObject({
      ok: true,
      value: {
        host: expect.any(Object),
        runtime: { requestTotal: 0, activeCount: 0, revision: 0 },
      },
    });
  });

  it('fails closed for invalid scopes, missing task wiring, provider errors, and cancellation', async () => {
    const service = new RuntimeMetricsService({ activity: new ActivityTracker(), os: fakeOs });
    await expect(service.execute({ operation: 'snapshot', scopes: [] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute({ operation: 'snapshot', scopes: ['host', 'runtime', 'tasks', 'extra'] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute({ operation: 'snapshot', scopes: ['tasks'] })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });

    const providerFailure = new RuntimeMetricsService({ activity: new ActivityTracker(), os: fakeOs, taskSnapshot: async (): Promise<never> => { throw new Error('api_key=secret'); } });
    await expect(providerFailure.execute({ operation: 'snapshot', scopes: ['tasks'] })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Runtime task metrics are unavailable' } });

    const controller = new AbortController();
    controller.abort();
    await expect(service.execute({ operation: 'snapshot', scopes: ['host'] }, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('rejects non-finite or negative provider counters', async () => {
    const service = new RuntimeMetricsService({
      activity: new ActivityTracker(),
      os: fakeOs,
      taskSnapshot: async (): Promise<{ byState: { running: number; completed: number } }> => ({ byState: { running: Number.NaN, completed: -1 } }),
    });

    await expect(service.execute({ operation: 'snapshot', scopes: ['tasks'] })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
  });
});
