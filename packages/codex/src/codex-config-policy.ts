import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';

export const CODEX_FIXED_CONFIG = [
  'approval_policy="never"',
  'features.plugins=false',
  'features.hooks=false',
  'features.multi_agent=false',
  'features.apps=false',
  'apps._default.enabled=false',
  'web_search="disabled"',
  'model_provider="openai"',
  'sandbox_workspace_write.writable_roots=[]',
  'sandbox_workspace_write.network_access=false',
  'sandbox_workspace_write.exclude_tmpdir_env_var=true',
  'sandbox_workspace_write.exclude_slash_tmp=true',
  'notify=[]',
] as const;

export function codexRoleConfig(sandbox: 'read-only' | 'workspace-write'): readonly string[] {
  return [...CODEX_FIXED_CONFIG, `sandbox_mode=${JSON.stringify(sandbox)}`];
}

export interface CodexConfigProjection {
  readonly customProvider: boolean;
  readonly customEndpoint: boolean;
  readonly workspaceWriteRestricted: boolean;
  readonly mcpServerIds: readonly string[];
  readonly enabledMcpServerIds: readonly string[];
  readonly hooks: boolean | null;
  readonly plugins: boolean | null;
  readonly multiAgent: boolean | null;
  readonly apps: boolean | null;
  readonly appsDefaultEnabled: boolean;
  readonly approvalPolicy: string | null;
  readonly webSearch: string | null;
  readonly modelProvider: string | null;
  readonly sandboxMode: string | null;
  readonly notifyEnabled: boolean;
}

const unavailable = (): Result<never> => err(appError('CODEX_NOT_AVAILABLE', 'Codex effective configuration is invalid or unavailable', true));
const plainRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
});
const boundedName = (value: string): boolean => value.length > 0 && !hasControlCharacter(value) && new TextEncoder().encode(value).byteLength <= 128;
const nullableString = (value: unknown): string | null => typeof value === 'string' && value.length <= 128 && !hasControlCharacter(value) ? value : null;
const nullableBoolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;

export function readCodexConfigProjection(input: unknown): Result<CodexConfigProjection> {
  try {
    if (!plainRecord(input)) return unavailable();
    const size = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    if (size > 1024 * 1024) return unavailable();
    const config = 'config' in input ? input.config : input;
    if (!plainRecord(config)) return unavailable();
    const providers = config.model_providers === undefined || config.model_providers === null ? {} : config.model_providers;
    if (!plainRecord(providers)) return unavailable();
    const endpoints = ['chatgpt_base_url', 'openai_base_url', 'api_base_url'];
    const customEndpoint = endpoints.some((key) => config[key] !== undefined && config[key] !== null);
    const write = config.sandbox_workspace_write;
    const workspaceWriteRestricted = plainRecord(write) && Array.isArray(write.writable_roots) && write.writable_roots.length === 0 && write.network_access === false && write.exclude_tmpdir_env_var === true && write.exclude_slash_tmp === true;
    const servers = config.mcp_servers === undefined ? {} : config.mcp_servers;
    if (!plainRecord(servers) || Object.keys(servers).length > 64) return unavailable();
    const ids = Object.keys(servers);
    if (!ids.every(boundedName)) return unavailable();
    const enabled: string[] = [];
    for (const id of ids) {
      const server = servers[id];
      if (!plainRecord(server)) return unavailable();
      if (server.enabled !== undefined && typeof server.enabled !== 'boolean') return unavailable();
      if (server.enabled !== false) enabled.push(id);
    }
    const features = config.features === undefined ? {} : config.features;
    const apps = config.apps === undefined ? {} : config.apps;
    const notify = config.notify === undefined ? [] : config.notify;
    if (!plainRecord(features) || !plainRecord(apps) || !Array.isArray(notify) || notify.length > 64 || !notify.every((entry) => typeof entry === 'string' && entry.length <= 128)) return unavailable();
    const defaultApp = apps._default === undefined ? {} : apps._default;
    if (!plainRecord(defaultApp) || (defaultApp.enabled !== undefined && typeof defaultApp.enabled !== 'boolean')) return unavailable();
    const sandbox = nullableString(config.sandbox_mode);
    if (config.sandbox_mode !== undefined && sandbox === null) return unavailable();
    for (const key of ['approval_policy', 'web_search', 'model_provider'] as const) {
      if (config[key] !== undefined && nullableString(config[key]) === null) return unavailable();
    }
    for (const key of ['hooks', 'plugins', 'multi_agent', 'apps'] as const) {
      if (features[key] !== undefined && typeof features[key] !== 'boolean') return unavailable();
    }
    return ok({
      customProvider: Object.keys(providers).length > 0, customEndpoint, workspaceWriteRestricted,
      mcpServerIds: ids.sort(), enabledMcpServerIds: enabled.sort(),
      hooks: nullableBoolean(features.hooks), plugins: nullableBoolean(features.plugins),
      multiAgent: nullableBoolean(features.multi_agent), apps: nullableBoolean(features.apps),
      appsDefaultEnabled: defaultApp.enabled !== false,
      approvalPolicy: config.approval_policy === undefined ? null : config.approval_policy as string,
      webSearch: config.web_search === undefined ? null : config.web_search as string,
      modelProvider: config.model_provider === undefined ? null : config.model_provider as string,
      sandboxMode: sandbox,
      notifyEnabled: notify.length > 0,
    });
  } catch {
    return unavailable();
  }
}

export function disabledMcpConfig(ids: readonly string[]): Result<readonly string[]> {
  if (!Array.isArray(ids) || ids.length > 64 || !ids.every((id) => typeof id === 'string' && boundedName(id)) || new Set(ids).size !== ids.length) return unavailable();
  // CLI dotted-key parsing does not preserve quoted path components. Inline
  // TOML table keys preserve arbitrary registered IDs while merging disables.
  return ok(ids.length === 0 ? [] : [`mcp_servers={${[...ids].sort().map((id) => `${JSON.stringify(id)}={enabled=false}`).join(',')}}`]);
}

export function verifyCodexConfig(projection: CodexConfigProjection, expectedIds: readonly string[], sandboxMode: 'read-only' | 'workspace-write'): Result<void> {
  if (!plainRecord(projection) || !Array.isArray(projection.mcpServerIds) || !Array.isArray(projection.enabledMcpServerIds) ||
      !projection.mcpServerIds.every((id) => typeof id === 'string' && boundedName(id)) ||
      !projection.enabledMcpServerIds.every((id) => typeof id === 'string' && boundedName(id)) ||
      !Array.isArray(expectedIds) || expectedIds.length > 64 || !expectedIds.every((id) => typeof id === 'string' && boundedName(id)) || new Set(expectedIds).size !== expectedIds.length) return unavailable();
  const expected = [...expectedIds].sort();
  if (projection.customProvider !== false || projection.customEndpoint !== false || projection.workspaceWriteRestricted !== true) return unavailable();
  if (projection.mcpServerIds.length !== expected.length || projection.mcpServerIds.some((id, index) => id !== expected[index]) || projection.enabledMcpServerIds.length !== 0) return unavailable();
  if (projection.hooks !== false || projection.plugins !== false || projection.multiAgent !== false || projection.apps !== false || projection.appsDefaultEnabled !== false || projection.approvalPolicy !== 'never' || projection.webSearch !== 'disabled' || projection.modelProvider !== 'openai' || projection.sandboxMode !== sandboxMode || projection.notifyEnabled !== false) return unavailable();
  return ok(undefined);
}
