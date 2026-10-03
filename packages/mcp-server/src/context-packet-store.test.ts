import { expect, it } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ContextPacketStore } from './context-packet-store.js';
import type { ContextPacketPorts } from './context-packet-runtime.js';

function ports(sessionId: string, clientId = 'client'): ContextPacketPorts {
  return {
    actor: { clientId, clientName: 'fixture', sessionId },
    source: { readContextFile: async (): Promise<ReturnType<typeof ok>> => ok({ status: 'unavailable', path: 'fixture', reason: 'changed', rootFingerprint: 'root' }) },
    discovery: { discoverPacketCandidates: async (): Promise<ReturnType<typeof ok>> => ok({ candidates: [], searchTruncated: false }) },
  };
}

it('shares one runtime per actor/session while bounding session retention', () => {
  const store = new ContextPacketStore();
  const first = store.get(ports('first'));
  expect(store.get(ports('first'))).toBe(first);
  expect(store.get(ports('first', 'other-client'))).not.toBe(first);
  for (let i = 0; i < 8; i += 1) store.get(ports(`new-${i}`));
  expect(store.get(ports('first'))).not.toBe(first);
  store.clear();
  const fresh = store.get(ports('first'));
  store.clear();
  expect(store.get(ports('first'))).not.toBe(fresh);
});

it('expires idle serving-session caches without turning them into durable state', () => {
  let now = 100;
  const store = new ContextPacketStore(() => now);
  const first = store.get(ports('session'));
  now += 15 * 60_000;
  expect(store.get(ports('session'))).not.toBe(first);
});
