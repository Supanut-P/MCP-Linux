import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { ContextEngine } from '../context-engine.js';
import {
  readManyFilesSchema,
  searchAllSchema,
  workspaceContextContinueSchema,
  workspaceContextSchema,
  workspaceFullScanContinueSchema,
  workspaceFullScanSchema,
  workspaceSnapshotSchema,
} from './schemas.js';

export function contextTools(context: McpToolContext, engine: ContextEngine): McpToolDefinition[] {
  void context;
  return [
    defineTool({
      name: 'workspace_context',
      description: 'Aggregate ranked workspace context with snippets, symbols, Git/test relevance, economy metadata, and continuation; automatic discovery can be explicitly expanded.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceContextSchema,
      handler: async (input) => engine.collect({
        query: input.query,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.path === undefined ? {} : { path: input.path }),
        intent: input.intent,
        mode: input.mode,
        includeIgnored: input.includeIgnored,
        ...(input.responseTargetBytes === undefined ? {} : { responseTargetBytes: input.responseTargetBytes }),
        ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
      }),
    }),
    defineTool({
      name: 'workspace_context_continue',
      description: 'Continue a workspace_context result without discarding unreturned candidates.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceContextContinueSchema,
      handler: async (input) => engine.continue(input.continuationToken, input.pageSize),
    }),
    defineTool({
      name: 'workspace_full_scan',
      description: 'Enumerate workspace files with full access by default; set includeIgnored false to use the persistent automatic index.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceFullScanSchema,
      handler: async (input) => engine.fullScan({
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.glob === undefined ? {} : { glob: input.glob }),
        includeIgnored: input.includeIgnored,
        ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
      }),
    }),
    defineTool({
      name: 'workspace_full_scan_continue',
      description: 'Continue a workspace_full_scan result page.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceFullScanContinueSchema,
      handler: async (input) => engine.continueFullScan(input.continuationToken, input.pageSize),
    }),
    defineTool({
      name: 'workspace_snapshot',
      description: 'Return workspace identity and project snapshot metadata without source contents.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceSnapshotSchema,
      handler: async (input) => engine.snapshot(input.workspaceId),
    }),
    defineTool({
      name: 'search_all',
      description: 'Search text and filenames across one or all registered workspaces with automatic economy filters or an explicit includeIgnored override.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: searchAllSchema,
      handler: async (input) => engine.searchAll({
        query: input.query,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.glob === undefined ? {} : { glob: input.glob }),
        ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
        includeIgnored: input.includeIgnored,
      }),
    }),
    defineTool({
      name: 'read_many_files',
      description: 'Read many workspace files in parallel while preserving one result or error per requested path.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: readManyFilesSchema,
      handler: async (input) => engine.readMany({
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        files: input.files.map((file) => ({
          path: file.path,
          ...(file.startLine === undefined ? {} : { startLine: file.startLine }),
          ...(file.endLine === undefined ? {} : { endLine: file.endLine }),
        })),
      }),
    }),
  ];
}
