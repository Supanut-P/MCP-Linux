import type { McpPermissionLevel, McpToolDefinition } from './tools/tool-types.js';

export interface ToolSchemaMetadata {
  readonly id: string;
  readonly version: string;
  readonly inputSchema: unknown;
  readonly outputSchema: 'structured-result';
  readonly permissions: readonly McpPermissionLevel[];
  readonly riskClass: McpPermissionLevel;
  readonly streamingSupport: boolean;
  readonly parallelSafe: boolean;
  readonly pluginOwner: string;
}

export class ToolSchemaRegistry {
  private readonly schemas = new Map<string, ToolSchemaMetadata>();

  public register(tool: McpToolDefinition, options: { readonly version?: string; readonly pluginOwner?: string } = {}): void {
    this.schemas.set(tool.name, {
      id: tool.name,
      version: options.version ?? '1.0.0',
      inputSchema: tool.inputSchema,
      outputSchema: 'structured-result',
      permissions: [tool.permission],
      riskClass: tool.permission,
      streamingSupport: /(?:page|context|map|stream|logs)/i.test(tool.name),
      parallelSafe: tool.permission === 'READ' && tool.annotations.readOnlyHint && !tool.annotations.destructiveHint,
      pluginOwner: options.pluginOwner ?? 'core',
    });
  }

  public list(): readonly ToolSchemaMetadata[] {
    return [...this.schemas.values()];
  }

  public describe(name: string): ToolSchemaMetadata | undefined {
    return this.schemas.get(name);
  }

  public search(query: string): readonly ToolSchemaMetadata[] {
    const normalized = query.trim().toLowerCase();
    return this.list().filter((schema) => normalized.length === 0 || schema.id.toLowerCase().includes(normalized) || schema.pluginOwner.toLowerCase().includes(normalized));
  }
}
