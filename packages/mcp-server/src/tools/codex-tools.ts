import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { codexRunSchema, codexStatusSchema, codexTaskHandleSchema, codexTaskLogsSchema } from './schemas.js';
import type { CodexRunOptions } from '@baitonghub-linux-mcp/codex';

function selectionOptions(input: { readonly role?: CodexRunOptions['role']; readonly model?: string | undefined; readonly effort?: CodexRunOptions['effort'] }): CodexRunOptions | undefined {
  if (input.role === undefined && input.model === undefined && input.effort === undefined) return undefined;
  return { ...(input.role === undefined ? {} : { role: input.role }), ...(input.model === undefined ? {} : { model: input.model }), ...(input.effort === undefined ? {} : { effort: input.effort }) };
}

export const CODEX_TOOL_NAMES = Object.freeze([
  'codex_status',
  'codex_run',
  'codex_task_list',
  'codex_task_status',
  'codex_task_logs',
  'codex_stop',
] as const);

export function codexTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'codex_status',
      description: 'Report local Codex installation and capabilities without credential inspection.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: codexStatusSchema,
      handler: async (input, signal) => {
        if (context.services.codex === undefined) return missingService();
        const options = selectionOptions(input);
        return options === undefined ? context.services.codex.status(context.actor) : context.services.codex.status(context.actor, options, signal);
      },
    }),
    defineTool({
      name: 'codex_run',
      description: 'Delegate an instruction to the local Codex CLI in a workspace.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: codexRunSchema,
      handler: async (input, signal) => context.services.codex === undefined
        ? missingService()
        : selectionOptions(input) === undefined
          ? context.services.codex.run(context.actor, input.workspaceId, input.instruction, signal)
          : context.services.codex.run(context.actor, input.workspaceId, input.instruction, signal, selectionOptions(input)),
    }),
    defineTool({
      name: 'codex_task_list',
      description: 'List local Codex task handles owned by this client, including launches whose response was cancelled.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: codexTaskHandleSchema.pick({ workspaceId: true }),
      handler: async (input) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.list(context.actor, input.workspaceId),
    }),
    defineTool({
      name: 'codex_task_status',
      description: 'Read status for an owned Codex task.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: codexTaskHandleSchema,
      handler: async (input) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.taskStatus(context.actor, input.workspaceId, input.codexTaskId),
    }),
    defineTool({
      name: 'codex_task_logs',
      description: 'Read bounded logs for an owned Codex task.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: codexTaskLogsSchema,
      handler: async (input) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.taskLogs(context.actor, input.workspaceId, input.codexTaskId, {
          ...(input.tailLines === undefined ? {} : { tailLines: input.tailLines }),
          ...(input.sinceSequence === undefined ? {} : { sinceSequence: input.sinceSequence }),
        }),
    }),
    defineTool({
      name: 'codex_stop',
      description: 'Stop an owned Codex task process.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: codexTaskHandleSchema,
      handler: async (input) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.stop(context.actor, input.workspaceId, input.codexTaskId),
    }),
  ];
}
