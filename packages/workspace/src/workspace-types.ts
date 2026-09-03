import type { WorkspaceId } from '@baitonghub-linux-mcp/domain';

export interface Workspace {
  readonly id: WorkspaceId;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
  /** Present only for archived workspace registrations. Archived workspaces are excluded from the runtime trust boundary. */
  readonly archivedAt?: string | null;
}

export interface ResolvedWorkspacePath {
  readonly workspaceId: WorkspaceId;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly realPath?: string;
  readonly exists: boolean;
}

export interface CheckpointFile {
  readonly path: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly size: number;
}

export interface Checkpoint {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly createdAt: string;
  readonly files: readonly CheckpointFile[];
}

export interface CheckpointRepository {
  insert(checkpoint: Checkpoint): Promise<void>;
  get(id: string): Promise<Checkpoint | null>;
}

/** Metadata-only workspace checkpoint persisted for an MCP actor. */
export interface WorkspaceCheckpointEntry {
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly sha256?: string;
}

export interface WorkspaceCheckpointRecord {
  readonly id: string;
  /** A one-way actor/session fingerprint; raw client or session identifiers never persist. */
  readonly ownerKey: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly path: string;
  readonly entries: readonly WorkspaceCheckpointEntry[];
  readonly scannedEntries: number;
  readonly truncated: boolean;
}

export interface WorkspaceCheckpointRepository {
  insert(record: WorkspaceCheckpointRecord): Promise<void>;
  list(ownerKey: string, workspaceId?: WorkspaceId, limit?: number): Promise<readonly WorkspaceCheckpointRecord[]>;
  get(ownerKey: string, id: string): Promise<WorkspaceCheckpointRecord | null>;
  delete(ownerKey: string, id: string): Promise<boolean>;
  pruneExpired(ownerKey: string, now: string): Promise<number>;
  count(ownerKey: string): Promise<number>;
  totalBytes(ownerKey: string): Promise<number>;
}
