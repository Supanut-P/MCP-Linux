import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import {
  applyPatchSchema,
  copyFileSchema,
  deleteFileSchema,
  moveFileSchema,
  readFileSchema,
  readFilesSchema,
  restoreDeletedFileSchema,
  writeFileSchema,
} from './schemas.js';

export function fileTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'read_file',
      description: 'Read a workspace file as UTF-8 text or as an image/binary payload. Absolute Linux paths under a registered root do not require workspaceId. For large files or an unknown location, prefer search_text first and then read_file_page for the relevant range instead of reading the whole file.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: readFileSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.readFile(context.actor, input.workspaceId, {
          path: input.path,
          ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
          ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
        }),
    }),
    defineTool({
      name: 'read_files',
      description: 'Read up to twenty bounded workspace files in parallel. Absolute paths do not require workspaceId. For large files, locate text with search_text and page with read_file_page instead of loading entire files.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: readFilesSchema,
      handler: async (input) => context.services.file === undefined
        ? missingService()
        : context.services.file.readFiles(context.actor, input.workspaceId, {
          files: input.files.map((file) => ({
            path: file.path,
            ...(file.startLine === undefined ? {} : { startLine: file.startLine }),
            ...(file.endLine === undefined ? {} : { endLine: file.endLine }),
          })),
        }),
    }),
    defineTool({
      name: 'write_file',
      description: 'Write UTF-8 text, creating missing parent directories. Checkpoints an existing target first. Absolute paths do not require workspaceId.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: writeFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.writeFile(context.actor, input.workspaceId, { path: input.path, content: input.content }, signal),
    }),
    defineTool({
      name: 'apply_patch',
      description: 'Validate and apply bounded file changes, creating missing parent directories.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: applyPatchSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.applyPatch(context.actor, input.workspaceId, { files: input.files }, signal),
    }),
    defineTool({
      name: 'move_file',
      description: 'Move a file or directory within one workspace, creating missing destination parents.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: moveFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.moveFile(context.actor, input.workspaceId, { sourcePath: input.sourcePath, destinationPath: input.destinationPath }, signal),
    }),
    defineTool({
      name: 'copy_file',
      description: 'Copy a file or directory within one workspace, creating missing destination parents.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: copyFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.copyFile(context.actor, input.workspaceId, { sourcePath: input.sourcePath, destinationPath: input.destinationPath }, signal),
    }),
    defineTool({
      name: 'delete_file',
      description: 'Delete one file or an empty directory inside its workspace. Fine-grained policy may auto-approve only when this call supplies a registered workspaceId and the target is proven inside that workspace. Protected Critical Files remain approval-gated; when Recovery Trash is enabled the result includes a recoveryId. Workspace-root deletion remains blocked.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: deleteFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.deleteFile(context.actor, input.workspaceId, {
          path: input.path,
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal),
    }),
    defineTool({
      name: 'restore_deleted_file',
      description: 'Restore one Recovery Trash item to its original path. Refuses to overwrite an existing target and remains scoped to the recorded workspace.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: restoreDeletedFileSchema,
      handler: async (input, signal) => context.services.file === undefined
        ? missingService()
        : context.services.file.restoreDeletedFile(context.actor, input.workspaceId, { recoveryId: input.recoveryId }, signal),
    }),
  ];
}
