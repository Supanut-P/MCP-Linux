import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { SecretPolicy } from '@baitonghub-linux-mcp/workspace';

/** Automatic task discovery never opts into known secret paths. */
export function isContextSourcePath(filePath: string): boolean {
  return new SecretPolicy().assertReadable(filePath).ok;
}

export interface ContextFileRequest {
  readonly path: string;
  readonly maxBytes?: number;
}

export type ContextSource =
  | { readonly status: 'available'; readonly path: string; readonly sourceSha256: string; readonly sourceBytes: number; readonly text: string; readonly rootFingerprint: string }
  | { readonly status: 'unavailable'; readonly path: string; readonly sourceBytes?: number; readonly reason: 'too_large' | 'binary' | 'invalid_utf8' | 'changed'; readonly rootFingerprint: string };

interface ReadContextFileOptions {
  readonly path: string;
  readonly relativePath: string;
  readonly rootPath: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  readonly revalidate: () => Promise<string | null>;
}

export async function readContextFile(options: ReadContextFileOptions): Promise<Result<ContextSource>> {
  if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Context file read was cancelled', true));
  let rootBefore: string;
  let rootIdentityBefore: string;
  try {
    rootBefore = await realpath(options.rootPath);
    const rootStat = await stat(rootBefore);
    if (!rootStat.isDirectory()) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root was not found'));
    rootIdentityBefore = identity(rootStat.dev, rootStat.ino, rootBefore);
  } catch {
    return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root was not found'));
  }

  let handle: FileHandle | undefined;
  try {
    // A registered path may be a FIFO: reject it after opening without waiting
    // for another process to attach as a writer.
    handle = await open(options.path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) return err(appError('INVALID_INPUT', 'Context source must be a regular file'));
    const rootFingerprint = rootIdentityBefore;
    const buffer = Buffer.alloc(options.maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Context file read was cancelled', true));
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const after = await handle.stat();
    let currentPath: string | null;
    try { currentPath = await options.revalidate(); } catch { currentPath = null; }
    if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Context file read was cancelled', true));
    let rootAfter: string;
    let rootIdentityAfter: string;
    try {
      rootAfter = await realpath(options.rootPath);
      const rootStatAfter = await stat(rootAfter);
      rootIdentityAfter = identity(rootStatAfter.dev, rootStatAfter.ino, rootAfter);
    } catch {
      return ok({ status: 'unavailable', path: options.relativePath, reason: 'changed', rootFingerprint });
    }
    let pathAfter: Stats | undefined;
    if (currentPath !== null && currentPath === options.path) {
      try { pathAfter = await stat(currentPath); } catch { /* A vanished or replaced path is unavailable. */ }
    }
    if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Context file read was cancelled', true));
    const stableIdentity = rootIdentityBefore === rootIdentityAfter && rootBefore === rootAfter
      && currentPath === options.path && sameFile(before, after)
      && pathAfter !== undefined && sameFile(after, pathAfter);
    const stable = stableIdentity && bytesRead === after.size;
    if (!stable || bytesRead > options.maxBytes || after.size !== before.size) {
      if (stableIdentity && bytesRead === options.maxBytes + 1 && after.size > options.maxBytes) {
        return ok({ status: 'unavailable', path: options.relativePath, sourceBytes: after.size, reason: 'too_large', rootFingerprint });
      }
      return ok({ status: 'unavailable', path: options.relativePath, reason: 'changed', rootFingerprint });
    }
    const raw = buffer.subarray(0, bytesRead);
    if (raw.includes(0)) return ok({ status: 'unavailable', path: options.relativePath, sourceBytes: after.size, reason: 'binary', rootFingerprint });
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return ok({ status: 'unavailable', path: options.relativePath, sourceBytes: after.size, reason: 'invalid_utf8', rootFingerprint });
    }
    return ok({ status: 'available', path: options.relativePath, sourceSha256: createHash('sha256').update(raw).digest('hex'), sourceBytes: raw.byteLength, text, rootFingerprint });
  } catch {
    if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Context file read was cancelled', true));
    return err(appError('INTERNAL_ERROR', 'Context file could not be read', true));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function identity(dev: number | bigint, ino: number | bigint, canonicalPath: string): string {
  return createHash('sha256').update(`${dev}:${ino}:${canonicalPath}`).digest('hex');
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
