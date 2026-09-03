import type { Result } from '@baitonghub-linux-mcp/domain';

export const capabilityToolNames = Object.freeze([
  'shell',
  'dom_cdp',
  'accessibility',
  'input_event',
  'vision',
  'window',
  'health',
  'system_info',
  'journal',
  'service_logs',
  'network',
  'service',
  'package',
  'schedule',
  'notification',
  'file_dialog',
  'clipboard',
  'web_fetch',
  'container',
  'archive',
  'dependency_audit',
  'remote_host',
  'artifact_verify',
  'http_probe',
  'storage_usage',
  'backup',
] as const);

export type CapabilityToolName = (typeof capabilityToolNames)[number];

export interface CapabilityService {
  listTools?(): readonly CapabilityToolName[];
  execute(tool: CapabilityToolName, input: unknown, signal?: AbortSignal): Promise<Result<unknown>>;
}
