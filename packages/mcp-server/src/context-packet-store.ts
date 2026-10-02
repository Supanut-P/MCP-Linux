import { createHash } from 'node:crypto';
import { ContextPacketRuntime, type ContextPacketPorts } from './context-packet-runtime.js';

/** Process-local serving lifetime; session eviction never grants new authority. */
export class ContextPacketStore {
  private readonly entries = new Map<string, { runtime: ContextPacketRuntime; touched: number }>();

  public constructor(private readonly now: () => number = Date.now) {}

  public get(ports: ContextPacketPorts): ContextPacketRuntime {
    const current = this.now();
    for (const [key, entry] of this.entries) {
      if (current - entry.touched >= 15 * 60_000) this.entries.delete(key);
    }
    const key = createHash('sha256').update(JSON.stringify([
      ports.actor.clientId, ports.actor.clientName, ports.actor.sessionId ?? null,
    ])).digest('hex');
    const existing = this.entries.get(key);
    const runtime = existing?.runtime ?? new ContextPacketRuntime({ ...ports, now: this.now });
    this.entries.delete(key);
    this.entries.set(key, { runtime, touched: current });
    // Eight sessions, each with the runtime's bounded task/reference/text quotas.
    while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
    return runtime;
  }

  public clear(): void { this.entries.clear(); }
}
