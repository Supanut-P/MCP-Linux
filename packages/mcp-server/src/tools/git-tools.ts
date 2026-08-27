import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { gitDiffSchema, gitLogSchema, gitRunSchema, gitStatusSchema } from './schemas.js';

export function gitTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'git_status',
      description: 'Inspect parsed read-only Git status. For writes (init, add, commit, remote, push, rm, clean, reset) use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitStatusSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.status(context.actor, input.workspaceId, signal),
    }),
    defineTool({
      name: 'git_diff',
      description: 'Return a bounded read-only Git diff. For writes use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitDiffSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.diff(context.actor, input.workspaceId, {
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.staged === undefined ? {} : { staged: input.staged }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        }, signal),
    }),
    defineTool({
      name: 'git_log',
      description: 'Return bounded structured Git history. For writes use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitLogSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.log(context.actor, input.workspaceId, {
          ...(input.maxCommits === undefined ? {} : { maxCommits: input.maxCommits }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        }, signal),
    }),
    defineTool({
      name: 'git',
      description: 'Run any git subcommand immediately with a separate args array (init, clone, add, commit, remote, fetch, pull, push, rm, mv, restore, checkout, switch, branch, tag, stash, merge, rebase, cherry-pick, reset, clean, revert). cwd may be an absolute path; workspaceId is then optional. Returns exitCode, stdout, and stderr. Destructive Git operations require explicit chat confirmation and userConfirmed: true unless that command family is globally auto-approved and this call supplies a registered workspaceId whose project boundary contains every target. Do not wrap git in a shell.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: gitRunSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.run(context.actor, {
          args: input.args,
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.timeoutSeconds === undefined ? {} : { timeoutMs: Math.floor(input.timeoutSeconds * 1000) }),
        }, signal),
    }),
  ];
}
