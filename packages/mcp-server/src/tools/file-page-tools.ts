import { defineTool, type McpToolDefinition } from './tool-types.js';
import { readFilePageContinueSchema, readFilePageSchema } from './schemas.js';
import type { FilePageEngine } from '../file-page-engine.js';

export function filePageTools(engine: FilePageEngine): McpToolDefinition[] {
  return [
    defineTool({
      name: 'read_file_page',
      description: 'Preferred reader for large files after search_text identifies the relevant area. Reads a deterministic line chunk with explicit continuation instead of silently truncating or loading the whole file.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: readFilePageSchema,
      handler: async (input) => engine.readPage({
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        path: input.path,
        ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
        ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
        ...(input.responseTargetBytes === undefined ? {} : { responseTargetBytes: input.responseTargetBytes }),
      }),
    }),
    defineTool({
      name: 'read_file_page_continue',
      description: 'Continue read_file_page from the next deterministic line chunk only when more surrounding context is needed; avoid re-reading earlier pages.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: readFilePageContinueSchema,
      handler: async (input) => engine.continue(input.continuationToken, input.pageSize),
    }),
  ];
}
