import { createHash } from 'node:crypto';

export type IncidentSource = 'health' | 'service-status' | 'journal' | 'disk_usage' | 'local_metrics' | 'workspace_changes';

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 3 * 1024;
const ACTIVE = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading']);
const SUB = new Set(['running', 'dead', 'exited', 'listening', 'waiting', 'failed', 'start', 'stop']);
const CHANGE_KINDS = new Set(['created', 'modified', 'deleted']);
const METRICS: Readonly<Record<string, readonly string[]>> = {
  host: ['load1', 'load5', 'load15', 'memoryTotalBytes', 'memoryFreeBytes', 'uptimeSeconds'],
  runtime: ['requestTotal', 'activeCount', 'revision'],
  tasks: ['total'],
};
const TASK_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'termination_unverified'] as const;

export function projectIncidentObservation(source: IncidentSource, value: unknown): { data: Record<string, unknown>; truncated: boolean; gap: boolean } {
  let truncated = false;
  let gap = false;
  let data: Record<string, unknown> = {};
  try {
    const record = asRecord(value);
    truncated = record?.truncated === true;
    if (record?.status === 'error' || record?.error !== undefined) gap = true;
    const raw = record && typeof record.output === 'string' ? record.output : undefined;
    if (raw !== undefined && Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) { truncated = true; gap = true; }
    const content = raw === undefined ? value : raw;
    switch (source) {
      case 'health': {
        if (record !== undefined && typeof record.output === 'string' && record.truncated !== true
          && (record.exitCode === undefined || record.exitCode === 0) && record.error === undefined) data = { reachable: true };
        else gap = true;
        break;
      }
      case 'service-status': {
        const fields = parseFields(content);
        const active = fields.get('ActiveState');
        const sub = fields.get('SubState');
        if (active !== undefined && ACTIVE.has(active) && sub !== undefined && SUB.has(sub)) data = { activeState: active, subState: sub };
        else gap = true;
        break;
      }
      case 'disk_usage': {
        const text = typeof content === 'string' ? content : '';
        const match = /^\s*(\d{1,16})\s+\S[^\r\n]{0,512}(?:\r?\n|$)/.exec(text);
        const bytes = match?.[1] === undefined ? NaN : Number(match[1]);
        if (Number.isSafeInteger(bytes) && bytes >= 0) data = { bytes };
        else gap = true;
        break;
      }
      case 'journal': {
        if (typeof content !== 'string') { data = { lineCount: 0, byteCount: 0, messageOmitted: true }; gap = true; break; }
        const bounded = content.slice(0, MAX_INPUT_BYTES);
        const byteCount = Buffer.byteLength(bounded, 'utf8');
        const lineCount = bounded.split(/\r?\n/).filter((line) => line.length > 0).length;
        data = { lineCount: Math.min(lineCount, 256), messageOmitted: true,
          byteCount: Math.min(byteCount, MAX_INPUT_BYTES),
          ...(byteCount <= MAX_INPUT_BYTES && bounded.length === content.length ? { contentHash: sha256(content) } : {}) };
        if (lineCount > 256 || bounded.length < content.length || byteCount > MAX_INPUT_BYTES) { truncated = true; gap = true; }
        break;
      }
      case 'local_metrics': {
        const metrics = projectMetrics(content);
        data = metrics.data;
        if (Object.keys(data).length === 1 || metrics.invalid) gap = true;
        break;
      }
      case 'workspace_changes': {
        const changes = asRecord(content);
        if (changes === undefined) { gap = true; break; }
        const inputEvents = Array.isArray(changes.events) ? changes.events.slice(0, 16) : [];
        if (!Array.isArray(changes.events) || changes.events.length > 16) truncated = true;
        const events: Array<Record<string, unknown>> = [];
        for (const item of inputEvents) {
          const event = asRecord(item);
          if (event === undefined || !isSafeRelativePath(event.relativePath)
            || typeof event.kind !== 'string' || !CHANGE_KINDS.has(event.kind)) { gap = true; continue; }
          const seq = event.sequence;
          const observedAt = canonicalTime(event.observedAt);
          if (!Number.isSafeInteger(seq) || (seq as number) < 0 || observedAt === undefined) { gap = true; continue; }
          events.push({ sequence: seq, kind: event.kind, observedAt, pathFingerprint: sha256(event.relativePath) });
        }
        const latest = changes.latestSequence;
        if (!Number.isSafeInteger(latest) || (latest as number) < 0) gap = true;
        else data = { events, latestSequence: latest, count: Number.isSafeInteger(changes.count) && (changes.count as number) >= 0 ? changes.count : events.length };
        truncated ||= changes.truncated === true;
        break;
      }
    }
  } catch { data = {}; gap = true; }
  try {
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_OUTPUT_BYTES) { data = {}; truncated = true; gap = true; }
  } catch { data = {}; gap = true; }
  return { data, truncated, gap };
}

