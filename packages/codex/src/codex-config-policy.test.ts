import { describe, expect, it } from 'vitest';
import { disabledMcpConfig, readCodexConfigProjection, verifyCodexConfig } from './codex-config-policy.js';

const verified = {
  config: {
    mcp_servers: { alpha: { enabled: false }, 'quote"key': { enabled: false } },
    features: { hooks: false, plugins: false, multi_agent: false, apps: false },
    apps: { _default: { enabled: false } }, approval_policy: 'never', web_search: 'disabled',
    model_provider: 'openai', sandbox_mode: 'read-only',
    sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
  },
};

describe('Codex config policy', () => {
  it('projects and verifies a bounded fully isolated config', () => {
    const result = readCodexConfigProjection(verified);
    expect(result.ok).toBe(true);
    if (result.ok) expect(verifyCodexConfig(result.value, ['quote"key', 'alpha'], 'read-only')).toEqual({ ok: true, value: undefined });
  });

  it('treats absent enablement as enabled and absent apps default as enabled', () => {
    const result = readCodexConfigProjection({ config: { mcp_servers: { extra: {} } } });
    expect(result).toMatchObject({ ok: true, value: { mcpServerIds: ['extra'], enabledMcpServerIds: ['extra'], appsDefaultEnabled: true } });
    if (result.ok) expect(verifyCodexConfig(result.value, [], 'read-only').ok).toBe(false);
  });

  it('builds stable quoted disable overrides', () => {
    expect(disabledMcpConfig(['z', 'a"b'])).toEqual({ ok: true, value: ['mcp_servers={"a\\"b"={enabled=false},"z"={enabled=false}}'] });
    expect(disabledMcpConfig(['x', 'x']).ok).toBe(false);
  });

  it('rejects malformed payloads, invalid enabled types, and bounds', () => {
    const bad = [null, [], { config: [] }, { mcp_servers: [] }, { config: { mcp_servers: { x: { enabled: 'false' } } } },
      { config: { mcp_servers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, {}])) } },
      { config: { mcp_servers: { ['x'.repeat(129)]: {} } } }, { config: { features: { hooks: 'false' } } },
      { config: { apps: { _default: { enabled: 0 } } } }, { config: { huge: 'x'.repeat(1024 * 1024) } }];
    for (const value of bad) {
      const result = readCodexConfigProjection(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ code: 'CODEX_NOT_AVAILABLE', message: 'Codex effective configuration is invalid or unavailable', recoverable: true });
    }
  });

  it('rejects newly added servers and any missing or weakened safety control', () => {
    const parsed = readCodexConfigProjection(verified);
    if (!parsed.ok) throw new Error('fixture rejected');
    expect(verifyCodexConfig(parsed.value, ['alpha'], 'read-only').ok).toBe(false);
    expect(verifyCodexConfig({ ...parsed.value, hooks: null }, ['alpha', 'quote"key'], 'read-only').ok).toBe(false);
    expect(verifyCodexConfig({ ...parsed.value, sandboxMode: null }, ['alpha', 'quote"key'], 'read-only').ok).toBe(false);
    expect(verifyCodexConfig({ ...parsed.value, notifyEnabled: true }, ['alpha', 'quote"key'], 'read-only').ok).toBe(false);
    expect(verifyCodexConfig({ ...parsed.value, mcpServerIds: undefined } as never, ['alpha', 'quote"key'], 'read-only').ok).toBe(false);
    expect(verifyCodexConfig({ ...parsed.value, enabledMcpServerIds: null } as never, ['alpha', 'quote"key'], 'read-only').ok).toBe(false);
    expect(verifyCodexConfig(parsed.value, ['alpha', 'quote"key'], 'workspace-write').ok).toBe(false);
    for (const fields of [{ model_providers: { openai: {} } }, { chatgpt_base_url: 'https://example.invalid' }, { sandbox_workspace_write: { writable_roots: ['/outside'] } }]) {
      const unsafe = readCodexConfigProjection({ config: { ...verified.config, ...fields } });
      expect(unsafe.ok).toBe(true);
      if (unsafe.ok) expect(verifyCodexConfig(unsafe.value, ['alpha', 'quote"key'], 'read-only').ok).toBe(false);
    }
  });
});
