import { randomUUID } from 'node:crypto';

import type { createAdapter } from '@socket.io/redis-adapter';
import { z } from 'zod';

import { authorizationChangeSchema, type Change } from '../auth/revocation.js';

export const leaseMs = 15000;
export const heartbeatMs = 5000;
const id = z.string().regex(/^[a-f\d]{24}$/i);
export const presenceEntriesSchema = z.array(z.object({ workspaceId: id, userId: id }).strict()).max(10000);
export type PresenceEntry = z.infer<typeof presenceEntriesSchema>[number];
export const presenceStateSchema = z.object({ users: z.array(id), lastSeen: z.record(id, z.number().int().nonnegative()) }).strict();
export type PresenceState = z.infer<typeof presenceStateSchema>;
export const coordinationMessageSchema = z.object({ eventId: z.string().uuid(), change: authorizationChangeSchema }).strict();
export const coordinationLog = (event: string) => console.info(JSON.stringify({ service: 'realtime', event }));
export class CoordinationUnavailable extends Error {
  constructor() { super('Real-time coordination unavailable'); }
}

export interface CoordinationTransport {
  adapter?: ReturnType<typeof createAdapter>;
  available: boolean;
  onMessage(listener: (message: string) => void): () => void;
  onHealth(listener: (available: boolean) => void): () => void;
  publish(message: string): Promise<void>;
  writePresence(instanceId: string, previous: PresenceEntry[], current: PresenceEntry[]): Promise<void>;
  presence(workspaceId: string): Promise<PresenceState>;
  close(): Promise<void>;
}

export class Coordination {
  readonly instanceId = randomUUID();
  private healthy: boolean;
  private closed = false;
  private closing?: Promise<void>;
  private previous: PresenceEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  private readonly received = new Set<string>();
  private readonly listeners = new Set<(change: Change) => Promise<void>>();
  private readonly healthListeners = new Set<(available: boolean) => void>();
  private readonly cleanup: Array<() => void>;
  constructor(readonly transport: CoordinationTransport) {
    this.healthy = transport.available;
    this.cleanup = [transport.onHealth((healthy) => this.setHealth(healthy)), transport.onMessage((raw) => {
      void this.receive(raw).catch(() => this.fail());
    })];
  }
  get available() { return !this.closed && this.healthy && this.transport.available; }
  get adapter() { return this.transport.adapter; }
  private setHealth(healthy: boolean) {
    if (this.closed || this.healthy === healthy) return;
    this.healthy = healthy;
    coordinationLog(healthy ? 'coordination_recovered' : 'coordination_unavailable');
    this.healthListeners.forEach((listener) => listener(healthy));
  }
  fail() { this.setHealth(false); }
  assertAvailable() { if (!this.available) throw new CoordinationUnavailable(); }
  onHealth(listener: (available: boolean) => void) { this.healthListeners.add(listener); return () => { this.healthListeners.delete(listener); }; }
  onChange(listener: (change: Change) => Promise<void>) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private async receive(raw: string) {
    let input: unknown;
    try { input = JSON.parse(raw); } catch { coordinationLog('invalid_coordination_payload'); return; }
    const parsed = coordinationMessageSchema.safeParse(input);
    if (!parsed.success) { coordinationLog('invalid_coordination_payload'); return; }
    if (this.received.has(parsed.data.eventId)) return;
    this.received.add(parsed.data.eventId);
    if (this.received.size > 10000) this.received.delete(this.received.values().next().value!);
    await Promise.all([...this.listeners].map((listener) => listener(parsed.data.change)));
  }
  async publish(change: Change) {
    this.assertAvailable();
    const message = coordinationMessageSchema.parse({ eventId: randomUUID(), change });
    this.received.add(message.eventId); // Local application is awaited by the caller.
    if (this.received.size > 10000) this.received.delete(this.received.values().next().value!);
    try { await this.transport.publish(JSON.stringify(message)); }
    catch { this.fail(); throw new CoordinationUnavailable(); }
  }
  writePresence(entries: PresenceEntry[]) {
    const current = presenceEntriesSchema.parse(entries);
    const write = this.writes.then(async () => {
      this.assertAvailable();
      await this.transport.writePresence(this.instanceId, this.previous, current);
      this.previous = current;
    }).catch(() => { this.fail(); throw new CoordinationUnavailable(); });
    this.writes = write.catch(() => { this.fail(); });
    return write;
  }
  async presence(workspaceId: string) {
    id.parse(workspaceId);
    await this.writes;
    this.assertAvailable();
    try { return presenceStateSchema.parse(await this.transport.presence(workspaceId)); }
    catch { this.fail(); throw new CoordinationUnavailable(); }
  }
  close() { this.closing ??= this.shutdown(); return this.closing; }
  private async shutdown() {
    if (this.closed) return;
    await this.writes;
    if (this.available) {
      try { await this.transport.writePresence(this.instanceId, this.previous, []); }
      catch { coordinationLog('presence_cleanup_deferred_to_lease'); }
    }
    this.closed = true;
    this.cleanup.forEach((cleanup) => cleanup());
    this.listeners.clear();
    this.healthListeners.clear();
    await this.transport.close();
  }
}