/** Validate persisted projection bytes without trusting their original producer. */
export function validateStoredIncidentData(source: IncidentSource, data: unknown): data is Record<string, unknown> {
  if (!isExactRecord(data)) return false;
  try { if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_OUTPUT_BYTES) return false; } catch { return false; }
  switch (source) {
    case 'health': return exactKeys(data, ['reachable']) && data.reachable === true;
    case 'service-status': return exactKeys(data, ['activeState', 'subState'])
      && typeof data.activeState === 'string' && ACTIVE.has(data.activeState)
      && typeof data.subState === 'string' && SUB.has(data.subState);
    case 'disk_usage': return exactKeys(data, ['bytes']) && isCounter(data.bytes);
    case 'journal': return exactKeys(data, ['lineCount', 'byteCount', 'messageOmitted'], ['contentHash'])
      && isBoundedCount(data.lineCount, 256) && isBoundedCount(data.byteCount, MAX_INPUT_BYTES)
      && data.messageOmitted === true && (data.contentHash === undefined || isHash(data.contentHash));
    case 'local_metrics': {
      if (!exactKeys(data, ['locality'], ['host', 'runtime', 'tasks']) || data.locality !== 'mcp_server') return false;
      const host = asRecord(data.host);
      if (data.host !== undefined && (host === undefined || !exactKeys(host, [], METRICS.host)
        || Object.entries(host).some(([key, value]) => !isMetric(value, key.startsWith('load'))))) return false;
      const runtime = asRecord(data.runtime);
      if (data.runtime !== undefined && (runtime === undefined || !exactKeys(runtime, [], METRICS.runtime)
        || Object.values(runtime).some((value) => !isCounter(value)))) return false;
      const tasks = asRecord(data.tasks);
      if (data.tasks !== undefined) {
        if (tasks === undefined || !exactKeys(tasks, [], ['total', 'byState'])
          || (tasks.total !== undefined && !isBoundedCount(tasks.total, 1_000_000_000))) return false;
        const states = asRecord(tasks.byState);
        if (tasks.byState !== undefined && (states === undefined || !exactKeys(states, [], TASK_STATES)
          || Object.values(states).some((count) => !isBoundedCount(count, 1_000_000_000)))) return false;
      }
      return true;
    }
    case 'workspace_changes': {
      if (!exactKeys(data, ['events', 'latestSequence', 'count']) || !isCounter(data.latestSequence)
        || !isBoundedCount(data.count, Number.MAX_SAFE_INTEGER) || !Array.isArray(data.events) || data.events.length > 16) return false;
      return data.events.every((item) => {
        const event = asRecord(item);
        return event !== undefined && exactKeys(event, ['sequence', 'kind', 'observedAt', 'pathFingerprint'])
          && isCounter(event.sequence) && typeof event.kind === 'string' && CHANGE_KINDS.has(event.kind)
          && canonicalTime(event.observedAt) === event.observedAt && isHash(event.pathFingerprint);
      });
    }
  }
}

function projectMetrics(value: unknown): { data: Record<string, unknown>; invalid: boolean } {
  const snapshot = asRecord(value);
  if (snapshot === undefined) return { data: {}, invalid: true };
  const out: Record<string, unknown> = { locality: 'mcp_server' };
  let invalid = false;
  for (const [scope, keys] of Object.entries(METRICS)) {
    const input = asRecord(snapshot[scope]);
    if (input === undefined) continue;
    const projected: Record<string, unknown> = {};
    for (const key of keys) {
      const n = input[key];
      const valid = typeof n === 'number' && Number.isFinite(n) && n >= 0
        && (scope === 'host' && key.startsWith('load') ? true : Number.isSafeInteger(n) && n <= Number.MAX_SAFE_INTEGER);
      if (valid) projected[key] = n as number;
      else if (n !== undefined) invalid = true;
    }
    if (scope === 'tasks') {
      if (input.total !== undefined && (!Number.isSafeInteger(input.total) || (input.total as number) < 0 || (input.total as number) > 1_000_000_000)) invalid = true;
      const states = asRecord(input.byState);
      if (states !== undefined) {
        const byState: Record<string, number> = {};
        for (const key of TASK_STATES) {
          const n = states[key];
          if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000) byState[key] = n;
          else if (n !== undefined) invalid = true;
        }
        projected.byState = byState;
      } else if (input.byState !== undefined) invalid = true;
    }
    if (Object.keys(projected).length) out[scope] = projected;
  }
  return { data: out, invalid };
}

function parseFields(value: unknown): Map<string, string> {
  const text = typeof value === 'string' ? value : '';
  const fields = new Map<string, string>();
  for (const line of text.slice(0, MAX_INPUT_BYTES).split(/\r?\n/).slice(0, 64)) {
    const match = /^(ActiveState|SubState)=([A-Za-z]{1,32})$/.exec(line);
    if (match?.[1] && match[2]) fields.set(match[1], match[2]);
  }
  return fields;
}

function canonicalTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const canonical = new Date(time).toISOString();
  return Number.isFinite(Date.parse(canonical)) ? canonical : undefined;
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 1024
    && !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z]:/.test(value)
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function isExactRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}
function isCounter(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isBoundedCount(value: unknown, max: number): value is number { return isCounter(value) && value <= max; }
function isMetric(value: unknown, allowFloat: boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && (allowFloat || Number.isSafeInteger(value));
}
function isHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
