import { createHash } from 'node:crypto';

export interface EvidenceReference { incidentId: string; sequence: number; hash: string }
export interface Hypothesis {
  id: string;
  statement: string;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  assumptions: string[];
  unknowns: string[];
  supporting: EvidenceReference[];
  contradicting: EvidenceReference[];
}
export interface ProposedFix { id: string; hypothesisIds: string[]; description: string; verification: string }
export interface DiagnosisRecordRequest {
  operation: 'record'; diagnosisId: string; workspaceId: string;
  hypotheses: Hypothesis[]; proposedFix: ProposedFix[]; userConfirmed?: boolean;
}
export interface DiagnosisGetRequest { operation: 'get'; diagnosisId: string; userConfirmed?: boolean }
export type DiagnosisRequest = DiagnosisRecordRequest | DiagnosisGetRequest;

const MAX_REQUEST_BYTES = 24 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONFIDENCE = new Set(['low', 'medium', 'high']);

/** Parse only JSON-shaped, bounded caller input. Prose is retained as caller interpretation. */
export function parseDiagnosisRequest(input: unknown): DiagnosisRequest | null {
  try {
    const root = record(input);
    if (!root || !onlyKeys(root, ['operation', 'diagnosisId'], ['userConfirmed', 'workspaceId', 'hypotheses', 'proposedFix'])) return null;
    if (!validId(root.diagnosisId) || (Object.hasOwn(root, 'userConfirmed') && typeof root.userConfirmed !== 'boolean')) return null;
    let parsed: DiagnosisRequest;
    if (root.operation === 'get') {
      if (!onlyKeys(root, ['operation', 'diagnosisId'], ['userConfirmed'])) return null;
      parsed = { operation: 'get', diagnosisId: root.diagnosisId as string, ...(root.userConfirmed === undefined ? {} : { userConfirmed: root.userConfirmed as boolean }) };
    } else if (root.operation === 'record') {
      if (!onlyKeys(root, ['operation', 'diagnosisId', 'workspaceId', 'hypotheses', 'proposedFix'], ['userConfirmed']) || !validId(root.workspaceId)) return null;
      const hypotheses = parseHypotheses(root.hypotheses);
      if (!hypotheses) return null;
      const proposedFix = parseFixes(root.proposedFix, hypotheses);
      if (!proposedFix) return null;
      parsed = { operation: 'record', diagnosisId: root.diagnosisId as string, workspaceId: root.workspaceId as string, hypotheses, proposedFix,
        ...(root.userConfirmed === undefined ? {} : { userConfirmed: root.userConfirmed as boolean }) };
    } else return null;
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_REQUEST_BYTES) return null;
    return parsed;
  } catch { return null; }
}

export function diagnosisReferences(recordReq: DiagnosisRecordRequest): EvidenceReference[] {
  const refs = new Map<string, EvidenceReference>();
  for (const hypothesis of recordReq.hypotheses) for (const ref of [...hypothesis.supporting, ...hypothesis.contradicting]) {
    refs.set(`${ref.incidentId}\0${ref.sequence}`, ref);
  }
  return [...refs.values()];
}

