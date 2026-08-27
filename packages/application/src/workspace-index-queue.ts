export type WorkspaceIndexEventKind = 'change' | 'delete';

export interface WorkspaceIndexEvent {
  readonly relativePath: string;
  readonly kind: WorkspaceIndexEventKind;
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

export interface WorkspaceIndexQueueOptions {
  readonly debounceMs?: number;
  readonly concurrency?: number;
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
  private readonly listeners = new Set<QueueErrorListener>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;
  private activeWorkers = 0;
  private enqueuedEvents = 0;
  private coalescedEvents = 0;
  private completedEvents = 0;
  private failedEvents = 0;

  public constructor(private readonly worker: EventWorker, options: WorkspaceIndexQueueOptions = {}) {
    this.debounceMs = Math.max(0, Math.floor(options.debounceMs ?? 50));
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  }

  public enqueue(event: WorkspaceIndexEvent): void {
    const key = event.relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
    this.enqueuedEvents += 1;
    if (this.pending.has(key)) this.coalescedEvents += 1;
    this.pending.set(key, { relativePath: key, kind: event.kind });
    this.schedule();
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
