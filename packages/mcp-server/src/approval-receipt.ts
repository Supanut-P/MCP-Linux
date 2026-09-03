import { createHash } from 'node:crypto';

export interface ApprovalReceipt {
  readonly id: string;
  readonly toolName: string;
  readonly actorId: string;
  readonly workspaceId?: string;
  readonly targetSummaryHash: string;
  readonly previewHash?: string;
  readonly profile: string;
  readonly decision: string;
  readonly confirmedAt?: string;
}

export interface ApprovalReceiptInput {
  readonly toolName: string;
  readonly actorId: string;
  readonly workspaceId?: string;
  readonly targetSummary?: string;
  readonly previewHash?: string;
  readonly profile: string;
  readonly decision: string;
  readonly confirmedAt?: string;
}

/** Derives a non-secret receipt from hashes and bounded metadata only. */
export function createApprovalReceipt(input: ApprovalReceiptInput): ApprovalReceipt {
  const targetSummaryHash = hash(redactTarget(input.targetSummary ?? ''));
  const identity = {
    toolName: input.toolName,
    actorId: input.actorId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    targetSummaryHash,
    ...(isSha256(input.previewHash) ? { previewHash: input.previewHash } : {}),
    profile: input.profile,
    decision: input.decision,
  };
  return {
    id: hash(JSON.stringify(identity)),
    toolName: input.toolName,
    actorId: input.actorId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    targetSummaryHash,
    ...(isSha256(input.previewHash) ? { previewHash: input.previewHash } : {}),
    profile: input.profile,
    decision: input.decision,
    ...(input.confirmedAt === undefined ? {} : { confirmedAt: input.confirmedAt }),
  };
}

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function redactTarget(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+|bearer\s+|\b(?:token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b[^\s,;]*secret[^\s,;]*\b/gi, '[REDACTED]');
}

function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
