export type WorkspaceIndexEventKind = 'change' | 'delete';

export type WorkspaceChangeKind = 'created' | 'modified' | 'deleted';

export interface WorkspaceIndexEvent {
  readonly relativePath: string;
  readonly kind: WorkspaceIndexEventKind;
  readonly changeKind?: WorkspaceChangeKind;
}

export interface WorkspaceIndexQueueStatus {
  readonly pendingEvents: number;
  readonly activeWorkers: number;
  readonly concurrency: number;
  readonly debounceMs: number;
  readonly enqueuedEvents: number;
  readonly coalescedEvents: number;
  readonly completedEvents: number;
  readonly failedEvents: number;
  readonly droppedEvents: number;
}

export interface WorkspaceChangeEvent {
  readonly sequence: number;
  readonly relativePath: string;
  readonly kind: WorkspaceChangeKind;
  readonly observedAt: string;
}

export interface WorkspaceChangeJournal {
  readonly events: readonly WorkspaceChangeEvent[];
  readonly latestSequence: number;
  readonly truncated: boolean;
}

export interface WorkspaceIndexQueueOptions {
  readonly debounceMs?: number;
  readonly concurrency?: number;
  readonly maxHistory?: number;
}

type EventWorker = (event: WorkspaceIndexEvent) => Promise<void>;
type QueueErrorListener = (event: WorkspaceIndexEvent, error: unknown) => void;

/**
 * A lossless event queue: only duplicate notifications for the same path are
 * coalesced. It never applies an ignore pattern and never drops a distinct
 * path, including hidden/generated/dependency paths.
 */
export class WorkspaceIndexQueue {
  private readonly pending = new Map<string, WorkspaceIndexEvent>();
  private readonly debounceMs: number;
  private readonly concurrency: number;
  private readonly maxHistory: number;
  private readonly listeners = new Set<QueueErrorListener>();
  private readonly history: WorkspaceChangeEvent[] = [];
  private readonly pendingHistory = new Map<string, WorkspaceChangeEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;
  private activeWorkers = 0;
  private enqueuedEvents = 0;
  private coalescedEvents = 0;
  private completedEvents = 0;
  private failedEvents = 0;
  private sequence = 0;

  public constructor(private readonly worker: EventWorker, options: WorkspaceIndexQueueOptions = {}) {
    this.debounceMs = Math.max(0, Math.floor(options.debounceMs ?? 50));
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
    this.maxHistory = Math.max(1, Math.min(200, Math.floor(options.maxHistory ?? 200)));
  }

  public enqueue(event: WorkspaceIndexEvent): void {
    const key = normalizeRelativePath(event.relativePath);
    if (key === null) return;
    this.enqueuedEvents += 1;
    const publicKind = event.kind === 'delete' ? 'deleted' : event.changeKind ?? (this.pending.has(key) ? 'modified' : 'created');
    const pendingHistory = this.pendingHistory.get(key);
    if (this.pending.has(key) && pendingHistory !== undefined) {
      this.coalescedEvents += 1;
      const replacement: WorkspaceChangeEvent = {
        sequence: ++this.sequence,
        relativePath: key,
        kind: publicKind,
        observedAt: new Date().toISOString(),
      };
      const historyIndex = this.history.indexOf(pendingHistory);
      if (historyIndex >= 0) this.history[historyIndex] = replacement;
      this.pendingHistory.set(key, replacement);
    } else {
      const change: WorkspaceChangeEvent = {
        sequence: ++this.sequence,
        relativePath: key,
        kind: publicKind,
        observedAt: new Date().toISOString(),
      };
      this.history.push(change);
      this.pendingHistory.set(key, change);
      while (this.history.length > this.maxHistory) this.history.shift();
    }
    this.pending.set(key, { relativePath: key, kind: event.kind });
    this.schedule();
  }

  public changes(afterSequence = 0, maxEvents = 50): WorkspaceChangeJournal {
    const boundedMax = Math.max(1, Math.min(200, Math.floor(maxEvents)));
    const oldest = this.history[0]?.sequence;
    const truncated = oldest !== undefined && afterSequence < oldest - 1;
    return {
      events: this.history.filter((event) => event.sequence > afterSequence).slice(0, boundedMax),
      latestSequence: this.sequence,
      truncated,
    };
  }

  public onError(listener: QueueErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public status(): WorkspaceIndexQueueStatus {
    return {
      pendingEvents: this.pending.size,
      activeWorkers: this.activeWorkers,
      concurrency: this.concurrency,
      debounceMs: this.debounceMs,
      enqueuedEvents: this.enqueuedEvents,
      coalescedEvents: this.coalescedEvents,
      completedEvents: this.completedEvents,
      failedEvents: this.failedEvents,
      droppedEvents: 0,
    };
  }

  public async drain(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    if (this.pending.size > 0 || this.activeWorkers > 0 || this.timer !== undefined) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      await this.drain();
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    const workers: Promise<void>[] = [];
    while (this.activeWorkers < this.concurrency && this.pending.size > 0) {
      const next = this.pending.entries().next().value as [string, WorkspaceIndexEvent] | undefined;
      if (next === undefined) break;
      this.pending.delete(next[0]);
      this.pendingHistory.delete(next[0]);
      this.activeWorkers += 1;
      workers.push(this.run(next[1]));
    }
    if (workers.length > 0) await Promise.all(workers);
    if (this.pending.size > 0) await this.flush();
    if (this.pending.size === 0 && this.activeWorkers === 0) {
      const wake = this.wake;
      this.wake = undefined;
      wake?.();
    }
  }

  private async run(event: WorkspaceIndexEvent): Promise<void> {
    try {
      await this.worker(event);
      this.completedEvents += 1;
    } catch (error: unknown) {
      this.failedEvents += 1;
      for (const listener of this.listeners) listener(event, error);
    } finally {
      this.activeWorkers -= 1;
    }
  }
}

function normalizeRelativePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return null;
  return normalized;
}
