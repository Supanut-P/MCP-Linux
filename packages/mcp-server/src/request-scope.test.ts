import { describe, expect, it } from 'vitest';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@baitonghub-linux-mcp/capabilities';
import { actorForRequestScope, createHttpRequestScope, createProtocolHttpRequestScope, createStdioRequestScope, withCapabilityOwnerMetadata } from './request-scope.js';

describe('MCP request scope', () => {
  it('keeps protocol HTTP sessions stable and distinct', () => {
    const first = createProtocolHttpRequestScope('protocol-a');
    const reconnect = createProtocolHttpRequestScope('protocol-a');
    const other = createProtocolHttpRequestScope('protocol-b');
    expect(reconnect.sessionId).toBe(first.sessionId);
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  it('uses one explicit synthetic STDIO identity for a serving lifetime', () => {
    expect(createStdioRequestScope('stdio-a')).toMatchObject({ sessionId: 'stdio-a', transport: 'stdio' });
  });

  it('uses a stable endpoint fallback only when HTTP has no protocol session', () => {
    const request = new Request('http://127.0.0.1/mcp');
    expect(createHttpRequestScope({ request, fallbackSessionId: 'endpoint-a' }).sessionId).toBe('endpoint-a');
  });

  it('overwrites spoofed task ownership metadata with the trusted scoped actor', () => {
    const actor = actorForRequestScope({ clientId: 'client-1', clientName: 'test' }, createStdioRequestScope('session-a'));
    const input = withCapabilityOwnerMetadata({ workspaceId: 'ws-1', metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'attacker', sessionId: 'spoofed' } } }, actor);
    expect(input).toMatchObject({ metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'client-1', sessionId: 'session-a', workspaceId: 'ws-1' } } });
  });
});
