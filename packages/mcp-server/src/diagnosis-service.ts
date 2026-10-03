import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { IncidentService, ResolvedIncidentEvidence } from './incident-service.js';
import { validateStoredIncidentData, type IncidentSource } from './incident-projection.js';
import { diagnosisReferences, diagnosisRequestFingerprint, parseDiagnosisRequest, type DiagnosisRecordRequest, type DiagnosisRequest } from './diagnosis-contract.js';

interface RecordEntry { readonly id: string; readonly ownerKey: string; readonly requestFingerprint: string; readonly document: unknown; readonly documentHash: string; readonly createdAt: number }
export interface DiagnosisRepositoryPort { get(owner: string, id: string): RecordEntry | null; create(record: RecordEntry): boolean }
interface Document { schema: 1; request: DiagnosisRecordRequest; facts: readonly ResolvedIncidentEvidence[] }
export interface DiagnosisServiceOptions { repository: DiagnosisRepositoryPort; incidents: Pick<IncidentService, 'resolveEvidence'>; profileProvider?: () => PermissionProfile; /** Trusted harness only. */ deadlineMs?: number }
const SHA = /^[a-f0-9]{64}$/;

/** Caller-authored interpretation with independently resolved immutable observations. */
export class DiagnosisService {
  private readonly permissions = new DefaultPermissionEngine();
  private readonly deadlineMs: number;
  public constructor(private readonly options: DiagnosisServiceOptions) { this.deadlineMs = Math.max(1, Math.min(60_000, Number.isFinite(options.deadlineMs) ? Math.floor(options.deadlineMs!) : 60_000)); }

  public async execute(actor: FileActor, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const deadline = Date.now() + this.deadlineMs;
    try {
      const request = parseDiagnosisRequest(input);
      if (request === null || typeof actor.clientId !== 'string' || !actor.clientId.trim() || actor.clientId.includes('\0') || Buffer.byteLength(actor.clientId) > 512) return invalid();
      const permission = this.authorize(request); if (!permission.ok) return permission;
      if (signal?.aborted) return timedOut();
      const owner = hash(actor.clientId), stored = this.options.repository.get(owner, request.diagnosisId);
      if (request.operation === 'get') return stored === null ? invalid() : this.view(actor, request, stored, deadline, signal);
      const fingerprint = diagnosisRequestFingerprint(request);
      if (stored !== null) return stored.requestFingerprint !== fingerprint ? invalid() : this.view(actor, request, stored, deadline, signal);
      const evidence = await this.resolve(actor, request, deadline, signal);
      if (!evidence.ok) return evidence;
      if (Date.now() >= deadline || signal?.aborted) return timedOut();
      if (!explainIncomplete(request, evidence.value)) return invalid();
      const currentPermission = this.authorize(request); if (!currentPermission.ok) return currentPermission;
      const { userConfirmed: _confirmation, ...persisted } = request; void _confirmation;
      const document: Document = { schema: 1, request: persisted, facts: evidence.value };
      if (!validateDocument(document) || Buffer.byteLength(JSON.stringify(document)) > 32 * 1024) return invalid();
      const entry = { id: request.diagnosisId, ownerKey: owner, requestFingerprint: fingerprint, document, createdAt: Date.now() };
      const documentHash = hash(canonical(entry));
      if (!this.options.repository.create({ ...entry, documentHash })) {
        const concurrent = this.options.repository.get(owner, entry.id);
        return concurrent?.requestFingerprint === fingerprint ? this.view(actor, request, concurrent, deadline, signal) : invalid();
      }
      return this.view(actor, request, { ...entry, documentHash }, deadline, signal);
    } catch { return invalid(); }
  }

  private authorize(request: DiagnosisRequest, workspaceId = request.operation === 'record' ? request.workspaceId : ''): Result<void> {
    for (const level of request.operation === 'get' ? ['READ'] as const : ['READ', 'WRITE'] as const) {
      const decision = this.permissions.decide(this.options.profileProvider?.() ?? permissionProfiles.balanced, { action: `diagnosis_${request.operation}`, level, workspaceId, target: request.diagnosisId, destructive: false });
      if (decision === 'DENY' || (decision === 'ASK' && request.userConfirmed !== true)) return err(appError(decision === 'DENY' ? 'PERMISSION_DENIED' : 'PERMISSION_REQUIRED', 'Diagnosis access requires current policy permission'));
    }
    return ok(undefined);
  }

