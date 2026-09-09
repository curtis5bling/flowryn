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
export const coordinationMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('revoke'), eventId: z.string().uuid(), sourceId: z.string().uuid(), change: authorizationChangeSchema }).strict(),
  z.object({ type: z.literal('ack'), eventId: z.string().uuid(), instanceId: z.string().uuid() }).strict(),
]);
export const coordinationLog = (event: string) => console.info(JSON.stringify({ service: 'realtime', event }));
export class CoordinationUnavailable extends Error {
  constructor() { super('Real-time coordination unavailable'); }
}
export class RevocationIncomplete extends CoordinationUnavailable {
  readonly code = 'REVOCATION_INCOMPLETE';
  constructor() { super(); this.message = 'Cluster revocation could not be confirmed'; }
}

export interface CoordinationTransport {
  readonly instanceId: string;
  participants(): Promise<string[]>;
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
  get instanceId() { return this.transport.instanceId; }
  private healthy: boolean;
  private closed = false;
  private closing?: Promise<void>;
  private previous: PresenceEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  private readonly received = new Map<string, Promise<void>>();
  private readonly released = new Set<string>();
  private readonly pending = new Map<string, { waiting: Set<string>; resolve: () => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(change: Change) => Promise<void>>();
  private readonly confirmed = new Set<(change: Change) => void>();
  private readonly healthListeners = new Set<(available: boolean) => void>();
  private readonly cleanup: Array<() => void>;
  constructor(readonly transport: CoordinationTransport, private readonly ackTimeoutMs = 3000) {
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
    if (!healthy) this.pending.forEach((operation) => operation.reject(new RevocationIncomplete()));
    coordinationLog(healthy ? 'coordination_recovered' : 'coordination_unavailable');
    this.healthListeners.forEach((listener) => listener(healthy));
  }
  fail() { this.setHealth(false); }
  assertAvailable() { if (!this.available) throw new CoordinationUnavailable(); }
  onHealth(listener: (available: boolean) => void) { this.healthListeners.add(listener); return () => { this.healthListeners.delete(listener); }; }
  onChange(listener: (change: Change) => Promise<void>) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onConfirmed(listener: (change: Change) => void) { this.confirmed.add(listener); return () => { this.confirmed.delete(listener); }; }
  private async receive(raw: string) {
    let input: unknown;
    try { input = JSON.parse(raw); } catch { coordinationLog('invalid_coordination_payload'); return; }
    const parsed = coordinationMessageSchema.safeParse(input);
    if (!parsed.success) { coordinationLog('invalid_coordination_payload'); return; }
    const message = parsed.data;
    if (message.type === 'ack') {
      const operation = this.pending.get(message.eventId);
      operation?.waiting.delete(message.instanceId);
      if (operation?.waiting.size === 0) operation.resolve();
      return;
    }
    if (message.sourceId === this.instanceId) return;
    let enforcement = this.received.get(message.eventId);
    if (!enforcement) {
      // Calling each listener starts quarantine synchronously before any await.
      enforcement = Promise.all([...this.listeners].map((listener) => listener(message.change))).then(() => {});
      this.received.set(message.eventId, enforcement);
      if (this.received.size > 10000) { const oldest = this.received.keys().next().value!; this.received.delete(oldest); this.released.delete(oldest); }
    }
    await enforcement;
    await this.transport.publish(JSON.stringify({ type: 'ack', eventId: message.eventId, instanceId: this.instanceId }));
    if (!this.released.has(message.eventId)) {
      this.released.add(message.eventId);
      this.confirmed.forEach((listener) => listener(message.change));
    }
  }
  async publish(change: Change) {
    const message = coordinationMessageSchema.parse({ type: 'revoke', eventId: randomUUID(), sourceId: this.instanceId, change });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      this.assertAvailable();
      const waiting = new Set(z.array(z.string().uuid()).parse(await this.transport.participants()));
      if (!waiting.delete(this.instanceId)) throw new RevocationIncomplete();
      const acknowledged = new Promise<void>((resolve, reject) => {
        this.pending.set(message.eventId, { waiting, resolve, reject });
        timeout = setTimeout(() => reject(new RevocationIncomplete()), this.ackTimeoutMs);
        if (!waiting.size) resolve();
      });
      await Promise.all([acknowledged, this.transport.publish(JSON.stringify(message))]);
    } catch {
      coordinationLog('revocation_unconfirmed');
      throw new RevocationIncomplete();
    } finally { clearTimeout(timeout); this.pending.delete(message.eventId); }
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
    this.pending.forEach((operation) => operation.reject(new RevocationIncomplete()));
    this.cleanup.forEach((cleanup) => cleanup());
    this.listeners.clear();
    this.confirmed.clear();
    this.healthListeners.clear();
    await this.transport.close();
  }
}

// Also used as a deterministic, lease-aware cluster simulator in the normal suite.
export class MemoryCoordinationNetwork {
  private snapshots = new Map<string, { entries: PresenceEntry[]; expiresAt: number }>();
  private history = new Map<string, Record<string, number>>();
  private peers = new Set<{ instanceId: string; receive: (raw: string) => void; healthy: boolean }>();
  constructor(private readonly now: () => number = Date.now) {}
  connect(): CoordinationTransport & { setAvailable(healthy: boolean): void } {
    const messages = new Set<(raw: string) => void>();
    const health = new Set<(healthy: boolean) => void>();
    const peer = { instanceId: randomUUID(), receive: (raw: string) => messages.forEach((listener) => listener(raw)), healthy: true };
    this.peers.add(peer);
    const check = () => { if (!peer.healthy) throw new CoordinationUnavailable(); };
    return {
      instanceId: peer.instanceId,
      participants: async () => { check(); return [...this.peers].filter((target) => target.healthy).map((target) => target.instanceId); },
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
