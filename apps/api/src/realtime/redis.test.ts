import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ clients: [] as FakeRedis[], failConnect: false }));
class FakeRedis extends EventEmitter {
  status = 'wait';
  channels = new Set<string>();
  constructor() { super(); state.clients.push(this); }
  duplicate() { return new FakeRedis(); }
  async connect() { if (state.failConnect) throw new Error('redis://secret'); this.status = 'ready'; }
  subscribe = vi.fn(async (channel: string) => { this.channels.add(channel); return 1; });
  psubscribe = vi.fn(async (channel: string) => { this.channels.add(channel); return 1; });
  ping = vi.fn(async () => 'PONG');
  publish = vi.fn(async (channel: string, message: string) => { for (const client of state.clients) if (client.channels.has(channel)) client.emit('message', channel, message); return 1; });
  eval = vi.fn(async (...args: unknown[]): Promise<unknown> => { void args; return [[], []]; });
  quit = vi.fn(async () => { this.status = 'end'; return 'OK'; });
  disconnect = vi.fn(() => { this.status = 'end'; });
}
vi.mock('ioredis', () => ({ Redis: FakeRedis }));
vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: vi.fn(() => () => {}) }));

// Dynamic import after the mock declarations keeps the fake constructor initialized.
const { RedisCoordinationTransport, createCoordination } = await import('./redis.js');
const { Coordination } = await import('./coordination.js');
beforeEach(() => { state.clients = []; state.failConnect = false; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Redis transport', () => {
  it('contains adapter command failures and restores subscriptions without adding listeners', async () => {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const transport = new RedisCoordinationTransport('redis://localhost');
    await transport.start();
    const coordination = new Coordination(transport);
    const [publisher, subscriber] = vi.mocked(createAdapter).mock.calls.at(-1)!;
    state.clients[1]!.psubscribe.mockRejectedValueOnce(new Error('secret'));
    await expect(subscriber.psubscribe('flowryn:socket#/#*')).resolves.toBe(0);
    expect(coordination.available).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(coordination.available).toBe(true);
    expect(state.clients[1]!.psubscribe).toHaveBeenLastCalledWith('flowryn:socket#/#*');
    expect(state.clients[1]!.listenerCount('message')).toBe(1);
    state.clients[0]!.publish.mockRejectedValueOnce(new Error('secret'));
    await expect(publisher.publish('flowryn:socket#/#', 'event')).resolves.toBe(0);
    expect(coordination.available).toBe(false);
    await coordination.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a pending subscription probe during shutdown', async () => {
    const transport = new RedisCoordinationTransport('redis://localhost');
    await transport.start();
    state.clients[0]!.publish.mockResolvedValueOnce(1);
    await vi.advanceTimersByTimeAsync(2000);
    await transport.close();
    expect(transport.available).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.clients.every((client) => client.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('uses separate clients, probes the subscription, recovers without duplicate listeners and closes both', async () => {
    const transport = new RedisCoordinationTransport('redis://localhost');
    await transport.start();
    const coordination = new Coordination(transport);
    expect(state.clients).toHaveLength(2);
    expect(state.clients[0]).not.toBe(state.clients[1]);
    expect(coordination.available).toBe(true);
    const receiver = vi.fn(async () => {});
    coordination.onChange(receiver);
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    state.clients[1]!.emit('error', new Error('redis://secret'));
    expect(coordination.available).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(coordination.available).toBe(true);
    expect(state.clients[1]!.listenerCount('message')).toBe(1);
    expect(logs.mock.calls.flat().join(' ')).not.toContain('secret');
    await coordination.close();
    expect(state.clients.every((client) => client.quit.mock.calls.length === 1 && client.disconnect.mock.calls.length === 1)).toBe(true);
    expect(state.clients[1]!.listenerCount('message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails startup without Redis, closes failed clients, and never falls back in production', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('REALTIME_COORDINATION', 'redis'); vi.stubEnv('REDIS_URL', 'redis://secret');
    state.failConnect = true;
    await expect(createCoordination()).rejects.toThrow('Required Redis coordination is unavailable');
    expect(state.clients.every((client) => client.disconnect.mock.calls.length === 1)).toBe(true);
    vi.stubEnv('REALTIME_COORDINATION', 'memory');
    await expect(createCoordination()).rejects.toThrow('In-memory coordination');
    vi.stubEnv('REALTIME_COORDINATION', 'redis'); vi.stubEnv('REDIS_URL', '');
    await expect(createCoordination()).rejects.toThrow('REDIS_URL is required');
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('REALTIME_COORDINATION', '');
    const fallback = await createCoordination();
    expect(fallback.available).toBe(true);
    await fallback.close();
  });

  it('returns only validated member presence and rejects malformed Redis state', async () => {
    const transport = new RedisCoordinationTransport('redis://localhost');
    await transport.start();
    const userId = 'b'.repeat(24);
    state.clients[0]!.eval.mockResolvedValueOnce([[`${userId}:12345678-1234-1234-1234-123456789abc`], [userId, '1234']]);
    expect(await transport.presence('a'.repeat(24))).toEqual({ users: [userId], lastSeen: { [userId]: 1234 } });
    state.clients[0]!.eval.mockResolvedValueOnce([['socket-secret'], []]);
    await expect(transport.presence('a'.repeat(24))).rejects.toThrow();
    await transport.close();
  });
});
