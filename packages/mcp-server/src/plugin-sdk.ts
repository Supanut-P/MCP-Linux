import type { McpToolDefinition } from './tools/tool-types.js';

export interface BaitonghubLinuxMcpPluginPermission {
  readonly name: string;
  readonly reason: string;
}

export interface BaitonghubLinuxMcpSkillDescriptor {
  readonly id: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface BaitonghubLinuxMcpRecipeDescriptor {
  readonly name: string;
  readonly steps: readonly string[];
}

export interface BaitonghubLinuxMcpPlugin {
  readonly id: string;
  readonly version: string;
  readonly tools?: readonly McpToolDefinition[];
  readonly hooks?: readonly string[];
  readonly skills?: readonly BaitonghubLinuxMcpSkillDescriptor[];
  readonly recipes?: readonly BaitonghubLinuxMcpRecipeDescriptor[];
  readonly requiredPermissions?: readonly BaitonghubLinuxMcpPluginPermission[];
}
