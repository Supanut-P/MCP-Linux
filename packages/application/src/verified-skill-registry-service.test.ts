import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Workspace, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { ContextSource } from './context-file-reader.js';
import { FileService, type FileActor } from './file-service.js';
import { VerifiedSkillRegistryService } from './verified-skill-registry-service.js';

const roots: string[] = [];
const actor: FileActor = { clientId: 'test', clientName: 'test' };
const docs = ['mcp-linux-development', 'mcp-linux-incident', 'mcp-linux-release'] as const;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; workspace: Workspace; workspaces: WorkspaceRepository; fileService: FileService; service: VerifiedSkillRegistryService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verified-skills-'));
  roots.push(root);
  for (const id of docs) {
    const target = path.join(root, 'docs', 'skills', id);
    await mkdir(target, { recursive: true });
    await copyFile(path.join(repoRoot, 'docs', 'skills', id, 'SKILL.md'), path.join(target, 'SKILL.md'));
  }
  await copyFile(path.join(repoRoot, 'LICENSE'), path.join(root, 'LICENSE'));
  const canonical = await realpath(root);
  const workspace: Workspace = { id: 'registered', displayName: 'fixture', rootPath: root, realRootPath: canonical, createdAt: new Date(0).toISOString() };
  const workspaces: WorkspaceRepository = {
    async list() { return [workspace]; }, async get(id) { return id === workspace.id ? workspace : null; },
    async insert() {}, async delete() {},
  };
  const fileService = new FileService(workspaces);
  return { root, workspace, workspaces, fileService, service: new VerifiedSkillRegistryService({ workspaces, files: fileService }) };
}

describe('VerifiedSkillRegistryService', () => {
  it('lists only role-matching static metadata without reading document bodies', async () => {
    const { service, fileService, workspace } = await fixture();
    const read = vi.spyOn(fileService, 'readContextFile');
    await expect(service.list(actor, { workspaceId: workspace.id, role: 'worker' })).resolves.toMatchObject({
      ok: true, value: { verification: 'not_checked', skills: [{ id: 'mcp-linux-development' }, { id: 'mcp-linux-incident' }] },
    });
    await expect(service.list(actor, { workspaceId: workspace.id, role: 'qa', query: 'release' })).resolves.toMatchObject({
      ok: true, value: { skills: [{ id: 'mcp-linux-release' }] },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('loads all three exact reviewed documents through the bounded reader and never adjacent scripts', async () => {
    const { root, service, fileService, workspace } = await fixture();
    await writeFile(path.join(root, 'docs', 'skills', docs[0], 'unreviewed-hook.js'), 'throw new Error("UNREVIEWED_HOOK_CANARY");');
    const read = vi.spyOn(fileService, 'readContextFile');
    for (const id of docs) {
      const role = id === 'mcp-linux-release' ? 'qa' : 'worker';
      const result = await service.load(actor, { workspaceId: workspace.id, skillId: id, role });
      expect(result).toMatchObject({ ok: true, value: { id, verification: 'verified', permissionsGranted: false, scriptsLoaded: false, hooksLoaded: false, reviewScope: 'single_document' } });
    }
    expect(read.mock.calls.map((call) => call[2].path)).toEqual(docs.flatMap((id) => [`docs/skills/${id}/SKILL.md`, 'LICENSE']));
  });

  it('rejects unknown ids, wrong roles, unregistered workspaces and invalid bounded inputs', async () => {
    const { service, workspace } = await fixture();
    await expect(service.load(actor, { workspaceId: workspace.id, skillId: 'forged', role: 'lead' })).resolves.toMatchObject({ ok: false });
    await expect(service.load(actor, { workspaceId: workspace.id, skillId: 'mcp-linux-release', role: 'worker' })).resolves.toMatchObject({ ok: false });
    await expect(service.list(actor, { workspaceId: 'missing', role: 'lead' })).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    await expect(service.list(actor, { workspaceId: 'x'.repeat(129), role: 'lead' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.list(actor, { workspaceId: workspace.id, role: 'lead', query: 'x'.repeat(1025) })).resolves.toMatchObject({ ok: false });
  });

  it('rejects stale skill or license bytes and root identity disagreement', async () => {
    const { root, service, workspace } = await fixture();
    const skillPath = path.join(root, 'docs', 'skills', docs[0], 'SKILL.md');
    const original = await readFile(skillPath);
    await writeFile(skillPath, Buffer.concat([original, Buffer.from('\nchanged\n')]));
    await expect(service.load(actor, { workspaceId: workspace.id, skillId: docs[0], role: 'worker' })).resolves.toMatchObject({ ok: false });
    await writeFile(skillPath, original);
    await writeFile(path.join(root, 'LICENSE'), 'changed license');
    await expect(service.load(actor, { workspaceId: workspace.id, skillId: docs[0], role: 'worker' })).resolves.toMatchObject({ ok: false });

    const clean = await fixture();
    const originalReader = clean.fileService.readContextFile.bind(clean.fileService);
    const files = { readContextFile: vi.fn(async (...args: Parameters<typeof originalReader>) => {
      const result = await originalReader(...args);
      if (result.ok && result.value.status === 'available' && args[2].path === 'LICENSE') {
        return { ok: true as const, value: { ...result.value, rootFingerprint: 'different-root' } };
      }
      return result;
    }) };
    const mismatched = new VerifiedSkillRegistryService({ workspaces: clean.workspaces, files });
    await expect(mismatched.load(actor, { workspaceId: clean.workspace.id, skillId: docs[0], role: 'worker' })).resolves.toMatchObject({ ok: false });
  });

  it('fails closed on denied, unavailable, oversized, binary, invalid UTF-8 and cancelled reads', async () => {
    const { service, workspaces, workspace } = await fixture();
    for (const fake of [
      async (): Promise<never> => ({ ok: false as const, error: { code: 'PERMISSION_DENIED', message: 'denied' } } as never),
      async (): Promise<never> => ({ ok: true as const, value: { status: 'unavailable' as const, path: 'x', reason: 'too_large' as const } } as never),
    ]) {
      const injected = new VerifiedSkillRegistryService({ workspaces, files: { readContextFile: fake as never } });
      await expect(injected.load(actor, { workspaceId: workspace.id, skillId: docs[0], role: 'worker' })).resolves.toMatchObject({ ok: false });
    }
    const unavailable = (reason: 'too_large' | 'binary' | 'invalid_utf8'): ContextSource => ({ status: 'unavailable', path: 'x', reason, rootFingerprint: 'fixture-root' });
    for (const reason of ['too_large', 'binary', 'invalid_utf8'] as const) {
      const files = { readContextFile: vi.fn(async () => ({ ok: true as const, value: unavailable(reason) })) };
      const injected = new VerifiedSkillRegistryService({ workspaces, files: files as never });
      await expect(injected.load(actor, { workspaceId: workspace.id, skillId: docs[0], role: 'worker' })).resolves.toMatchObject({ ok: false });
    }
    const controller = new AbortController(); controller.abort();
    await expect(service.load(actor, { workspaceId: workspace.id, skillId: docs[0], role: 'worker' }, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(createHash('sha256').update(await readFile(path.join(workspace.rootPath, 'LICENSE'))).digest('hex')).toHaveLength(64);
  });
});
