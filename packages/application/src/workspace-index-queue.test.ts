import { describe, expect, it, vi } from 'vitest';
import { WorkspaceIndexQueue } from './workspace-index-queue.js';

describe('WorkspaceIndexQueue', () => {
  it('coalesces duplicate paths without dropping distinct paths', async () => {
    const seen: string[] = [];
    const queue = new WorkspaceIndexQueue(async (event) => {
      seen.push(`${event.kind}:${event.relativePath}`);
    }, { debounceMs: 0, concurrency: 2 });

    queue.enqueue({ relativePath: 'src/a.ts', kind: 'change' });
    queue.enqueue({ relativePath: 'src/a.ts', kind: 'change' });
    queue.enqueue({ relativePath: '.env', kind: 'change' });
    queue.enqueue({ relativePath: '.git/config', kind: 'change' });
    await queue.drain();

    expect(seen.sort()).toEqual(['change:.env', 'change:.git/config', 'change:src/a.ts']);
    expect(queue.status().coalescedEvents).toBe(1);
    expect(queue.status().droppedEvents).toBe(0);
  });

  it('limits active workers and reports failures without stopping siblings', async () => {
    let active = 0;
    let peak = 0;
    const failures: string[] = [];
    const queue = new WorkspaceIndexQueue(async (event) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (event.relativePath === 'bad.ts') throw new Error('fixture failure');
    }, { debounceMs: 0, concurrency: 2 });
    queue.onError((event) => failures.push(event.relativePath));

    for (const relativePath of ['a.ts', 'b.ts', 'bad.ts', 'c.ts']) {
      queue.enqueue({ relativePath, kind: 'change' });
    }
    await queue.drain();

    expect(peak).toBeLessThanOrEqual(2);
    expect(failures).toEqual(['bad.ts']);
    expect(queue.status().completedEvents).toBe(3);
    expect(queue.status().failedEvents).toBe(1);
  });

  it('waits for the configured debounce window before processing', async () => {
    vi.useFakeTimers();
    try {
      const worker = vi.fn(async () => undefined);
      const queue = new WorkspaceIndexQueue(worker, { debounceMs: 50, concurrency: 1 });
      queue.enqueue({ relativePath: 'src/a.ts', kind: 'change' });
      await vi.advanceTimersByTimeAsync(49);
      expect(worker).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await queue.drain();
      expect(worker).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records coalesced bounded change events and rejects unsafe paths', async () => {
    const queue = new WorkspaceIndexQueue(async () => undefined, { debounceMs: 0, maxHistory: 2 });
    queue.enqueue({ relativePath: '../escape', kind: 'change' });
    queue.enqueue({ relativePath: 'src/a.ts', kind: 'change', changeKind: 'created' });
    queue.enqueue({ relativePath: 'src/a.ts', kind: 'change', changeKind: 'modified' });
    queue.enqueue({ relativePath: 'src/b.ts', kind: 'change', changeKind: 'modified' });
    queue.enqueue({ relativePath: 'src/c.ts', kind: 'change', changeKind: 'deleted' });
    const journal = queue.changes(0, 10);
    expect(journal.events.map((event) => event.relativePath)).toEqual(['src/b.ts', 'src/c.ts']);
    expect(journal.events[0]?.sequence).toBeLessThan(journal.events[1]?.sequence ?? 0);
    expect(journal.truncated).toBe(true);
    await queue.drain();
  });
});
