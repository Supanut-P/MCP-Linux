import { describe, expect, it } from 'vitest';
import { ToolSchemaRegistry } from './tool-schema-registry.js';

describe('ToolSchemaRegistry', () => {
  it('tracks versioned risk, streaming, and parallel metadata', () => {
    const registry = new ToolSchemaRegistry();
    registry.register({ name: 'read_file_page', description: 'page', permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: {} as never, parse: () => ({ ok: true, value: {} }), execute: async () => ({ ok: true, value: {} }) });
    registry.register({ name: 'delete_file', description: 'delete', permission: 'DANGEROUS', annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: {} as never, parse: () => ({ ok: true, value: {} }), execute: async () => ({ ok: true, value: {} }) });
    expect(registry.describe('read_file_page')).toMatchObject({ streamingSupport: true, parallelSafe: true });
    expect(registry.describe('delete_file')).toMatchObject({ riskClass: 'DANGEROUS', parallelSafe: false });
  });
});
