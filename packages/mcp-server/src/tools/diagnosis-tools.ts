import { z } from 'zod';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const reference = z.object({ incidentId: id, sequence: z.number().int().min(1).max(128), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const hypothesis = z.object({ id, statement: z.string().min(1).max(512), confidence: z.enum(['low','medium','high']), rationale: z.string().min(1).max(1024), assumptions: z.array(z.string().min(1).max(512)).max(8), unknowns: z.array(z.string().min(1).max(512)).max(8), supporting: z.array(reference).max(32), contradicting: z.array(reference).max(32) }).strict();
const fix = z.object({ id, hypothesisIds: z.array(id).min(1).max(8), description: z.string().min(1).max(1024), verification: z.string().min(1).max(1024) }).strict();
export const diagnosisSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('record'), diagnosisId: id, workspaceId: id, hypotheses: z.array(hypothesis).min(1).max(8), proposedFix: z.array(fix).min(1).max(8), userConfirmed: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('get'), diagnosisId: id, userConfirmed: z.boolean().optional() }).strict(),
]);
export function diagnosisTools(context: McpToolContext): McpToolDefinition[] {
  const service = context.services.diagnosis;
  return service === undefined ? [] : [defineTool({ name: 'diagnosis', description: 'Record or inspect immutable caller hypotheses and nonexecuting fix proposals linked to validated owned terminal incident rows. Server derives metadata facts, pins evidence/registration hashes and reports current/stale/unavailable support separately. Confidence is caller assertion; omit secrets from prose. Current READ/WRITE governs recording. No probes, model dispatch, patches or deployment.', permission: 'READ', annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: diagnosisSchema, handler: async (input, signal) => service.execute(context.actor, input, signal) })];
}
