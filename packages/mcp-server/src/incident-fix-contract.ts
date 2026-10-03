import { createHash } from 'node:crypto';
import { prepareWorkflowContract, type WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';

export interface IncidentFixSourceRange { path: string; startLine: number; endLine: number }
export interface IncidentFixPrepareRequest {
  operation: 'prepare'; fixId: string; diagnosisId: string; diagnosisHash: string;
  mappingId: string; mappingRevision: number; contract: WorkflowTaskContract;
  context: IncidentFixSourceRange[]; userConfirmed?: boolean;
}
export interface IncidentFixStatusRequest { operation: 'status'; fixId: string; userConfirmed?: boolean }
export type IncidentFixRequest = IncidentFixPrepareRequest | IncidentFixStatusRequest;
export interface IncidentFixReference { fixId: string; linkHash: string }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_REQUEST_BYTES = 24 * 1024;
const MAX_CONTRACT_BYTES = 16 * 1024;

export function parseIncidentFixRequest(input: unknown): IncidentFixRequest | null {
  try {
    if (!isPlainJson(input)) return null;
    const root = input as Record<string, unknown>;
    if (!id(root.fixId) || (Object.hasOwn(root, 'userConfirmed') && typeof root.userConfirmed !== 'boolean')) return null;
    let result: IncidentFixRequest;
    if (root.operation === 'status') {
      if (!exactKeys(root, ['operation', 'fixId'], ['userConfirmed'])) return null;
      result = { operation: 'status', fixId: root.fixId as string, ...(root.userConfirmed === undefined ? {} : { userConfirmed: root.userConfirmed as boolean }) };
    } else if (root.operation === 'prepare') {
      if (!exactKeys(root, ['operation', 'fixId', 'diagnosisId', 'diagnosisHash', 'mappingId', 'mappingRevision', 'contract', 'context'], ['userConfirmed'])
        || !id(root.diagnosisId) || typeof root.diagnosisHash !== 'string' || !HASH.test(root.diagnosisHash)
        || !id(root.mappingId) || !Number.isSafeInteger(root.mappingRevision) || (root.mappingRevision as number) < 0) return null;
      const workflow = prepareWorkflowContract(root.contract);
      if (!workflow.ok) return null;
      const contract = workflow.value.contract;
      if (contract.dependencies.length !== 0 || contract.allowedFiles.length < 1 || contract.allowedFiles.length > 16
        || contract.acceptanceCommands.length < 1 || contract.acceptanceCriteria.length < 1
        || contract.contextReferences.some((reference) => reference.startsWith('incident_fix:'))
        || Buffer.byteLength(JSON.stringify(canonicalContract(contract)), 'utf8') > MAX_CONTRACT_BYTES) return null;
      const context = parseRanges(root.context, contract.allowedFiles);
      if (!context) return null;
      result = { operation: 'prepare', fixId: root.fixId as string, diagnosisId: root.diagnosisId as string,
        diagnosisHash: root.diagnosisHash, mappingId: root.mappingId as string, mappingRevision: root.mappingRevision as number,
        contract, context, ...(root.userConfirmed === undefined ? {} : { userConfirmed: root.userConfirmed as boolean }) };
    } else return null;
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_REQUEST_BYTES ? result : null;
  } catch { return null; }
}

export function incidentFixRequestFingerprint(request: IncidentFixPrepareRequest): string {
  return createHash('sha256').update(JSON.stringify(canonicalRequest(request)), 'utf8').digest('hex');
}

export function incidentFixReference(fixId: string, linkHash: string): string {
  if (!id(fixId) || !HASH.test(linkHash)) throw new TypeError('Invalid incident fix reference fields');
  return `incident_fix:v1:${fixId}:${linkHash}`;
}

export function parseIncidentFixReference(text: string): IncidentFixReference | null {
  if (typeof text !== 'string' || text.length > 210 || !text.startsWith('incident_fix:v1:')) return null;
  const separator = text.lastIndexOf(':');
  if (separator < 'incident_fix:v1:'.length) return null;
  const fixId = text.slice('incident_fix:v1:'.length, separator);
  const linkHash = text.slice(separator + 1);
  return id(fixId) && HASH.test(linkHash) ? { fixId, linkHash } : null;
}

function parseRanges(value: unknown, files: readonly string[]): IncidentFixSourceRange[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const seen = new Set<string>(), result: IncidentFixSourceRange[] = [];
  for (const item of value) {
    const range = item as Record<string, unknown>;
    if (!exactKeys(range, ['path', 'startLine', 'endLine']) || typeof range.path !== 'string' || !files.includes(range.path)
      || !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine)
      || (range.startLine as number) < 1 || (range.endLine as number) < (range.startLine as number)
      || (range.endLine as number) > 1_000_000 || (range.endLine as number) - (range.startLine as number) + 1 > 200) return null;
    const key = `${range.path}\0${range.startLine}\0${range.endLine}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.push({ path: range.path, startLine: range.startLine as number, endLine: range.endLine as number });
  }
  return result;
}

function canonicalRequest(request: IncidentFixPrepareRequest): object {
  return { operation: 'prepare', fixId: request.fixId, diagnosisId: request.diagnosisId, diagnosisHash: request.diagnosisHash,
    mappingId: request.mappingId, mappingRevision: request.mappingRevision, contract: canonicalContract(request.contract),
    context: request.context.map((range) => ({ path: range.path, startLine: range.startLine, endLine: range.endLine })) };
}

function canonicalContract(contract: WorkflowTaskContract): object {
  return { taskId: contract.taskId, goal: contract.goal, workspaceId: contract.workspaceId, allowedFiles: [...contract.allowedFiles],
    dependencies: [...contract.dependencies], acceptanceCriteria: [...contract.acceptanceCriteria],
    acceptanceCommands: contract.acceptanceCommands.map((command) => ({ executable: command.executable, args: [...command.args],
      expectedExitCode: command.expectedExitCode, timeoutSeconds: command.timeoutSeconds })),
    contextReferences: [...contract.contextReferences], workerRole: contract.workerRole, plannerRequired: contract.plannerRequired,
    securitySensitive: contract.securitySensitive, stopConditions: [...contract.stopConditions] };
}

function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

/** Reject JavaScript-only object features before delegated validators can inspect input. */
function isPlainJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  const chain = new Set(ancestors);
  chain.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !isPlainJson(descriptor.value, chain)) return false;
    }
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype || Object.getOwnPropertySymbols(value).length) return false;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor) || !isPlainJson(descriptor.value, chain)) return false;
  }
  return true;
}
