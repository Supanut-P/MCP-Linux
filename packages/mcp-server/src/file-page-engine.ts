import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type { McpApplicationServices } from './tools/tool-types.js';

export interface FilePageRequest {
  readonly workspaceId?: string;
  readonly path: string;
  readonly startLine?: number;
  readonly pageSize?: number;
  readonly responseTargetBytes?: number;
}

export interface FilePageResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly encoding?: 'utf8' | 'base64';
  readonly mimeType?: string;
  readonly byteLength?: number;
  readonly hasMore: boolean;
  readonly continuationToken?: string;
}

interface Continuation {
  readonly workspaceId?: string;
  readonly path: string;
  readonly nextStartLine: number;
  readonly pageSize: number;
  readonly responseTargetBytes?: number;
}

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 5_000;
const MAX_RESPONSE_TARGET_BYTES = 8 * 1024 * 1024;

export class FilePageEngine {
  private readonly continuations = new Map<string, Continuation>();

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
  ) {}

  public async readPage(request: FilePageRequest): Promise<Result<FilePageResult>> {
    const validation = validateRequest(request);
    if (!validation.ok) return validation;
    return this.readAt({
      ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      path: request.path,
      nextStartLine: request.startLine ?? 1,
      pageSize: request.pageSize ?? DEFAULT_PAGE_SIZE,
      ...(request.responseTargetBytes === undefined ? {} : { responseTargetBytes: request.responseTargetBytes }),
    });
  }

  public async continue(token: string, pageSize?: number): Promise<Result<FilePageResult>> {
    const continuation = this.continuations.get(token);
    if (continuation === undefined) return err({ code: 'INVALID_INPUT', message: 'File continuation token is invalid or expired', recoverable: false });
    this.continuations.delete(token);
    const next = pageSize === undefined ? continuation.pageSize : pageSize;
    if (!Number.isInteger(next) || next < 1 || next > MAX_PAGE_SIZE) return err({ code: 'INVALID_INPUT', message: 'File pageSize is invalid', recoverable: false });
    return this.readAt({ ...continuation, pageSize: next });
  }

  private async readAt(input: Continuation): Promise<Result<FilePageResult>> {
    if (this.services.file === undefined) return err({ code: 'INTERNAL_ERROR', message: 'File service is unavailable', recoverable: true });
    const requestedEndLine = input.nextStartLine + input.pageSize;
    try {
      const result = await this.services.file.readFile(this.actor, input.workspaceId, {
        path: input.path,
        startLine: input.nextStartLine,
        endLine: requestedEndLine,
      });
      if (!result.ok) return result;
      if (result.value.encoding === 'base64') {
        return ok({
          path: result.value.path,
          startLine: result.value.startLine,
          endLine: result.value.endLine,
          content: result.value.content,
          encoding: result.value.encoding,
          ...(result.value.mimeType === undefined ? {} : { mimeType: result.value.mimeType }),
          ...(result.value.byteLength === undefined ? {} : { byteLength: result.value.byteLength }),
          hasMore: false,
        });
      }

      let content = result.value.content;
      let returnedLineCount = countLines(content);
      if (returnedLineCount > input.pageSize) {
        content = takeLines(content, input.pageSize);
        returnedLineCount = countLines(content);
      }
      if (input.responseTargetBytes !== undefined && Buffer.byteLength(content, 'utf8') > input.responseTargetBytes) {
        const targeted = takeLinesToBytes(content, input.responseTargetBytes);
        content = targeted.content;
        returnedLineCount = targeted.lineCount;
      }
      const startLine = input.nextStartLine;
      const endLine = returnedLineCount === 0 ? startLine : startLine + returnedLineCount - 1;
      const hasMore = result.value.endLine > endLine;
      let continuationToken: string | undefined;
      if (hasMore) {
        continuationToken = randomUUID();
        this.continuations.set(continuationToken, {
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          path: input.path,
          nextStartLine: endLine + 1,
          pageSize: input.pageSize,
          ...(input.responseTargetBytes === undefined ? {} : { responseTargetBytes: input.responseTargetBytes }),
        });
      }
      return ok({
        path: result.value.path,
        startLine,
        endLine,
        content,
        encoding: 'utf8',
        ...(result.value.mimeType === undefined ? {} : { mimeType: result.value.mimeType }),
        byteLength: Buffer.byteLength(content, 'utf8'),
        hasMore,
        ...(continuationToken === undefined ? {} : { continuationToken }),
      });
    } catch {
      return err({ code: 'INTERNAL_ERROR', message: 'Paged file read failed', recoverable: true });
    }
  }
}

function validateRequest(request: FilePageRequest): Result<void> {
  if (typeof request.path !== 'string' || request.path.trim().length === 0) return err({ code: 'INVALID_INPUT', message: 'File path is required', recoverable: false });
  if (request.startLine !== undefined && (!Number.isInteger(request.startLine) || request.startLine < 1)) return err({ code: 'INVALID_INPUT', message: 'File startLine is invalid', recoverable: false });
  if (request.pageSize !== undefined && (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > MAX_PAGE_SIZE)) return err({ code: 'INVALID_INPUT', message: 'File pageSize is invalid', recoverable: false });
  if (request.responseTargetBytes !== undefined && (!Number.isInteger(request.responseTargetBytes) || request.responseTargetBytes < 1 || request.responseTargetBytes > MAX_RESPONSE_TARGET_BYTES)) return err({ code: 'INVALID_INPUT', message: 'File responseTargetBytes is invalid', recoverable: false });
  return ok(undefined);
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}

function takeLines(content: string, count: number): string {
  return content.split(/\r?\n/).slice(0, count).join('\n');
}

function takeLinesToBytes(content: string, targetBytes: number): { readonly content: string; readonly lineCount: number } {
  const lines = content.split(/\r?\n/);
  let selected = '';
  let lineCount = 0;
  for (const line of lines) {
    const next = selected.length === 0 ? line : `${selected}\n${line}`;
    if (lineCount > 0 && Buffer.byteLength(next, 'utf8') > targetBytes) break;
    selected = next;
    lineCount += 1;
    if (Buffer.byteLength(selected, 'utf8') >= targetBytes) break;
  }
  return { content: selected, lineCount };
}
