import { z } from 'zod';
import type { McpToolDefinition } from './tools/tool-types.js';

export interface StableToolContractEntry {
  readonly name: string;
  readonly permission: string;
  readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean };
  readonly inputSchema: unknown;
}

/** Canonical v1 input contract. Descriptions are intentionally non-contractual. */
export function canonicalizeToolSchemas(tools: readonly McpToolDefinition[]): readonly StableToolContractEntry[] {
  return tools
    .map((tool) => ({
      name: tool.name,
      permission: tool.permission,
      annotations: tool.annotations,
      inputSchema: canonicalize(z.toJSONSchema(tool.inputSchema, { target: 'draft-7' })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
}
