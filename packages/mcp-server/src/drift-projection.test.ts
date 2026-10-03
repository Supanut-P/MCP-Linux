import { describe, expect, it } from 'vitest';
import { compareDriftObservations, projectDriftValue, validateDriftObservation, validateDriftValue, type DriftObservation } from './drift-projection.js';

const serviceOutput = 'Id=demo.service\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=42\n';
const serviceValue = { loadState: 'loaded', activeState: 'active', subState: 'running', unitFileState: 'enabled' };
const hash = 'a'.repeat(64);
const observation = (value: unknown = serviceValue, overrides: Record<string, unknown> = {}): DriftObservation => ({
  targetId: 'svc-1', status: 'ok', observedAt: '2026-10-03T10:00:00.000Z', sourceTime: null, truncated: false, value: value as DriftObservation['value'], ...overrides,
});

describe('drift projection', () => {
  it('projects stable service states and ignores volatile or unknown fields', () => {
    expect(projectDriftValue('service', { output: serviceOutput })).toEqual({ status: 'ok', truncated: false, value: serviceValue });
    expect(projectDriftValue('service', { output: serviceOutput.replace('MainPID=42', 'MainPID=9001') }).value).toEqual(serviceValue);
    expect(projectDriftValue('service', { output: serviceOutput.replace('LoadState=loaded', 'LoadState=loaded\nLoadState=loaded') }).status).toBe('unavailable');
    expect(projectDriftValue('service', { output: serviceOutput.replace('LoadState=loaded', 'LoadState=unknown') }).value).toBeNull();
    expect(projectDriftValue('service', { output: serviceOutput.replace('LoadState=loaded\n', '') }).status).toBe('unavailable');
  });

  it('stores only strict checksums and rejects output canaries and extra lines', () => {
    expect(projectDriftValue('config', { output: `${hash}  /etc/app.conf\n` })).toEqual({ status: 'ok', truncated: false, value: { sha256: hash } });
    expect(projectDriftValue('artifact', { output: `${hash}  /var/lib/My App/配置 文件.bin\n` })).toEqual({ status: 'ok', truncated: false, value: { sha256: hash } });
    expect(projectDriftValue('artifact', { output: `${hash} *archive image.tar.gz\n` })).toEqual({ status: 'ok', truncated: false, value: { sha256: hash } });
    expect(projectDriftValue('artifact', { output: `${hash}  /tmp/file\nERROR=secret` }).status).toBe('unavailable');
    expect(projectDriftValue('config', { output: `${hash}  /tmp/file secret=canary\n` })).toEqual({ status: 'ok', truncated: false, value: { sha256: hash } });
    expect(projectDriftValue('config', { output: `${hash}  /tmp/file\n`, exitCode: 1 })).toMatchObject({ status: 'unavailable', value: null });
    expect(projectDriftValue('config', { output: `${hash}  /tmp/file\n`, error: 'secret' }).status).toBe('unavailable');
  });

  it('rejects oversized and explicitly truncated envelopes', () => {
    expect(projectDriftValue('service', { output: serviceOutput, truncated: true })).toMatchObject({ status: 'truncated', truncated: true, value: null });
    expect(projectDriftValue('service', { output: 'x'.repeat(64 * 1024 + 1) })).toMatchObject({ status: 'truncated', value: null });
    expect(projectDriftValue('service', serviceOutput)).toMatchObject({ status: 'unavailable', value: null });
  });

  it('requires strict stored schemas, canonical observations and precedence', () => {
    expect(validateDriftValue('service', { ...serviceValue, pid: 42 })).toBe(false);
    expect(validateDriftValue('service', Object.assign(Object.create({ extra: true }), serviceValue))).toBe(false);
    expect(validateDriftValue('config', { sha256: hash.toUpperCase() })).toBe(false);
    expect(validateDriftObservation('service', observation())).toBe(true);
    const truncatedObservation = observation(null, { truncated: true });
    expect(validateDriftObservation('service', truncatedObservation)).toBe(true);
    expect(validateDriftObservation('service', observation(serviceValue, { observedAt: '2026-02-31T10:00:00.000Z' }))).toBe(false);
    expect(validateDriftObservation('service', observation(serviceValue, { extra: true }))).toBe(false);

    expect(compareDriftObservations('service', observation(), observation({ ...serviceValue, activeState: 'inactive' }), false).status).toBe('changed');
    expect(compareDriftObservations('service', observation(), observation(), false).status).toBe('unchanged');
    expect(compareDriftObservations('service', observation(), truncatedObservation, false)).toEqual({ status: 'truncated', reasons: ['observation_truncated'] });
    expect(compareDriftObservations('service', null, observation(), false)).toMatchObject({ status: 'unavailable', reasons: ['observation_unavailable'] });
    expect(compareDriftObservations('service', observation(null, { status: 'unavailable', truncated: true }), null, true)).toEqual({ status: 'stale', reasons: ['bindings_stale', 'observation_unavailable', 'observation_truncated'] });
    expect(compareDriftObservations('service', observation(null, { status: 'timeout', truncated: true }), observation(), false)).toEqual({ status: 'unavailable', reasons: ['observation_unavailable', 'observation_truncated'] });
    expect(compareDriftObservations('service', observation(), observation(null, { status: 'unavailable', truncated: true }), false).status).toBe('unavailable');
  });
});
