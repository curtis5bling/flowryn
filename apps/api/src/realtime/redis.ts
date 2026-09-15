import { randomUUID } from 'node:crypto';

import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { Coordination, coordinationLog, CoordinationUnavailable, createMemoryCoordination, leaseMs, presenceEntriesSchema, presenceStateSchema, type CoordinationTransport, type PresenceEntry } from './coordination.js';

const channel = 'flowryn:authorization:v2';
const probeSchema = z.object({ probe: z.string().uuid() }).strict();
const participantKey = 'flowryn:api-instances:v2';
const participantScript = `local t = redis.call('TIME'); local now = tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if ARGV[1] ~= '' then redis.call('ZADD', KEYS[1], now+15000, ARGV[1]) end
return redis.call('ZRANGE', KEYS[1], 0, -1)`;
// Redis time provides one clock for leases and monotonically increasing last-seen.
export const writePresenceScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local previous = cjson.decode(ARGV[2])
local current = cjson.decode(ARGV[3])
for _, user in ipairs(previous) do redis.call('ZREM', KEYS[1], user .. ':' .. ARGV[1]) end
for _, user in ipairs(current) do redis.call('ZADD', KEYS[1], now + tonumber(ARGV[4]), user .. ':' .. ARGV[1]) end
for _, list in ipairs({previous, current}) do
  for _, user in ipairs(list) do
    local old = tonumber(redis.call('ZSCORE', KEYS[2], user) or '0')
    redis.call('ZADD', KEYS[2], math.max(old, now), user)
  end
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) * 2)
redis.call('EXPIRE', KEYS[2], 2592000)
return 1`;
export const readPresenceScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return {redis.call('ZRANGE', KEYS[1], 0, -1), redis.call('ZRANGE', KEYS[2], 0, -1, 'WITHSCORES')}`;

