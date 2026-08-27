import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { mapNodeFsError } from './fs-error.js';

export async function ensureParentDirectory(filePath: string): Promise<Result<void>> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    return ok(undefined);
  } catch (error: unknown) {
    return err(mapNodeFsError(error, 'Unable to create parent directory'));
  }
}
