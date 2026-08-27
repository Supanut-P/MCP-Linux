import { appError, type AppError } from '@baitonghub-linux-mcp/domain';

export function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function mapNodeFsError(error: unknown, fallbackMessage: string): AppError {
  const code = nodeErrorCode(error);
  if (code === 'ENOENT') return appError('FILE_NOT_FOUND', 'File or directory was not found');
  if (code === 'ENOTDIR') return appError('INVALID_INPUT', 'A parent path exists as a file, not a directory');
  if (code === 'EEXIST') return appError('INVALID_INPUT', 'Destination already exists');
  return appError('INTERNAL_ERROR', fallbackMessage, true);
}