// Also used as a deterministic, lease-aware cluster simulator in the normal suite.
export class MemoryCoordinationNetwork {
  private snapshots = new Map<string, { entries: PresenceEntry[]; expiresAt: number }>();
  private history = new Map<string, Record<string, number>>();
  private peers = new Set<{ receive: (raw: string) => void; healthy: boolean }>();
  constructor(private readonly now: () => number = Date.now) {}
  connect(): CoordinationTransport & { setAvailable(healthy: boolean): void } {
    const messages = new Set<(raw: string) => void>();
    const health = new Set<(healthy: boolean) => void>();
    const peer = { receive: (raw: string) => messages.forEach((listener) => listener(raw)), healthy: true };
    this.peers.add(peer);
    const check = () => { if (!peer.healthy) throw new CoordinationUnavailable(); };
    return {
      get available() { return peer.healthy; },
      setAvailable: (healthy) => { peer.healthy = healthy; health.forEach((listener) => listener(healthy)); },
      onMessage: (listener) => { messages.add(listener); return () => { messages.delete(listener); }; },
      onHealth: (listener) => { health.add(listener); return () => { health.delete(listener); }; },
      publish: async (raw) => { check(); this.peers.forEach((target) => { if (target.healthy) target.receive(raw); }); },
      writePresence: async (instanceId, previous, entries) => {
        check();
        for (const entry of [...previous, ...entries]) {
          const history = this.history.get(entry.workspaceId) ?? {};
          history[entry.userId] = Math.max(history[entry.userId] ?? 0, this.now());
          this.history.set(entry.workspaceId, history);
        }
        this.snapshots.set(instanceId, { entries, expiresAt: this.now() + leaseMs });
      },
      presence: async (workspaceId) => {
        check();
        const users = new Set<string>();
        for (const [instance, snapshot] of this.snapshots) {
          if (snapshot.expiresAt <= this.now()) { this.snapshots.delete(instance); continue; }
          snapshot.entries.filter((entry) => entry.workspaceId === workspaceId).forEach((entry) => users.add(entry.userId));
        }
        return { users: [...users].sort(), lastSeen: { ...this.history.get(workspaceId) } };
      },
      close: async () => { this.peers.delete(peer); messages.clear(); health.clear(); peer.healthy = false; },
    };
  }
}

export const createMemoryCoordination = () => {
  if (process.env.NODE_ENV !== 'test' && !(process.env.NODE_ENV === 'development' && process.env.REALTIME_COORDINATION === 'memory')) {
    throw new Error('In-memory coordination requires test mode or explicit development configuration');
  }
  return new Coordination(new MemoryCoordinationNetwork().connect());
};
