import { createHash, randomUUID } from 'node:crypto';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@baitonghub-linux-mcp/capabilities';

export type McpTransportKind = 'http' | 'stdio';

export interface McpRequestScope {
  readonly sessionId: string;
  readonly transport: McpTransportKind;
  readonly protocolSessionId?: string;
  readonly workspaceId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
}

export interface HttpRequestScopeOptions {
  readonly request?: Request;
  readonly fallbackSessionId: string;
}

/** One synthetic identity for one STDIO serving lifetime. */
export function createStdioRequestScope(sessionId = randomUUID()): McpRequestScope {
  return { sessionId: normalizeInternalSessionId(sessionId), transport: 'stdio' };
}

/**
 * HTTP prefers an MCP protocol session when the transport exposes one. Modern
 * stateless requests intentionally fall back to one endpoint-scoped identity;
 * no ChatGPT conversation identifier is guessed or invented from client data.
 */
export function createHttpRequestScope(options: HttpRequestScopeOptions): McpRequestScope {
  const protocolSessionId = boundedProtocolSessionId(options.request?.headers.get('mcp-session-id'));
  return {
    sessionId: protocolSessionId === undefined
      ? normalizeInternalSessionId(options.fallbackSessionId)
      : `http-${fingerprint(protocolSessionId)}`,
    transport: 'http',
    ...(protocolSessionId === undefined ? {} : { protocolSessionId }),
  };
}

export function createProtocolHttpRequestScope(protocolSessionId: string): McpRequestScope {
  const bounded = boundedProtocolSessionId(protocolSessionId);
  if (bounded === undefined) throw new Error('Protocol session ID is invalid');
  return { sessionId: `http-${fingerprint(bounded)}`, transport: 'http', protocolSessionId: bounded };
}

/** Keep the transport client identity stable while making ownership session-specific. */
export function actorForRequestScope(actor: FileActor, scope: McpRequestScope | undefined): FileActor {
  if (scope === undefined) return actor;
  return { ...actor, sessionId: scope.sessionId };
}


export function withCapabilityOwnerMetadata(input: unknown, actor: FileActor): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const request = input as Record<string, unknown>;
  const existingMetadata = typeof request.metadata === 'object' && request.metadata !== null && !Array.isArray(request.metadata)
    ? request.metadata as Record<string, unknown>
    : {};
  const workspaceId = typeof request.workspaceId === 'string' && request.workspaceId.trim().length > 0 ? request.workspaceId.trim() : undefined;
  return {
    ...request,
    metadata: {
      ...existingMetadata,
      [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
        clientId: actor.clientId,
        sessionId: actor.sessionId?.trim() || actor.clientId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
    },
  };
}

function normalizeInternalSessionId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : `session-${fingerprint(trimmed || randomUUID())}`;
}

function boundedProtocolSessionId(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 256);
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
