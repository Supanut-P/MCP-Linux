import { describe, expect, it } from 'vitest';
import { incidentFixReference, incidentFixRequestFingerprint, parseIncidentFixReference, parseIncidentFixRequest, type IncidentFixPrepareRequest } from './incident-fix-contract.js';
import type { WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';

const hash = 'a'.repeat(64);
function workflow(overrides: Partial<WorkflowTaskContract> = {}): WorkflowTaskContract {
  return { taskId: 'task-1', goal: 'Fix the reported issue', workspaceId: 'ws-1', allowedFiles: ['src/a.ts'], dependencies: [],
    acceptanceCriteria: ['Regression is covered'], acceptanceCommands: [{ executable: 'pnpm', args: ['test'], expectedExitCode: 0, timeoutSeconds: 30 }],
    contextReferences: ['docs/issue.md'], workerRole: 'coding', plannerRequired: false, securitySensitive: false, stopConditions: ['Stop if scope changes'], ...overrides };
}
function request(overrides: Partial<IncidentFixPrepareRequest> = {}): IncidentFixPrepareRequest {
  return { operation: 'prepare', fixId: 'fix-1', diagnosisId: 'diag-1', diagnosisHash: hash, mappingId: 'mapping-1', mappingRevision: 2,
    contract: workflow(), context: [{ path: 'src/a.ts', startLine: 1, endLine: 10 }], ...overrides };
}

describe('incident fix request contract', () => {
  it('parses status and normalized prepare requests', () => {
    expect(parseIncidentFixRequest({ operation: 'status', fixId: 'fix-1' })).toEqual({ operation: 'status', fixId: 'fix-1' });
    expect(parseIncidentFixRequest(request())).toEqual(request());
  });

  it('rejects unknown keys, accessors, symbols, cycles and custom arrays without invoking getters', () => {
    let invoked = false;
    const accessor = { operation: 'status', fixId: 'fix-1' };
    Object.defineProperty(accessor, 'userConfirmed', { enumerable: true, get() { invoked = true; return true; } });
    expect(parseIncidentFixRequest(accessor)).toBeNull();
    expect(invoked).toBe(false);
    expect(parseIncidentFixRequest({ operation: 'status', fixId: 'fix-1', unexpected: 1 })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), [Symbol('hidden')]: true })).toBeNull();
    const cyclic = request() as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(parseIncidentFixRequest(cyclic)).toBeNull();
    const custom = [request().context[0]] as unknown[] & { extra?: boolean };
    custom.extra = true;
    expect(parseIncidentFixRequest({ ...request(), context: custom })).toBeNull();
  });

  it('requires valid IDs, hashes, mapping revisions, one task, empty dependencies, and acceptance evidence', () => {
    expect(parseIncidentFixRequest({ ...request(), fixId: 'bad id' })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), diagnosisHash: 'A'.repeat(64) })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), mappingRevision: -1 })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), mappingRevision: 1.5 })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), contract: workflow({ dependencies: ['other-task'] }) })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), contract: workflow({ acceptanceCommands: [] }) })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), contract: workflow({ acceptanceCriteria: [] }) })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), contract: workflow({ allowedFiles: Array.from({ length: 17 }, (_, i) => `src/${i}.ts`) }) })).toBeNull();
  });

  it('rejects caller preparation links and source ranges outside the allowed scope or limits', () => {
    expect(parseIncidentFixRequest({ ...request(), contract: workflow({ contextReferences: ['incident_fix:v1:old:hash'] }) })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), context: [] })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), context: [{ path: 'src/other.ts', startLine: 1, endLine: 1 }] })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), context: [{ path: 'src/a.ts', startLine: 0, endLine: 1 }] })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), context: [{ path: 'src/a.ts', startLine: 9, endLine: 8 }] })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), context: [{ path: 'src/a.ts', startLine: 1, endLine: 201 }] })).toBeNull();
    expect(parseIncidentFixRequest({ ...request(), context: [{ path: 'src/a.ts', startLine: 1, endLine: 1_000_001 }] })).toBeNull();
    const range = { path: 'src/a.ts', startLine: 1, endLine: 1 };
    expect(parseIncidentFixRequest({ ...request(), context: [range, range] })).toBeNull();
  });

  it('enforces UTF-8 serialized request budget', () => {
    const path = '界'.repeat(1000);
    const manyRanges = Array.from({ length: 8 }, (_, i) => ({ path, startLine: i + 1, endLine: i + 1 }));
    expect(parseIncidentFixRequest({ ...request(), contract: workflow({ allowedFiles: [path] }), context: manyRanges })).toBeNull();
  });

  it('fingerprints normalized contract fields independent of property order and confirmation', () => {
    const req = request();
    const fingerprint = incidentFixRequestFingerprint(req);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(incidentFixRequestFingerprint({ ...req, userConfirmed: true })).toBe(fingerprint);
    const reversedContract = Object.fromEntries(Object.entries(workflow()).reverse()) as unknown as WorkflowTaskContract;
    expect(incidentFixRequestFingerprint({ ...req, contract: reversedContract })).toBe(fingerprint);
    expect(incidentFixRequestFingerprint({ ...req, mappingRevision: 3 })).not.toBe(fingerprint);
    expect(incidentFixRequestFingerprint({ ...req, diagnosisId: 'diag-2' })).not.toBe(fingerprint);
  });

  it('builds and parses strict references while splitting fix IDs at the final colon', () => {
    const reference = incidentFixReference('fix:part-1', hash);
    expect(reference).toBe(`incident_fix:v1:fix:part-1:${hash}`);
    expect(parseIncidentFixReference(reference)).toEqual({ fixId: 'fix:part-1', linkHash: hash });
    expect(parseIncidentFixReference(reference.replace('v1', 'v2'))).toBeNull();
    expect(parseIncidentFixReference(`incident_fix:v1:fix:${'A'.repeat(64)}`)).toBeNull();
    expect(parseIncidentFixReference(`incident_fix:v1:${'x'.repeat(129)}:${hash}`)).toBeNull();
  });
});
