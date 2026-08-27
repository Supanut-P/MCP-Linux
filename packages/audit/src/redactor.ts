import { createHash } from 'node:crypto';

const SENSITIVE_KEY = /authorization|token|secret|password|api[_-]?key|private[_-]?key|credential/i;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const AUTHORIZATION_HEADER = /(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi;
const ENV_SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*[^\s,;]+/g;
const API_KEY_PREFIX = /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]+)\b/g;

export class Redactor {
  public redact(value: unknown): unknown {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : this.redact(entry),
    ]));
  }

  public redactRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const redacted = this.redact(value);
    return isRecord(redacted) ? redacted : {};
  }
}

export interface CodexInstructionSummary {
  readonly codexTaskId: string;
  readonly instructionLength: number;
  readonly instructionSha256: string;
}

export function codexInstructionSummary(codexTaskId: string, instruction: string): CodexInstructionSummary {
  return {
    codexTaskId,
    instructionLength: Buffer.byteLength(instruction, 'utf8'),
    instructionSha256: createHash('sha256').update(instruction, 'utf8').digest('hex'),
  };
}

function redactString(value: string): string {
  return value
    .replace(AUTHORIZATION_HEADER, '$1[REDACTED]')
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(ENV_SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(API_KEY_PREFIX, '[REDACTED]');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
