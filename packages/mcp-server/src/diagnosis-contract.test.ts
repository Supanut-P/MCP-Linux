import { describe, expect, it } from 'vitest';
import { diagnosisReferences, diagnosisRequestFingerprint, parseDiagnosisRequest, type DiagnosisRecordRequest } from './diagnosis-contract.js';

const hash = 'a'.repeat(64);
function validRequest(): DiagnosisRecordRequest {
  return {
    operation: 'record', diagnosisId: 'diag-1', workspaceId: 'ws-1',
    hypotheses: [{ id: 'h1', statement: 'A possible cause', confidence: 'medium', rationale: 'Caller interpretation\nwith a second line', assumptions: ['assuming input is current'], unknowns: ['source status'],
      supporting: [{ incidentId: 'inc-1', sequence: 1, hash }], contradicting: [] }],
    proposedFix: [{ id: 'fix1', hypothesisIds: ['h1'], description: 'Review the setting', verification: 'Collect a new incident' }],
  };
}

describe('diagnosis request contract', () => {
  it('accepts bounded record/get requests and returns unique references', () => {
    const record = validRequest();
    const parsed = parseDiagnosisRequest(record);
    expect(parsed).toEqual(record);
    expect(diagnosisReferences(record)).toEqual(record.hypotheses[0]!.supporting);
    expect(parseDiagnosisRequest({ operation: 'get', diagnosisId: 'diag-1' })).toEqual({ operation: 'get', diagnosisId: 'diag-1' });
  });

  it('rejects accessors, symbols, unknown keys, non-plain objects and non-JSON numbers without invoking getters', () => {
    let called = false;
    const accessor = { operation: 'get', diagnosisId: 'diag-1' };
    Object.defineProperty(accessor, 'userConfirmed', { enumerable: true, get() { called = true; return true; } });
    expect(parseDiagnosisRequest(accessor)).toBeNull();
    expect(called).toBe(false);
    expect(parseDiagnosisRequest({ operation: 'get', diagnosisId: 'diag-1', extra: true })).toBeNull();
    expect(parseDiagnosisRequest(Object.assign(Object.create({ inherited: true }), { operation: 'get', diagnosisId: 'diag-1' }))).toBeNull();
    expect(parseDiagnosisRequest({ operation: 'get', diagnosisId: 'diag-1', [Symbol('hidden')]: 1 })).toBeNull();
    expect(parseDiagnosisRequest({ ...validRequest(), hypotheses: [NaN] })).toBeNull();
    const customArray = [validRequest().hypotheses[0]] as unknown[] & { extra?: number };
    customArray.extra = 1;
    expect(parseDiagnosisRequest({ ...validRequest(), hypotheses: customArray })).toBeNull();
  });

  it('enforces IDs, hashes, sequence bounds, links, per-field prose rules and overall bytes', () => {
    const base = validRequest();
    expect(parseDiagnosisRequest({ ...base, diagnosisId: 'has spaces' })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...base.hypotheses[0]!, supporting: [{ incidentId: 'inc-1', sequence: 0, hash }] }] })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...base.hypotheses[0]!, supporting: [{ incidentId: 'inc-1', sequence: 1, hash: 'A'.repeat(64) }] }] })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, proposedFix: [{ ...base.proposedFix[0]!, hypothesisIds: ['missing'] }] })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...base.hypotheses[0]!, statement: ' \t\n' }] })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...base.hypotheses[0]!, rationale: `ok\u0001bad` }] })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...base.hypotheses[0]!, statement: 'é'.repeat(257) }] })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...base.hypotheses[0]!, rationale: 'x'.repeat(24 * 1024) }] })).toBeNull();
  });

  it('rejects conflicting hashes for one incident row and duplicate refs within a list', () => {
    const base = validRequest();
    const ref = base.hypotheses[0]!.supporting[0]!;
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...base.hypotheses[0]!, contradicting: [{ ...ref, hash: 'b'.repeat(64) }] }] })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...base.hypotheses[0]!, supporting: [ref, ref] }] })).toBeNull();
  });

  it('caps hypotheses, fixes, references, and distinct incidents', () => {
    const base = validRequest();
    const h = base.hypotheses[0]!;
    expect(parseDiagnosisRequest({ ...base, hypotheses: Array.from({ length: 9 }, (_, i) => ({ ...h, id: `h${i}` })) })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, proposedFix: Array.from({ length: 9 }, (_, i) => ({ ...base.proposedFix[0]!, id: `f${i}` })) })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...h, supporting: Array.from({ length: 33 }, (_, i) => ({ incidentId: `i${i}`, sequence: 1, hash })) }] })).toBeNull();
    expect(parseDiagnosisRequest({ ...base, hypotheses: [{ ...h, supporting: Array.from({ length: 9 }, (_, i) => ({ incidentId: `i${i}`, sequence: 1, hash })) }] })).toBeNull();
  });

  it('fingerprints canonical persisted fields and ignores user confirmation', () => {
    const req = validRequest();
    const fingerprint = diagnosisRequestFingerprint(req);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(diagnosisRequestFingerprint({ ...req, userConfirmed: true })).toBe(fingerprint);
    expect(diagnosisRequestFingerprint({ ...req, hypotheses: [{ ...req.hypotheses[0]!, statement: 'Changed' }] })).not.toBe(fingerprint);
    expect(parseDiagnosisRequest({ diagnosisId: req.diagnosisId, operation: req.operation, workspaceId: req.workspaceId,
      proposedFix: req.proposedFix, hypotheses: req.hypotheses })).toEqual(req);
  });
});
