import type { PermissionProfile, PermissionProfileName } from './types.js';

const PROJECT_EXECUTABLES = Object.freeze([
  'bun',
  'corepack',
  'git',
  'node',
  'npm',
  'npx',
  'pnpm',
  'rg',
  'yarn',
]);

export const permissionProfiles: Readonly<Record<PermissionProfileName, PermissionProfile>> = Object.freeze({
  safe: Object.freeze({
    name: 'safe',
    defaults: Object.freeze({ READ: 'ALLOW', WRITE: 'ASK', EXECUTE: 'ASK', DANGEROUS: 'DENY' }),
    allowedProjectExecutables: PROJECT_EXECUTABLES,
  }),
  balanced: Object.freeze({
    name: 'balanced',
    defaults: Object.freeze({ READ: 'ALLOW', WRITE: 'ALLOW', EXECUTE: 'ALLOW', DANGEROUS: 'ASK' }),
    allowedProjectExecutables: PROJECT_EXECUTABLES,
  }),
  full: Object.freeze({
    name: 'full',
    defaults: Object.freeze({ READ: 'ALLOW', WRITE: 'ALLOW', EXECUTE: 'ALLOW', DANGEROUS: 'ALLOW' }),
    allowedProjectExecutables: PROJECT_EXECUTABLES,
  }),
  custom: Object.freeze({
    name: 'custom',
    defaults: Object.freeze({ READ: 'ALLOW', WRITE: 'ASK', EXECUTE: 'ASK', DANGEROUS: 'DENY' }),
    allowedProjectExecutables: PROJECT_EXECUTABLES,
  }),
});
