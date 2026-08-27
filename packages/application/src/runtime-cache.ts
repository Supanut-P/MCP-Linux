export interface RuntimeCacheKey {
  readonly workspaceId: string;
  readonly path: string;
  readonly mtimeMs?: number;
  readonly size?: number;
  readonly gitBlobSha?: string;
  readonly contentHash?: string;
}

export interface RuntimeCacheStats {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly bytesSaved: number;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly bytes: number;
  readonly fingerprint: string;
}

export class RuntimeCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private bytesSaved = 0;

  public get(key: RuntimeCacheKey): T | undefined {
    const cacheKey = keyString(key);
    const entry = this.entries.get(cacheKey);
    if (entry === undefined) { this.misses += 1; return undefined; }
    this.hits += 1;
    this.bytesSaved += entry.bytes;
    return entry.value;
  }

  public set(key: RuntimeCacheKey, value: T, bytes: number = 0): void {
    this.entries.set(keyString(key), { value, bytes: Math.max(0, bytes), fingerprint: fingerprint(key) });
  }

  public invalidate(predicate?: (key: string) => boolean): number {
    if (predicate === undefined) { const count = this.entries.size; this.entries.clear(); return count; }
    let removed = 0;
    for (const key of this.entries.keys()) if (predicate(key)) { this.entries.delete(key); removed += 1; }
    return removed;
  }

  public stats(): RuntimeCacheStats {
    const total = this.hits + this.misses;
    return { entries: this.entries.size, hits: this.hits, misses: this.misses, hitRate: total === 0 ? 0 : this.hits / total, bytesSaved: this.bytesSaved };
  }
}

function keyString(key: RuntimeCacheKey): string {
  return `${key.workspaceId}:${key.path}:${fingerprint(key)}`;
}

function fingerprint(key: RuntimeCacheKey): string {
  return [key.mtimeMs, key.size, key.gitBlobSha, key.contentHash].map((value) => value ?? '').join('|');
}
