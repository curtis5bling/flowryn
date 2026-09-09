import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Coordination, CoordinationUnavailable, createMemoryCoordination, leaseMs, MemoryCoordinationNetwork } from './coordination.js';

const workspaceId = 'a'.repeat(24);
const userId = 'b'.repeat(24);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('coordination abstraction', () => {
  it('validates internal messages, deduplicates delivery, and never rebroadcasts received changes', async () => {
    const network = new MemoryCoordinationNetwork();
    const transportA = network.connect();
    const transportB = network.connect();
    const a = new Coordination(transportA);
    const b = new Coordination(transportB);
    const listener = vi.fn(async () => {});
    b.onChange(listener);
    const send = vi.spyOn(transportB, 'publish');
    const message = JSON.stringify({ eventId: randomUUID(), change: { kind: 'membership', userId, workspaceId } });
    await transportA.publish(message);
    await transportA.publish(message);
    await transportA.publish(JSON.stringify({ eventId: randomUUID(), change: { kind: 'user', userId, token: 'secret' } }));
    await transportA.publish('not-json');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ kind: 'membership', userId, workspaceId });
    expect(send).not.toHaveBeenCalled();
    await a.close(); await b.close();
  });

  it('deduplicates devices across instances and expires crashed processes without exposing metadata', async () => {
    let now = 1000;
    const network = new MemoryCoordinationNetwork(() => now);
    const a = new Coordination(network.connect());
    const b = new Coordination(network.connect());
    await a.writePresence([{ workspaceId, userId }, { workspaceId, userId }]);
    await b.writePresence([{ workspaceId, userId }]);
    expect((await a.presence(workspaceId)).users).toEqual([userId]);
    now += 100;
    await a.close();
    expect((await b.presence(workspaceId)).users).toEqual([userId]);
    now += leaseMs;
    const state = await b.presence(workspaceId);
    expect(state).toEqual({ users: [], lastSeen: { [userId]: 1100 } });
    expect(JSON.stringify(state)).not.toContain(b.instanceId);
    await b.close();
  });

  it('fails explicitly during a partition, recovers without duplicating listeners, and cleans up', async () => {
    const transport = new MemoryCoordinationNetwork().connect();
    const coordination = new Coordination(transport);
    const health = vi.fn();
    const changes = vi.fn(async () => {});
    coordination.onHealth(health);
    coordination.onChange(changes);
    transport.setAvailable(false);
    await expect(coordination.publish({ kind: 'user', userId })).rejects.toBeInstanceOf(CoordinationUnavailable);
    await expect(coordination.presence(workspaceId)).rejects.toBeInstanceOf(CoordinationUnavailable);
    transport.setAvailable(true);
    transport.setAvailable(true);
    await transport.publish(JSON.stringify({ eventId: randomUUID(), change: { kind: 'user', userId } }));
    expect(changes).toHaveBeenCalledTimes(1);
    expect(health.mock.calls).toEqual([[false], [true]]);
    await coordination.close(); await coordination.close();
    expect(coordination.available).toBe(false);
  });

  it('sanitizes storage failures and permits memory only in tests or explicit development', async () => {
    const transport = new MemoryCoordinationNetwork().connect();
    const coordination = new Coordination(transport);
    vi.spyOn(transport, 'writePresence').mockRejectedValueOnce(new Error('redis://secret'));
    await expect(coordination.writePresence([{ workspaceId, userId }])).rejects.toThrow('Real-time coordination unavailable');
    expect(coordination.available).toBe(false);
    await coordination.close();
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('REALTIME_COORDINATION', 'memory');
    expect(createMemoryCoordination).toThrow('In-memory coordination');
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('REALTIME_COORDINATION', 'redis');
    expect(createMemoryCoordination).toThrow();
    vi.stubEnv('REALTIME_COORDINATION', 'memory');
    await createMemoryCoordination().close();
  });
});
