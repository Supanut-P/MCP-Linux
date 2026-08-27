export type PermissionLevel = 'READ' | 'WRITE' | 'EXECUTE' | 'DANGEROUS';
export type PermissionDecision = 'ALLOW' | 'ASK' | 'DENY';
export type PermissionProfileName = 'safe' | 'balanced' | 'full' | 'custom';

export interface OperationDescriptor {
  readonly action: string;
  readonly level: PermissionLevel;
  readonly workspaceId: string;
  readonly target?: string;
  readonly executable?: string;
  readonly destructive: boolean;
}

export interface PermissionProfile {
  readonly name: PermissionProfileName;
  readonly defaults: Readonly<Record<PermissionLevel, PermissionDecision>>;
  readonly allowedProjectExecutables: readonly string[];
}
