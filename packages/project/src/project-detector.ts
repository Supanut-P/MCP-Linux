import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { PackageManager, ProjectFramework, ProjectProfile } from './project-profile.js';

export interface ProjectFileSystem {
  readFile(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
}

class NodeProjectFileSystem implements ProjectFileSystem {
  public readFile(filePath: string): Promise<string> {
    return readFile(filePath, 'utf8');
  }

  public async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

const LOCKFILE_PRECEDENCE: readonly [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

const CONFIG_FILE_NAMES = [
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vitest.config.ts',
  'vitest.config.js',
  'eslint.config.js',
  'eslint.config.mjs',
  'webpack.config.js',
  'next.config.js',
  'next.config.mjs',
  'biome.json',
];

export class ProjectDetector {
  public constructor(private readonly fileSystem: ProjectFileSystem = new NodeProjectFileSystem()) {}

  public async detect(rootPath: string): Promise<Result<ProjectProfile>> {
    const packageJsonPath = path.join(rootPath, 'package.json');
    if (!(await this.fileSystem.exists(packageJsonPath))) {
      return ok({
        rootPath,
        kind: 'unknown',
        packageManager: 'unknown',
        frameworks: [],
        scripts: {},
        configFiles: await this.findConfigFiles(rootPath),
      });
    }

    let packageJson: unknown;
    try {
      packageJson = JSON.parse(await this.fileSystem.readFile(packageJsonPath)) as unknown;
    } catch {
      return err(appError('INVALID_INPUT', 'package.json is not valid JSON'));
    }
    if (!this.isPackageJson(packageJson)) {
      return err(appError('INVALID_INPUT', 'package.json has an invalid shape'));
    }

    return ok({
      rootPath,
      kind: 'node',
      packageManager: await this.detectPackageManager(rootPath),
      frameworks: await this.detectFrameworks(rootPath, packageJson),
      scripts: packageJson.scripts ?? {},
      configFiles: await this.findConfigFiles(rootPath),
    });
  }

  private async detectPackageManager(rootPath: string): Promise<PackageManager> {
    for (const [filename, manager] of LOCKFILE_PRECEDENCE) {
      if (await this.fileSystem.exists(path.join(rootPath, filename))) return manager;
    }
    return 'npm';
  }

  private async detectFrameworks(rootPath: string, packageJson: PackageJson): Promise<ProjectFramework[]> {
    const dependencyNames = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
    ]);
    const frameworks = new Set<ProjectFramework>();
    if (dependencyNames.has('react') || dependencyNames.has('react-dom')) frameworks.add('react');
    if (dependencyNames.has('typescript') || await this.fileSystem.exists(path.join(rootPath, 'tsconfig.json'))) frameworks.add('typescript');
    if (dependencyNames.has('vite') || (await this.fileSystem.exists(path.join(rootPath, 'vite.config.ts')))) frameworks.add('vite');
    return [...frameworks].sort();
  }

  private async findConfigFiles(rootPath: string): Promise<string[]> {
    const existing = await Promise.all(CONFIG_FILE_NAMES.map(async (filename) => (
      await this.fileSystem.exists(path.join(rootPath, filename)) ? filename : null
    )));
    return existing.flatMap((filename) => filename === null ? [] : [filename]).sort();
  }

  private isPackageJson(value: unknown): value is PackageJson {
    if (typeof value !== 'object' || value === null) return false;
    if ('scripts' in value && !this.isStringRecordOrUndefined(value.scripts)) return false;
    return this.isStringRecordOrUndefined('dependencies' in value ? value.dependencies : undefined)
      && this.isStringRecordOrUndefined('devDependencies' in value ? value.devDependencies : undefined)
      && this.isStringRecordOrUndefined('peerDependencies' in value ? value.peerDependencies : undefined);
  }

  private isStringRecordOrUndefined(value: unknown): value is Record<string, string> | undefined {
    if (value === undefined) return true;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.values(value).every((entry) => typeof entry === 'string');
  }
}

interface PackageJson {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}