  private async resolve(actor: FileActor, request: DiagnosisRecordRequest, deadline: number, signal?: AbortSignal): Promise<Result<readonly ResolvedIncidentEvidence[]>> {
    const controller = new AbortController(), abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    let listener: (() => void) | undefined;
    try {
      if (signal?.aborted || Date.now() >= deadline) return timedOut();
      const cancelled = new Promise<Result<readonly ResolvedIncidentEvidence[]>>(resolve => { listener = (): void => resolve(timedOut()); controller.signal.addEventListener('abort', listener, { once: true }); if (controller.signal.aborted) listener(); });
      return await Promise.race([this.options.incidents.resolveEvidence(actor, request.workspaceId, diagnosisReferences(request), request.userConfirmed, controller.signal, deadline), cancelled]);
    } catch { return invalid(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (listener !== undefined) controller.signal.removeEventListener('abort', listener); controller.abort(); }
  }

  private async view(actor: FileActor, request: DiagnosisRequest, entry: RecordEntry, deadline: number, signal?: AbortSignal): Promise<Result<unknown>> {
    const document = validateDocument(entry.document);
    if (document === null || entry.ownerKey !== hash(actor.clientId) || document.request.diagnosisId !== entry.id || diagnosisRequestFingerprint(document.request) !== entry.requestFingerprint || hash(canonical({id:entry.id,ownerKey:entry.ownerKey,requestFingerprint:entry.requestFingerprint,document:entry.document,createdAt:entry.createdAt})) !== entry.documentHash) return invalid();
    const permission = this.authorize(request, document.request.workspaceId); if (!permission.ok) return permission;
    const current = await this.resolve(actor, { ...document.request, ...(request.userConfirmed === undefined ? {} : { userConfirmed: request.userConfirmed }) }, deadline, signal);
    if (signal?.aborted) return timedOut();
    if (!current.ok && ['PERMISSION_DENIED', 'PERMISSION_REQUIRED'].includes(current.error.code)) return current;
    const currentPermission = this.authorize(request, document.request.workspaceId); if (!currentPermission.ok) return currentPermission;
    if (current.ok && current.value.some(fact => !validFact(fact, document.request))) return invalid();
    const support = document.facts.map(fact => {
      const live = current.ok ? current.value.find(item => sameReference(item, fact)) : undefined;
      const unchangedSource = live !== undefined && sameHistoricalFact(live, fact);
      return { reference: fact.reference, status: !unchangedSource ? 'unavailable' : live.currentSupport, reasons: !unchangedSource ? ['source_unverified'] : live.currentSupport === 'current' ? [] : ['registration_' + live.currentSupport] };
    });
    return ok({ diagnosisId: entry.id, documentHash: entry.documentHash, createdAt: entry.createdAt, workspaceId: document.request.workspaceId, observedFacts: document.facts, interpretations: document.request.hypotheses, proposedFix: document.request.proposedFix, currentSupport: support, sourceValidation: current.ok ? 'resolved' : 'unavailable', boundary: 'Facts are retained metadata observations, not verified causes. All narrative and confidence are caller assertions; proposals never execute. Stale or incomplete support grants no fix/deployment authority. Omit secrets from caller prose; ownership is not tenant authentication.' });
  }
}

function validateDocument(value: unknown): Document | null {
  if (!record(value) || Object.keys(value).some(key => !['schema', 'request', 'facts'].includes(key)) || value.schema !== 1 || !Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 32) return null;
  const request = parseDiagnosisRequest(value.request); if (request?.operation !== 'record' || request.userConfirmed !== undefined) return null;
  const references = diagnosisReferences(request);
  if (value.facts.length !== references.length || value.facts.some(fact => !validFact(fact, request)) || new Set(value.facts.map(fact => canonical((fact as ResolvedIncidentEvidence).reference))).size !== references.length || !explainIncomplete(request, value.facts as ResolvedIncidentEvidence[])) return null;
  return { schema: 1, request, facts: value.facts as ResolvedIncidentEvidence[] };
}
function validFact(value: unknown, request: DiagnosisRecordRequest): value is ResolvedIncidentEvidence {
  if (!record(value) || !record(value.reference)) return false;
  const reference=value.reference;
  if (Object.keys(reference).some(key=>!['incidentId','sequence','hash'].includes(key)) || Object.keys(value).some(key => !['reference','incidentRequestFingerprint','incidentHeaderHash','workspaceId','workspaceFingerprint','hostFingerprint','observation','incidentState','missingSources','currentSupport'].includes(key)) || !diagnosisReferences(request).some(ref => ref.incidentId === reference.incidentId && ref.sequence === reference.sequence && ref.hash === reference.hash) || value.workspaceId !== request.workspaceId || typeof value.incidentRequestFingerprint !== 'string' || !SHA.test(value.incidentRequestFingerprint) || typeof value.incidentHeaderHash !== 'string' || !SHA.test(value.incidentHeaderHash) || typeof value.workspaceFingerprint !== 'string' || !SHA.test(value.workspaceFingerprint) || !(value.hostFingerprint === null || typeof value.hostFingerprint === 'string' && SHA.test(value.hostFingerprint)) || !['complete','partial','unavailable','interrupted'].includes(String(value.incidentState)) || !Number.isInteger(value.missingSources) || Number(value.missingSources) < 0 || Number(value.missingSources) > 82 || !['current','stale','unavailable'].includes(String(value.currentSupport)) || !record(value.observation)) return false;
  const observation = value.observation;
  if (Object.keys(observation).some(key => !['source','workspaceId','hostId','observedAt','sourceTime','status','truncated','gap','data'].includes(key)) || observation.workspaceId !== request.workspaceId || typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt)) || new Date(observation.observedAt).toISOString() !== observation.observedAt || observation.sourceTime !== null || !['ok','stale','unavailable','timeout'].includes(String(observation.status)) || typeof observation.truncated !== 'boolean' || typeof observation.gap !== 'boolean') return false;
  const remote = ['health','service-status','journal','disk_usage'].includes(String(observation.source)), local = ['local_metrics','workspace_changes'].includes(String(observation.source));
  if (!remote && !local || remote && typeof observation.hostId !== 'string' || local && observation.hostId !== undefined) return false;
  const gap = observation.gap === true && record(observation.data) && Object.keys(observation.data).length === 0;
  return observation.status === 'ok' ? gap || validateStoredIncidentData(observation.source as IncidentSource, observation.data) : gap;
}
function explainIncomplete(request: DiagnosisRecordRequest, facts: readonly ResolvedIncidentEvidence[]): boolean {
  return request.hypotheses.every(hypothesis => hypothesis.unknowns.length > 0 || !facts.some(fact => [...hypothesis.supporting,...hypothesis.contradicting].some(ref => ref.incidentId === fact.reference.incidentId && ref.sequence === fact.reference.sequence) && (fact.incidentState !== 'complete' || fact.currentSupport !== 'current' || fact.missingSources > 0 || fact.observation.status !== 'ok' || fact.observation.truncated === true || fact.observation.gap === true)));
}
function sameReference(a: ResolvedIncidentEvidence, b: ResolvedIncidentEvidence): boolean { return a.reference.incidentId === b.reference.incidentId && a.reference.sequence === b.reference.sequence && a.reference.hash === b.reference.hash; }
function sameHistoricalFact(a: ResolvedIncidentEvidence, b: ResolvedIncidentEvidence): boolean { const { currentSupport: _a, ...left } = a, { currentSupport: _b, ...right } = b; void _a; void _b; return canonical(left) === canonical(right); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(): Result<never> { return err(appError('INVALID_INPUT', 'Diagnosis request, evidence or retained record is invalid')); }
function timedOut(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Diagnosis operation cancelled or timed out', true)); }
