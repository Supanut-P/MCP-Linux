import { z } from 'zod';
import { workflowPlanSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const incidentFixSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('prepare'),fixId:id,diagnosisId:id,diagnosisHash:z.string().regex(/^[a-f0-9]{64}$/),mappingId:id,mappingRevision:z.number().int().min(0),contract:workflowPlanSchema,context:z.array(z.object({path:z.string().min(1).max(4096),startLine:z.number().int().min(1).max(1_000_000),endLine:z.number().int().min(1).max(1_000_000)}).strict()).min(1).max(8),userConfirmed:z.boolean().optional()}).strict(),
  z.object({operation:z.literal('status'),fixId:id,userConfirmed:z.boolean().optional()}).strict(),
]);
export function incidentFixTools(context:McpToolContext):McpToolDefinition[]{
  const service=context.services.incidentFix;
  return service===undefined?[]:[defineTool({name:'incident_fix',description:'Prepare an immutable owned diagnosis/service-mapping link and one durable local fix task atomically. Capture bounded caller-selected source ranges with hashes. Current READ/WRITE applies; preparation never executes models, commands, patches or deployment. Status resolves the reference and distinguishes retained context from current mapping/evidence/source freshness. Latest workflow claims and QA revalidate incident links. Older binaries omit this validation: stop writers and withhold linked tasks during rollback.',permission:'READ',annotations:{readOnlyHint:false,destructiveHint:false},inputSchema:incidentFixSchema,handler:async(input,signal)=>service.execute(context.actor,input,signal)})];
}
