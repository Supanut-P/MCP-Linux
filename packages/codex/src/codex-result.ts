import type { ManagedProcess, ProcessLogResult } from '@baitonghub-linux-mcp/process';
import type { ResolvedCodexSelection } from './codex-selection.js';

export type CodexResultState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'unknown' | 'timed_out';
export interface CodexUsage { readonly inputTokens: number; readonly cachedInputTokens: number; readonly outputTokens: number }
export interface CodexStructuredResult {
  readonly selection: ResolvedCodexSelection;
  readonly state: CodexResultState;
  readonly finalText: string | null;
  readonly usage: CodexUsage | null;
  readonly truncated: boolean;
  readonly protocolIncomplete: boolean;
  readonly reasonCodes: readonly string[];
}

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const encoder = new TextEncoder();

export function parseCodexResult(process: ManagedProcess, logs: ProcessLogResult, selection: ResolvedCodexSelection): CodexStructuredResult {
  const reasons = new Set<string>();
  const stdout = [...logs.entries].filter((entry) => entry.stream === 'stdout').sort((a, b) => a.sequence - b.sequence);
  let input = '';
  let inputBytes = 0;
  let capped = false;
  for (const entry of stdout) {
    const remaining = MAX_INPUT_BYTES - inputBytes;
    const bytes = encoder.encode(entry.text);
    if (bytes.length > remaining) {
      input += new TextDecoder().decode(bytes.subarray(0, Math.max(0, remaining)));
      inputBytes = MAX_INPUT_BYTES;
      capped = true;
      break;
    }
    input += entry.text;
    inputBytes += bytes.length;
  }
  let protocolIncomplete = logs.truncated || capped;
  if (logs.truncated) reasons.add('LOG_EVICTED');
  if (capped) reasons.add('INPUT_LIMIT');
  let finalText: string | null = null;
  let usage: CodexUsage | null = null;
  let turnCompleted = false;
  let turnFailed = false;
  const lines = input.split('\n');
  if (lines.at(-1) === '') lines.pop();
  else if (input.length > 0) protocolIncomplete = true;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (encoder.encode(line).length > MAX_RECORD_BYTES) {
      protocolIncomplete = true;
      reasons.add('RECORD_LIMIT');
      continue;
    }
    let event: unknown;
    try { event = JSON.parse(line); } catch {
      protocolIncomplete = true;
      reasons.add('MALFORMED_RECORD');
      continue;
    }
    if (!isRecord(event) || typeof event.type !== 'string') {
      protocolIncomplete = true;
      reasons.add('UNSUPPORTED_EVENT');
      continue;
    }
    if (event.type === 'item.completed') {
      const item = event.item;
      if (!isRecord(item) || typeof item.type !== 'string' || (item.type === 'agent_message' && typeof item.text !== 'string')) {
        protocolIncomplete = true;
        reasons.add('MALFORMED_ITEM');
      } else if (item.type === 'agent_message') finalText = item.text as string;
    } else if (event.type === 'turn.completed') {
      if (turnCompleted || turnFailed) { protocolIncomplete = true; reasons.add('CONFLICTING_TERMINAL'); }
      turnCompleted = true;
      const parsed = parseUsage(event.usage);
      if (parsed) usage = parsed;
      else { usage = null; protocolIncomplete = true; reasons.add('INVALID_USAGE'); }
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      turnFailed = true;
      const message = typeof event.message === 'string' ? event.message : typeof event.error === 'string' ? event.error : isRecord(event.error) && typeof event.error.message === 'string' ? event.error.message : '';
      if (/model/i.test(message) && /not.*(?:support|available)|unsupported|isn't supported|cannot be used|does not exist|invalid model/i.test(message)) reasons.add('MODEL_UNAVAILABLE');
      else if (/unauthorized|authentication|401|login required/i.test(message)) reasons.add('AUTHENTICATION_REJECTED');
      else if (/quota|rate.limit|429/i.test(message)) reasons.add('QUOTA_REJECTED');
    } else if (!['thread.started', 'turn.started', 'item.started', 'item.updated'].includes(event.type)) {
      protocolIncomplete = true;
      reasons.add('UNSUPPORTED_EVENT');
    }
  }
  if (!turnCompleted && !turnFailed) { protocolIncomplete = true; reasons.add('MISSING_TERMINAL'); }
  let state: CodexResultState;
  if (process.state === 'starting') state = 'pending';
  else if (process.state === 'running') state = 'running';
  else if (process.state === 'timed_out') { state = 'timed_out'; reasons.add('PROCESS_TIMED_OUT'); }
  else if (process.state === 'termination_unverified') { state = 'unknown'; reasons.add('TERMINATION_UNVERIFIED'); }
  else if (process.state === 'stopped') { state = 'cancelled'; reasons.add('PROCESS_STOPPED'); }
  else if (process.state === 'failed' || turnFailed || process.exitCode !== 0) { state = 'failed'; reasons.add(turnFailed ? 'PROVIDER_FAILED' : 'PROCESS_FAILED'); }
  else if (process.state === 'exited' && process.exitCode === 0 && turnCompleted && !protocolIncomplete) state = 'completed';
  else { state = turnCompleted || finalText !== null ? 'partial' : 'unknown'; reasons.add('RESULT_INCOMPLETE'); }

  const bounded = finalText === null ? null : boundText(finalText);
  if (bounded?.truncated) reasons.add('FINAL_TEXT_TRUNCATED');
  return { selection, state, finalText: bounded?.text ?? null, usage, truncated: bounded?.truncated ?? false, protocolIncomplete, reasonCodes: [...reasons] };
}

function parseUsage(value: unknown): CodexUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = value.input_tokens;
  const cachedInputTokens = value.cached_input_tokens;
  const outputTokens = value.output_tokens;
  if (![inputTokens, cachedInputTokens, outputTokens].every((n) => Number.isSafeInteger(n) && (n as number) >= 0) || (cachedInputTokens as number) > (inputTokens as number)) return null;
  return { inputTokens: inputTokens as number, cachedInputTokens: cachedInputTokens as number, outputTokens: outputTokens as number };
}
function boundText(text: string): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= MAX_TEXT_BYTES) return { text, truncated: false };
  let end = MAX_TEXT_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
