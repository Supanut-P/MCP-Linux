import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectDetector } from './project-detector.js';

const temporaryRoots: string[] = [];
const fixtureRoot = fileURLToPath(new URL('../../../tests/fixtures/node-vite', import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProjectDetector', () => {
  it('detects a Vite React project and uses pnpm lock precedence', async () => {
    const result = await new ProjectDetector().detect(fixtureRoot);

    expect(result).toEqual({
      ok: true,
      value: {
        rootPath: fixtureRoot,
        kind: 'node',
        packageManager: 'pnpm',
        frameworks: ['react', 'typescript', 'vite'],
        scripts: {
          dev: 'vite',
          test: 'vitest run',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          build: 'vite build',
        },
        configFiles: ['tsconfig.json', 'vite.config.ts'],
      },
    });
  });

  it('prefers npm when only package-lock is present and does not execute package code', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-project-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }), 'utf8');
    await writeFile(path.join(root, 'package-lock.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'test.js'), 'throw new Error("must not execute");', 'utf8');

    const result = await new ProjectDetector().detect(root);

    expect(result).toMatchObject({ ok: true, value: { kind: 'node', packageManager: 'npm', scripts: { test: 'node test.js' } } });
  });

  it('detects a Node project with no scripts without inventing commands', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-project-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'no-scripts' }), 'utf8');

    const result = await new ProjectDetector().detect(root);

    expect(result).toMatchObject({ ok: true, value: { kind: 'node', scripts: {}, packageManager: 'npm' } });
  });
});
