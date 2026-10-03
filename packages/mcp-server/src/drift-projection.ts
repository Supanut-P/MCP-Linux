export type DriftValue =
  | { loadState: string; activeState: string; subState: string; unitFileState: string }
  | { sha256: string };
export type DriftObservation = {
  targetId: string;
  status: 'ok' | 'unavailable' | 'stale' | 'timeout';
  observedAt: string;
  sourceTime: null;
  truncated: boolean;
  value: DriftValue | null;
};

const MAX_OUTPUT_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ACTIVE = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'maintenance']);
const SUB = new Set(['running', 'dead', 'exited', 'listening', 'waiting', 'failed', 'start', 'stop', 'mounted', 'plugged', 'auto-restart', 'condition', 'start-pre', 'start-post', 'stop-sigterm', 'stop-sigkill', 'final-sigterm', 'final-sigkill', 'refreshing']);
const UNIT_FILE = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime', 'static', 'disabled', 'indirect', 'generated', 'transient', 'attached', 'bad', '']);

export function projectDriftValue(kind: 'service' | 'config' | 'artifact', value: unknown): { status: 'ok' | 'unavailable' | 'truncated'; truncated: boolean; value: DriftValue | null } {
  const unavailable = (): ReturnType<typeof projectDriftValue> => ({ status: 'unavailable', truncated: false, value: null });
  if (!isPlainRecord(value) || !exactKeys(value, ['output'], ['exitCode', 'truncated']) || typeof value.output !== 'string') return unavailable();
  if ((value.exitCode !== undefined && value.exitCode !== 0) || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) return unavailable();
  const output = value.output;
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES || value.truncated === true) return { status: 'truncated', truncated: true, value: null };
  if (kind === 'service') {
    const fields = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
      if (line === '') continue;
      const keyMatch = /^([A-Za-z][A-Za-z0-9]*)=/.exec(line);
      if (!keyMatch) return unavailable();
      const key = keyMatch[1]!;
      if (!['LoadState', 'ActiveState', 'SubState', 'UnitFileState'].includes(key)) continue;
      const match = /^([A-Za-z][A-Za-z0-9]*)=([A-Za-z0-9_.@-]{0,64})$/.exec(line);
      if (match === null) return unavailable();
      if (fields.has(key)) return unavailable();
      fields.set(key, match[2]!);
    }
    const loadState = fields.get('LoadState'); const activeState = fields.get('ActiveState');
    const subState = fields.get('SubState'); const unitFileState = fields.get('UnitFileState');
    if (loadState !== 'loaded' || activeState === undefined || !ACTIVE.has(activeState)
      || subState === undefined || !SUB.has(subState) || unitFileState === undefined || !UNIT_FILE.has(unitFileState)) return unavailable();
    const projected = { loadState, activeState, subState, unitFileState };
    return { status: 'ok', truncated: false, value: projected };
  }
  const match = /^([a-f0-9]{64})(?: {2}| \*)([^\r\n]{1,4096})\n?$/u.exec(output);
  if (!match || Buffer.byteLength(match[2]!, 'utf8') > 4096 || hasControlCharacter(match[2]!)) return unavailable();
  return { status: 'ok', truncated: false, value: { sha256: match[1]! } };
}

export function validateDriftValue(kind: 'service' | 'config' | 'artifact', value: unknown): value is DriftValue {
  if (!isPlainRecord(value)) return false;
  if (kind === 'service') return exactKeys(value, ['loadState', 'activeState', 'subState', 'unitFileState'])
    && value.loadState === 'loaded' && typeof value.activeState === 'string' && ACTIVE.has(value.activeState)
    && typeof value.subState === 'string' && SUB.has(value.subState)
    && typeof value.unitFileState === 'string' && UNIT_FILE.has(value.unitFileState);
  return exactKeys(value, ['sha256']) && typeof value.sha256 === 'string' && HASH.test(value.sha256);
}

export function validateDriftObservation(kind: 'service' | 'config' | 'artifact', observation: unknown): observation is DriftObservation {
  if (!isPlainRecord(observation) || !exactKeys(observation, ['targetId', 'status', 'observedAt', 'sourceTime', 'truncated', 'value'])) return false;
  if (typeof observation.targetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(observation.targetId)
    || !['ok', 'unavailable', 'stale', 'timeout'].includes(String(observation.status))
    || canonicalIso(observation.observedAt) !== observation.observedAt || observation.sourceTime !== null
    || typeof observation.truncated !== 'boolean') return false;
  if (observation.status === 'ok') {
    if (observation.truncated === true) return observation.value === null;
    return validateDriftValue(kind, observation.value);
  }
  return observation.value === null;
}

export function compareDriftObservations(kind: 'service' | 'config' | 'artifact', baseline: DriftObservation | null, current: DriftObservation | null, bindingsStale: boolean): { status: 'stale' | 'unavailable' | 'truncated' | 'changed' | 'unchanged'; reasons: readonly string[] } {
  const reasons: string[] = [];
  if (bindingsStale) reasons.push('bindings_stale');
  const observations = [baseline, current];
  if (observations.some((o) => o !== null && o.status === 'stale')) reasons.push('observation_stale');
  const malformed = observations.some((o) => o !== null && !validateDriftObservation(kind, o));
  if (baseline === null || current === null || malformed || observations.some((o) => o !== null && (o.status === 'unavailable' || o.status === 'timeout'))) reasons.push('observation_unavailable');
  if (observations.some((o) => o !== null && o.truncated)) reasons.push('observation_truncated');
  if (reasons.includes('bindings_stale') || reasons.includes('observation_stale')) return { status: 'stale', reasons };
  if (reasons.includes('observation_unavailable')) return { status: 'unavailable', reasons };
  if (reasons.includes('observation_truncated')) return { status: 'truncated', reasons };
  // A value is comparable only after strict validation of both persisted observations.
  if (baseline === null || current === null || !validateDriftObservation(kind, baseline) || !validateDriftObservation(kind, current)) return { status: 'unavailable', reasons: [...reasons, 'observation_unavailable'] };
  return { status: sameValue(kind, baseline.value, current.value) ? 'unchanged' : 'changed', reasons };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((d) => 'value' in d && d.enumerable);
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function canonicalIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString() === value ? value : undefined;
}
function sameValue(kind: 'service' | 'config' | 'artifact', left: DriftValue | null, right: DriftValue | null): boolean {
  if (left === null || right === null) return false;
  return kind === 'service'
    ? 'loadState' in left && 'loadState' in right && left.loadState === right.loadState && left.activeState === right.activeState
      && left.subState === right.subState && left.unitFileState === right.unitFileState
    : 'sha256' in left && 'sha256' in right && left.sha256 === right.sha256;
}
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}