/** Hashes the canonical persisted input, excluding the transient confirmation flag. */
export function diagnosisRequestFingerprint(recordReq: DiagnosisRecordRequest): string {
  const canonical = {
    operation: 'record', diagnosisId: recordReq.diagnosisId, workspaceId: recordReq.workspaceId,
    hypotheses: recordReq.hypotheses.map((h) => ({ id: h.id, statement: h.statement, confidence: h.confidence, rationale: h.rationale,
      assumptions: [...h.assumptions], unknowns: [...h.unknowns], supporting: h.supporting.map(canonicalReference), contradicting: h.contradicting.map(canonicalReference) })),
    proposedFix: recordReq.proposedFix.map((f) => ({ id: f.id, hypothesisIds: [...f.hypothesisIds], description: f.description, verification: f.verification })),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function parseHypotheses(value: unknown): Hypothesis[] | null {
  if (!array(value) || value.length < 1 || value.length > 8) return null;
  const ids = new Set<string>();
  const allRefs = new Map<string, string>();
  const incidents = new Set<string>();
  let distinct = 0;
  const result: Hypothesis[] = [];
  for (const valueItem of value) {
    const h = record(valueItem);
    if (!h || !onlyKeys(h, ['id', 'statement', 'confidence', 'rationale', 'assumptions', 'unknowns', 'supporting', 'contradicting'])) return null;
    if (!validId(h.id) || ids.has(h.id) || !prose(h.statement, 512) || !CONFIDENCE.has(String(h.confidence)) || !prose(h.rationale, 1024)) return null;
    ids.add(h.id as string);
    const assumptions = proseList(h.assumptions, 8, 512), unknowns = proseList(h.unknowns, 8, 512);
    const supporting = parseReferences(h.supporting), contradicting = parseReferences(h.contradicting);
    if (!assumptions || !unknowns || !supporting || !contradicting || supporting.length + contradicting.length < 1) return null;
    for (const ref of [...supporting, ...contradicting]) {
      const key = `${ref.incidentId}\0${ref.sequence}`;
      const previous = allRefs.get(key);
      if (previous !== undefined && previous !== ref.hash) return null;
      if (previous === undefined) { allRefs.set(key, ref.hash); distinct++; incidents.add(ref.incidentId); }
    }
    result.push({ id: h.id as string, statement: h.statement as string, confidence: h.confidence as Hypothesis['confidence'], rationale: h.rationale as string,
      assumptions, unknowns, supporting, contradicting });
  }
  if (distinct > 32 || incidents.size > 8) return null;
  return result;
}

function parseFixes(value: unknown, hypotheses: Hypothesis[]): ProposedFix[] | null {
  if (!array(value) || value.length < 1 || value.length > 8) return null;
  const ids = new Set<string>(), hypothesisIds = new Set(hypotheses.map((h) => h.id));
  const result: ProposedFix[] = [];
  for (const item of value) {
    const f = record(item);
    if (!f || !onlyKeys(f, ['id', 'hypothesisIds', 'description', 'verification']) || !validId(f.id) || ids.has(f.id)
      || !prose(f.description, 1024) || !prose(f.verification, 1024) || !array(f.hypothesisIds) || f.hypothesisIds.length < 1 || f.hypothesisIds.length > 8) return null;
    ids.add(f.id as string);
    const links = new Set<string>();
    for (const id of f.hypothesisIds) {
      if (!validId(id) || !hypothesisIds.has(id) || links.has(id)) return null;
      links.add(id);
    }
    result.push({ id: f.id as string, hypothesisIds: [...links], description: f.description as string, verification: f.verification as string });
  }
  return result;
}

function parseReferences(value: unknown): EvidenceReference[] | null {
  if (!array(value) || value.length > 32) return null;
  const result: EvidenceReference[] = [], seen = new Set<string>();
  for (const item of value) {
    const ref = record(item);
    if (!ref || !onlyKeys(ref, ['incidentId', 'sequence', 'hash']) || !validId(ref.incidentId)
      || !Number.isInteger(ref.sequence) || (ref.sequence as number) < 1 || (ref.sequence as number) > 128
      || typeof ref.hash !== 'string' || !HASH.test(ref.hash)) return null;
    const key = `${ref.incidentId}\0${ref.sequence}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.push({ incidentId: ref.incidentId as string, sequence: ref.sequence as number, hash: ref.hash });
  }
  return result;
}

function proseList(value: unknown, maxItems: number, maxBytes: number): string[] | null {
  if (!array(value) || value.length > maxItems) return null;
  const result: string[] = [];
  for (const item of value) { if (!prose(item, maxBytes)) return null; result.push(item as string); }
  return result;
}
function prose(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) return false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function canonicalReference(ref: EvidenceReference): EvidenceReference { return { incidentId: ref.incidentId, sequence: ref.sequence, hash: ref.hash }; }
function array(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return null;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!('value' in descriptor) || !descriptor.enumerable) return null;
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
