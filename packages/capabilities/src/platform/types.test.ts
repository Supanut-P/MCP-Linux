import { describe, expect, it } from 'vitest';
import type {
  MachineRootProvider,
  NativeCapabilityBackend,
  PlatformRuntimeFactory,
} from './types.js';

describe('platform boundary types', () => {
  it('support a minimal injected runtime contract', async () => {
    const roots: MachineRootProvider = { roots: async () => ['/workspace'] };
    const native: NativeCapabilityBackend = {
      execute: async () => ({ ok: true, value: {} }),
      health: async () => ({ platform: 'linux', available: true, ready: true }),
    };
    const factory: PlatformRuntimeFactory<{ native: NativeCapabilityBackend }> = {
      create: async () => ({ native }),
    };

    await expect(roots.roots()).resolves.toEqual(['/workspace']);
    await expect(factory.create()).resolves.toEqual({ native });
  });
});
