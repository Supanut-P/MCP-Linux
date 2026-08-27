import type { Result } from '@baitonghub-linux-mcp/domain';
import type { SecretStore } from '@baitonghub-linux-mcp/shared';
import type { ProcessTreeTerminator } from '@baitonghub-linux-mcp/process';
import type { CapabilityBackend } from '../local-capability-service.js';

export interface PlatformRuntimeFactory<TRuntime> {
  create(): Promise<TRuntime> | TRuntime;
}

export interface MachineRootProvider {
  roots(): Promise<readonly string[]> | readonly string[];
}

export interface NativeCapabilityHealth {
  readonly platform: NodeJS.Platform;
  readonly displayServer?: string;
  readonly provider?: string;
  readonly available: boolean;
  readonly ready: boolean;
  readonly requiresConsent?: boolean;
  readonly missingDependencies?: readonly string[];
  readonly reason?: string;
}

export interface NativeCapabilityBackend extends CapabilityBackend {
  health(): Promise<NativeCapabilityHealth>;
}

export interface PlatformRuntimeDependencies {
  readonly machineRoots: MachineRootProvider;
  readonly secrets: SecretStore;
  readonly processTree: ProcessTreeTerminator;
}

export type NativeCapabilityResult = Result<unknown>;