export class RedisCoordinationTransport implements CoordinationTransport {
  readonly instanceId = randomUUID();
  readonly publisher: Redis;
  readonly subscriber: Redis;
  readonly adapter: ReturnType<typeof createAdapter>;
  available = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private probing?: Promise<void>;
  private readonly messages = new Set<(message: string) => void>();
  private readonly health = new Set<(healthy: boolean) => void>();
  private readonly probes = new Map<string, () => void>();
  private readonly adapterSubscriptions = new Map<string, { method: 'subscribe' | 'psubscribe'; channel: string }>();
  constructor(url: string) {
    this.publisher = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000, commandTimeout: 1500, retryStrategy: (times) => Math.min(times * 200, 2000) });
    this.subscriber = this.publisher.duplicate();
    for (const client of [this.publisher, this.subscriber]) {
      client.on('error', this.onFailure);
      client.on('close', this.onFailure);
      client.on('end', this.onFailure);
    }
    this.subscriber.on('message', this.onMessageReceived);
    this.adapter = createAdapter(this.adapterClient(this.publisher), this.adapterClient(this.subscriber), { key: 'flowryn:socket', publishOnSpecificResponseChannel: true, requestsTimeout: 2000 });
  }
  // The official adapter issues some Redis commands without awaiting their
  // promises. Catch those at its boundary; control-plane commands still reject.
  private adapterClient(client: Redis): Redis {
    return new Proxy(client, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        if (!['publish', 'subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe'].includes(String(property))) return value.bind(target);
        return (...args: unknown[]) => {
          for (const name of args.flat().filter((arg): arg is string => typeof arg === 'string')) {
            if (property === 'subscribe' || property === 'psubscribe') this.adapterSubscriptions.set(`${property}:${name}`, { method: property, channel: name });
            if (property === 'unsubscribe' || property === 'punsubscribe') this.adapterSubscriptions.delete(`${property === 'unsubscribe' ? 'subscribe' : 'psubscribe'}:${name}`);
          }
          return Promise.resolve().then(() => Reflect.apply(value, target, args)).catch(() => { this.onFailure(); return 0; });
        };
      },
    });
  }
  private setHealth(healthy: boolean) {
    if (this.closed || (!healthy && !this.available)) return;
    this.available = healthy;
    this.health.forEach((listener) => listener(healthy));
  }
  private onFailure = () => { this.setHealth(false); };
  private onMessageReceived = (name: string, message: string) => {
    if (name !== channel) return;
    let data: unknown;
    try { data = JSON.parse(message); } catch { coordinationLog('invalid_coordination_payload'); return; }
    const probe = probeSchema.safeParse(data);
    if (probe.success) { this.probes.get(probe.data.probe)?.(); return; }
    this.messages.forEach((listener) => listener(message));
  };
  onMessage(listener: (message: string) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onHealth(listener: (healthy: boolean) => void) { this.health.add(listener); return () => { this.health.delete(listener); }; }
  async start() {
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.probe();
      if (!this.available) throw new CoordinationUnavailable();
      this.timer = setInterval(() => { void this.probe().catch(this.onFailure); }, 2000);
      this.timer.unref();
      coordinationLog('redis_coordination_ready');
    } catch {
      await this.close();
      throw new Error('Required Redis coordination is unavailable; check REDIS_URL and Redis connectivity');
    }
  }
  private probe() {
    this.probing ??= (async () => {
      if (this.closed || this.publisher.status !== 'ready' || this.subscriber.status !== 'ready') { this.onFailure(); return; }
      await this.subscriber.subscribe(channel);
      for (const subscription of this.adapterSubscriptions.values()) await this.subscriber[subscription.method](subscription.channel);
      await this.publisher.ping();
      const probe = randomUUID();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const received = new Promise<void>((resolve, reject) => {
        this.probes.set(probe, resolve);
        timeout = setTimeout(() => reject(new CoordinationUnavailable()), 1500);
      });
      try {
        await Promise.all([received, this.publisher.publish(channel, JSON.stringify({ probe }))]);
        await this.publisher.eval(participantScript, 1, participantKey, this.instanceId);
        this.setHealth(true);
      } finally { clearTimeout(timeout); this.probes.delete(probe); }
    })().finally(() => { this.probing = undefined; });
    return this.probing;
  }
  async publish(message: string) {
    if (!this.available) throw new CoordinationUnavailable();
    await this.publisher.publish(channel, message);
  }
  async participants() {
    if (!this.available) throw new CoordinationUnavailable();
    return z.array(z.string().uuid()).parse(await this.publisher.eval(participantScript, 1, participantKey, ''));
  }
  async writePresence(instanceId: string, previous: PresenceEntry[], current: PresenceEntry[]) {
    if (!this.available) throw new CoordinationUnavailable();
    z.string().uuid().parse(instanceId);
    presenceEntriesSchema.parse(previous);
    presenceEntriesSchema.parse(current);
    const workspaces = new Set([...previous, ...current].map((entry) => entry.workspaceId));
    for (const workspace of workspaces) {
      const oldUsers = [...new Set(previous.filter((entry) => entry.workspaceId === workspace).map((entry) => entry.userId))];
      const users = [...new Set(current.filter((entry) => entry.workspaceId === workspace).map((entry) => entry.userId))];
      await this.publisher.eval(writePresenceScript, 2, `flowryn:presence:{${workspace}}`, `flowryn:last-seen:{${workspace}}`, instanceId, JSON.stringify(oldUsers), JSON.stringify(users), leaseMs);
    }
  }
  async presence(workspace: string) {
    if (!this.available) throw new CoordinationUnavailable();
    z.string().regex(/^[a-f\d]{24}$/i).parse(workspace);
    const raw = z.tuple([z.array(z.string()), z.array(z.string())]).parse(await this.publisher.eval(readPresenceScript, 2, `flowryn:presence:{${workspace}}`, `flowryn:last-seen:{${workspace}}`));
    const users = raw[0].map((entry) => {
      z.string().regex(/^[a-f\d]{24}:/i).parse(entry);
      z.string().uuid().parse(entry.slice(25));
      return entry.slice(0, 24);
    });
    if (raw[1].length % 2 !== 0) throw new CoordinationUnavailable();
    const lastSeen: Record<string, number> = {};
    for (let index = 0; index < raw[1].length; index += 2) lastSeen[raw[1][index]!] = Number(raw[1][index + 1]);
    return presenceStateSchema.parse({ users: [...new Set(users)].sort(), lastSeen });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.available = false;
    clearInterval(this.timer);
    // Release a pending round-trip before closing the connections.
    this.probes.forEach((resolve) => resolve());
    await this.probing?.catch(() => {});
    try { if (this.publisher.status === 'ready') await this.publisher.zrem(participantKey, this.instanceId); } catch { coordinationLog('participant_cleanup_deferred_to_lease'); }
    await Promise.all([this.publisher, this.subscriber].map(async (client) => {
      try { if (client.status === 'ready') await client.quit(); } catch { /* Force-close below. */ }
      client.disconnect();
      client.off('error', this.onFailure); client.off('close', this.onFailure); client.off('end', this.onFailure);
    }));
    this.subscriber.off('message', this.onMessageReceived);
    this.messages.clear(); this.health.clear(); this.probes.clear();
  }
}

export const createCoordination = async () => {
  if (process.env.REALTIME_COORDINATION === 'memory' || (process.env.NODE_ENV === 'test' && !process.env.REALTIME_COORDINATION)) return createMemoryCoordination();
  if (process.env.REALTIME_COORDINATION && process.env.REALTIME_COORDINATION !== 'redis') throw new Error('Invalid REALTIME_COORDINATION mode');
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for real-time Redis coordination');
  const transport = new RedisCoordinationTransport(process.env.REDIS_URL);
  await transport.start();
  return new Coordination(transport);
};
