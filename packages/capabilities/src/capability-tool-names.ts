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
  'network',
  'service',
  'package',
  'schedule',
  'notification',
  'file_dialog',
  'clipboard',
  'web_fetch',
] as const);

export type CapabilityToolName = (typeof capabilityToolNames)[number];

export interface CapabilityService {
  listTools?(): readonly CapabilityToolName[];
  execute(tool: CapabilityToolName, input: unknown, signal?: AbortSignal): Promise<Result<unknown>>;
}
