import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';

export type TargetCatalogKind = 'database' | 'remote-host';

export interface TargetCatalogDatabaseRecord {
  readonly id: string;
  readonly displayName: string;
  readonly driver: 'postgresql' | 'mysql';
  readonly readOnly: boolean;
  readonly createdAt: string;
}

export interface TargetCatalogRemoteHostRecord {
  readonly id: string;
  readonly displayName: string;
  readonly roots: readonly string[];
  readonly createdAt: string;
}

export interface TargetCatalogDatabaseRepository {
  list(): Promise<readonly TargetCatalogDatabaseRecord[]>;
  get(id: string): Promise<TargetCatalogDatabaseRecord | null>;
}

export interface TargetCatalogRemoteHostRepository {
  list(): Promise<readonly TargetCatalogRemoteHostRecord[]>;
  get(id: string): Promise<TargetCatalogRemoteHostRecord | null>;
}

export interface TargetCatalogEntry {
  readonly id: string;
  readonly kind: TargetCatalogKind;
  readonly displayName: string;
  readonly provider: 'postgresql' | 'mysql' | 'openssh';
  readonly readOnly: boolean;
  readonly rootCount?: number;
  readonly createdAt: string;
}

export class TargetCatalogService {
  public constructor(
    private readonly databases: TargetCatalogDatabaseRepository,
    private readonly remoteHosts: TargetCatalogRemoteHostRepository,
  ) {}

  public async list(kind?: TargetCatalogKind): Promise<Result<readonly TargetCatalogEntry[]>> {
    const entries: TargetCatalogEntry[] = [];
    if (kind === undefined || kind === 'database') {
      for (const target of await this.databases.list()) entries.push(databaseEntry(target));
    }
    if (kind === undefined || kind === 'remote-host') {
      for (const host of await this.remoteHosts.list()) entries.push(remoteHostEntry(host));
    }
    entries.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    return ok(entries);
  }

  public async describe(kind: TargetCatalogKind, id: string): Promise<Result<TargetCatalogEntry>> {
    const normalizedId = id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalizedId)) {
      return err(appError('INVALID_INPUT', 'Target id is invalid'));
    }
    const entry = kind === 'database'
      ? databaseEntryOrNull(await this.databases.get(normalizedId))
      : remoteHostEntryOrNull(await this.remoteHosts.get(normalizedId));
    return entry === null
      ? err(appError('INVALID_INPUT', 'Registered target was not found'))
      : ok(entry);
  }
}

function databaseEntry(target: TargetCatalogDatabaseRecord): TargetCatalogEntry {
  return {
    id: target.id,
    kind: 'database',
    displayName: target.displayName,
    provider: target.driver,
    readOnly: target.readOnly,
    createdAt: target.createdAt,
  };
}

function remoteHostEntry(host: TargetCatalogRemoteHostRecord): TargetCatalogEntry {
  return {
    id: host.id,
    kind: 'remote-host',
    displayName: host.displayName,
    provider: 'openssh',
    readOnly: true,
    rootCount: host.roots.length,
    createdAt: host.createdAt,
  };
}

function databaseEntryOrNull(target: TargetCatalogDatabaseRecord | null): TargetCatalogEntry | null {
  return target === null ? null : databaseEntry(target);
}

function remoteHostEntryOrNull(host: TargetCatalogRemoteHostRecord | null): TargetCatalogEntry | null {
  return host === null ? null : remoteHostEntry(host);
}
