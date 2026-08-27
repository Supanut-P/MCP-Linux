import { describe, expect, it } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry } from '../tool-registry.js';
import type { ExtensionsService } from '@baitonghub-linux-mcp/extensions';

describe('skills and mcp bridge tools', () => {
  it('registers full-access meta-tools and dispatches to ExtensionsService', async () => {
    const extensions: ExtensionsService = {
      listSkills: async () => ok({ skills: [{ id: 'a/b', name: 'b', description: 'd', source: 'a', rootPath: '/', skillPath: '/SKILL.md' }] }),
      readSkill: async () => ok({ id: 'a/b', name: 'b', description: 'd', source: 'a', path: '/SKILL.md', content: '# b' }),
      listMcpServers: async () => ok({ servers: [{ name: 'mock', source: 'test', enabled: true, connected: false, excluded: false, command: 'node' }] }),
      describeMcpServer: async () => ok({ server: 'mock', enabled: true, connected: true, tools: [{ name: 'ping', description: 'Ping' }] }),
      callMcpTool: async () => ok({ content: [{ type: 'text', text: 'pong' }] }),
      close: async () => undefined,
    };
    const registry = new ToolRegistry({ extensions }, { clientId: 'test', clientName: 'test' });
    const names = registry.list().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['skills_list', 'skills_read', 'mcp_list', 'mcp_describe', 'mcp_call']));
    for (const name of ['skills_list', 'skills_read', 'mcp_list', 'mcp_describe', 'mcp_call']) {
      const tool = registry.list().find((entry) => entry.name === name);
      expect(tool?.permission).toBe('DANGEROUS');
      expect(tool?.annotations.readOnlyHint).toBe(false);
    }

    await expect(registry.invoke('skills_list', {})).resolves.toMatchObject({
      structuredContent: { skills: [expect.objectContaining({ id: 'a/b' })] },
    });
    await expect(registry.invoke('mcp_call', { server: 'mock', tool: 'ping', arguments: {}, userConfirmed: true })).resolves.toMatchObject({
      structuredContent: { content: [{ type: 'text', text: 'pong' }] },
    });
  });

  it('forwards the caller AbortSignal through mcp_describe and mcp_call', async () => {
    const observed: AbortSignal[] = [];
    const extensions: ExtensionsService = {
      listSkills: async () => ok({ skills: [] }),
      readSkill: async () => ok({ id: 'a/b', name: 'b', description: '', source: 'a', path: '/SKILL.md', content: '' }),
      listMcpServers: async () => ok({ servers: [] }),
      describeMcpServer: async (_input, signal) => {
        if (signal !== undefined) observed.push(signal);
        return ok({ server: 'mock', enabled: true, connected: true, tools: [] });
      },
      callMcpTool: async (_input, signal) => {
        if (signal !== undefined) observed.push(signal);
        return ok({ content: [] });
      },
      close: async () => undefined,
    };
    const registry = new ToolRegistry({ extensions }, { clientId: 'test', clientName: 'test' });
    const controller = new AbortController();

    await expect(registry.invoke('mcp_describe', { server: 'mock' }, undefined, controller.signal))
      .resolves.toMatchObject({ structuredContent: { server: 'mock', connected: true } });
    await expect(registry.invoke('mcp_call', { server: 'mock', tool: 'ping', arguments: {}, userConfirmed: true }, undefined, controller.signal))
      .resolves.toMatchObject({ structuredContent: { content: [] } });

    expect(observed).toHaveLength(2);
    for (const signal of observed) expect(signal).toBeInstanceOf(AbortSignal);
  });
});
