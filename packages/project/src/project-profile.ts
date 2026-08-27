export type ProjectKind = 'node' | 'unknown';
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';
export type ProjectFramework = 'react' | 'typescript' | 'vite';
export type ProjectCommandKind = 'dev' | 'test' | 'lint' | 'typecheck' | 'build';

export interface ProjectProfile {
  readonly rootPath: string;
  readonly kind: ProjectKind;
  readonly packageManager: PackageManager;
  readonly frameworks: readonly ProjectFramework[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly configFiles: readonly string[];
}
