import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import { CodexConfigInspector } from './codex-config-inspector.js';

function config(enabled: boolean, version = 'v1', extra = false): unknown {
  return {
    config: {
      mcp_servers: { canary: { enabled }, ...(extra ? { added: { enabled: false } } : {}) },
      features: { hooks: false, plugins: false, apps: false, multi_agent: false },
      apps: { _default: { enabled: false } }, approval_policy: 'never',
      model_provider: 'openai', web_search: 'disabled', sandbox_mode: 'read-only', notify: [],
      sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
    },
    layers: [{ name: { type: 'system', file: 'fixture' }, version }, { name: { type: 'sessionFlags' }, version: enabled ? 'before' : 'after' }],
  };
}

describe('CodexConfigInspector', () => {
  it('inventories then verifies explicit disable overrides with one sanitized environment snapshot', async () => {
    const calls: { overrides: readonly string[]; environment: NodeJS.ProcessEnv }[] = [];
    const inspector = new CodexConfigInspector({ read: async (_exe, _cwd, overrides, environment): Promise<Result<unknown>> => {
      calls.push({ overrides, environment });
      return ok(config(calls.length === 1));
    } });
    await expect(inspector.verify('codex', 'workspace', 'read-only', undefined, { HOME: '/operator', API_KEY: 'secret-canary' })).resolves.toMatchObject({ ok: true, value: { disabledServerIds: ['canary'] } });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.overrides).toContain('mcp_servers={"canary"={enabled=false}}');
    expect(calls[0]?.environment).toBe(calls[1]?.environment);
    expect(calls[0]?.environment).toEqual({ HOME: '/operator' });
  });

  it.each(['changed', 'added', 'enabled', 'missing-layers'])('fails closed on %s configuration', async (mode) => {
    let calls = 0;
    const inspector = new CodexConfigInspector({ read: async (): Promise<Result<unknown>> => {
      calls++;
      if (calls === 1) return ok(config(true));
      if (mode === 'missing-layers') return ok({ config: {} });
      return ok(config(mode === 'enabled', mode === 'changed' ? 'v2' : 'v1', mode === 'added'));
    } });
    await expect(inspector.verify('codex', 'workspace', 'read-only')).resolves.toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE' } });
  });

  it('does not run a second probe when cancelled during the first', async () => {
    const controller = new AbortController();
    let calls = 0;
    const inspector = new CodexConfigInspector({ read: async (): Promise<Result<unknown>> => { calls++; controller.abort(); return ok(config(true)); } });
    await expect(inspector.verify('codex', 'workspace', 'read-only', controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(calls).toBe(1);
  });
});
