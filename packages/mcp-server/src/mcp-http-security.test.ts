import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MCP_HTTP_BODY_BYTES, startMcpHttp, type McpHttpServerHandle } from './http.js';

describe('MCP localhost HTTP security boundary', () => {
  let handle: McpHttpServerHandle;

  beforeEach(async () => {
    handle = await startMcpHttp({
      port: 0,
      maxBodyBytes: 128,
      services: {},
      actor: { clientId: 'http-security-test', clientName: 'http-security-test' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('allows local origins and denies an untrusted origin', async () => {
    const allowed = await fetch(handle.endpoint, { headers: { Origin: `http://localhost:${handle.address.port}` } });
    const denied = await fetch(handle.endpoint, { headers: { Origin: 'http://evil.example' } });

    expect(allowed.status).not.toBe(403);
    expect(denied.status).toBe(403);
  });

  it('rejects bodies over the configured limit', async () => {
    const response = await fetch(handle.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ payload: 'x'.repeat(MAX_MCP_HTTP_BODY_BYTES) }),
    });

    expect(response.status).toBe(413);
  });

  it('lets the SDK reject malformed and header/body-mismatched modern requests', async () => {
    const malformed = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        Origin: 'http://localhost',
      },
      body: '{not-json',
    });
    const mismatch = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'security-test', version: '0.1.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });

    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(mismatch.status).toBeGreaterThanOrEqual(400);
  });
});

describe('MCP configured HTTP boundary', () => {
  it('requires a bearer token for a non-loopback bind', async () => {
    const handle = await startMcpHttp({
      host: '0.0.0.0',
      port: 0,
      authToken: 'test-token',
      allowedHostnames: ['127.0.0.1'],
      services: {},
      actor: { clientId: 'http-auth-test', clientName: 'http-auth-test' },
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${handle.address.port}/mcp`, { method: 'GET' });
      const wrong = await fetch(`http://127.0.0.1:${handle.address.port}/mcp`, { headers: { Authorization: 'Bearer wrong' } });
      const correct = await fetch(`http://127.0.0.1:${handle.address.port}/mcp`, { headers: { Authorization: 'Bearer test-token' } });
      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(correct.status).not.toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('rejects a host that is not explicitly allowed', async () => {
    const handle = await startMcpHttp({
      host: '127.0.0.1',
      port: 0,
      allowedHostnames: ['localhost'],
      services: {},
      actor: { clientId: 'http-host-test', clientName: 'http-host-test' },
    });
    try {
      const rejected = await fetch(`http://127.0.0.1:${handle.address.port}/mcp`, { headers: { Host: `evil.example:${handle.address.port}` } });
      expect(rejected.status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});
