import { verifiedSkillListSchema, verifiedSkillLoadSchema, verifiedWorkflowPlanSchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

export function verifiedSkillTools(context: McpToolContext): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  const skills = context.services.verifiedSkills;
  if (skills !== undefined) {
    tools.push(defineTool({
      name: 'skills_verified_list',
      description: 'List code-owned skill review metadata matching a role in a registered workspace. Does not read documents or verify their current bytes.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: verifiedSkillListSchema,
      handler: async (input, signal) => skills.list(context.actor, { workspaceId: input.workspaceId, role: input.role, ...(input.query === undefined ? {} : { query: input.query }) }, signal),
    }), defineTool({
      name: 'skills_verified_load',
      description: 'Load one pinned, reviewed guidance document and verify current raw document/license hashes. No links, scripts, hooks, permission grants, installation or execution.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: verifiedSkillLoadSchema,
      handler: async (input, signal) => skills.load(context.actor, input, signal),
    }));
  }
  const plans = context.services.verifiedWorkflowPlan;
  if (plans !== undefined) tools.push(defineTool({
    name: 'workflow_plan_verified',
    description: 'Prepare caller-native role prompts with up to three server-verified skill documents as untrusted guidance. Fails closed on failed selections; grants no authority and never dispatches.',
    permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: verifiedWorkflowPlanSchema,
    handler: async (input, signal) => plans.execute(context.actor, input, signal),
  }));
  return tools;
}
