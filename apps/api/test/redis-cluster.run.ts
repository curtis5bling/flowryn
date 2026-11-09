/* eslint-disable @typescript-eslint/no-explicit-any -- Socket.IO and child-process probes intentionally inspect dynamic wire payloads. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Redis } from 'ioredis';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { io, type Socket } from 'socket.io-client';

import { issueTokens } from '../src/auth/tokens.js';
import { AuthSessionModel } from '../src/models/AuthSession.js';
import { UserModel } from '../src/models/User.js';
import { WorkspaceModel } from '../src/models/Workspace.js';
import { WorkspaceMemberModel } from '../src/models/WorkspaceMember.js';

const redisUrl = process.env.M11_REDIS_URL;
if (!redisUrl) throw new Error('M11_REDIS_URL is required');
const prefix = `flowryn:m11:${randomUUID()}`;
const childFile = fileURLToPath(new URL('./redis-cluster-child.ts', import.meta.url));
const sockets: Socket[] = [];
const children: ChildProcess[] = [];
let mongo: MongoMemoryReplSet | undefined;
let redis: Redis | undefined;
let checks = 0;
const waitFor = <T>(emitter: NodeJS.EventEmitter, event: string, predicate: (value: any) => T | undefined, timeout = 10000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)); }, timeout);
    const listener = (value: any) => { const result = predicate(value); if (result !== undefined) { cleanup(); resolve(result); } };
    const cleanup = () => { clearTimeout(timer); emitter.off(event, listener); };
    emitter.on(event, listener);
  });
const command = async (child: ChildProcess, message: Record<string, unknown>) => {
  const id = randomUUID();
  const pending = waitFor(child, 'message', (value) => value?.id === id ? value : undefined);
  child.send!({ ...message, id });
  const result: any = await pending;
  assert.notEqual(result.type, 'error');
  return result;
};
const noEvent = async (socket: Socket, event: string, action: () => Promise<void>) => {
  let count = 0; const listener = () => count++; socket.on(event, listener); await action(); await new Promise((r) => setTimeout(r, 350)); socket.off(event, listener); assert.equal(count, 0); checks++;
};
const oneEvent = async (socket: Socket, event: string, action: () => Promise<void>) => {
  const events: any[] = []; const listener = (value: any) => events.push(value); socket.on(event, listener); await action(); await new Promise((r) => setTimeout(r, 1000)); socket.off(event, listener); assert.equal(events.length, 1); assert.deepEqual(events[0].payload, {}); assert.deepEqual(Object.keys(events[0]).sort(), ['actorId','entityId','eventId','payload','timestamp','type','workspaceId'].sort()); checks++; return events[0];
};
const connect = async (port: number, token: string) => {
  const socket = io(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false }); sockets.push(socket); await waitFor(socket, 'connect', () => true); return socket;
};
const join = (socket: Socket, workspaceId: string, ok = true) => new Promise<void>((resolve, reject) => socket.emit('workspace:join', workspaceId, (reply: any) => reply?.ok === ok ? resolve() : reject(new Error('Unexpected join response'))));

try {
  redis = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await redis.connect();
  const probeSub = redis.duplicate(); await probeSub.connect(); const channel = `${prefix}:probe:${randomUUID()}`; await probeSub.subscribe(channel);
  const received = waitFor(probeSub, 'message', (name) => name === channel ? true : undefined); await redis.publish(channel, 'probe'); await received; await probeSub.quit(); checks++;
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([UserModel.init(), WorkspaceModel.init(), WorkspaceMemberModel.init(), AuthSessionModel.init()]);
  const [owner, admin, member, outsider] = await UserModel.create(['owner','admin','member','outsider'].map((name) => ({ name, email: `${name}@redis-m11.test`, passwordHash: 'unused', status: 'active' })));
  const [workspace, other] = await WorkspaceModel.create([{ name: 'M11 Primary', createdBy: owner!._id }, { name: 'M11 Other', createdBy: outsider!._id }]);
  await WorkspaceMemberModel.create([{ workspaceId: workspace!._id, userId: owner!._id, role: 'owner' }, { workspaceId: workspace!._id, userId: admin!._id, role: 'admin' }, { workspaceId: workspace!._id, userId: member!._id, role: 'member' }, { workspaceId: other!._id, userId: outsider!._id, role: 'owner' }]);
  const tokens = Object.fromEntries(await Promise.all([owner!,admin!,member!,outsider!].map(async (u) => [u.name, (await issueTokens(u.id)).accessToken])));
  const startChild = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', childFile], { env: { ...process.env, NODE_ENV: 'test', REALTIME_COORDINATION: 'redis', REDIS_URL: redisUrl, REDIS_KEY_PREFIX: prefix, MONGODB_URI: mongo!.getUri(), AUTOMATION_ENCRYPTION_KEYS: JSON.stringify({ '1': 'ab'.repeat(32) }), AUTOMATION_KEY_VERSION: '1' }, stdio: ['ignore','inherit','inherit','ipc'] }); children.push(child); return waitFor(child, 'message', (value) => value?.type === 'ready' ? value.port as number : undefined, 30000);
  };
  const [portA, portB] = await Promise.all([startChild(), startChild()]);
  const memberA = await connect(portA, tokens.member); const ownerB = await connect(portB, tokens.owner); const adminB = await connect(portB, tokens.admin); const memberB = await connect(portB, tokens.member); const outsiderB = await connect(portB, tokens.outsider);
  await Promise.all([join(memberA, workspace!.id), join(ownerB, workspace!.id), join(adminB, workspace!.id), join(memberB, workspace!.id), join(outsiderB, other!.id)]);
  await join(outsiderB, workspace!.id, false); checks++;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const source = children[0]!; const base = { workspaceId: workspace!.id, actorId: owner!.id, entityId: new mongoose.Types.ObjectId().toString() };
  for (const eventType of ['change.releaseCreated','change.deploymentUpdated','change.riskEvaluated','change.healthUpdated','change.correlationUpdated','change.queueChanged']) {
    let localCount = 0; let remoteCount = 0; const localListener = () => localCount++; const remoteListener = () => remoteCount++; memberA.on(eventType, localListener); memberB.on(eventType, remoteListener);
    await command(source, { type: 'publish', eventType, ...base }); await new Promise((resolve) => setTimeout(resolve, 500));
    memberA.off(eventType, localListener); memberB.off(eventType, remoteListener); assert.equal(localCount, 1); assert.equal(remoteCount, 1); checks++;
    await noEvent(outsiderB, eventType, async () => command(source, { type: 'publish', eventType, ...base }));
  }
  for (const eventType of ['change.approvalRequested','change.approvalUpdated']) {
    const eligibleRoles = ['owner','admin','member'];
    await oneEvent(ownerB, eventType, () => command(source, { type: 'restricted', eventType, roles: eligibleRoles, ...base }));
    await oneEvent(adminB, eventType, () => command(source, { type: 'restricted', eventType, roles: eligibleRoles, ...base }));
    await oneEvent(memberB, eventType, () => command(source, { type: 'restricted', eventType, roles: eligibleRoles, ...base }));
  }
  await oneEvent(ownerB, 'change.policyActivated', () => command(source, { type: 'restricted', eventType: 'change.policyActivated', ...base }));
  await oneEvent(adminB, 'change.policyActivated', () => command(source, { type: 'restricted', eventType: 'change.policyActivated', ...base }));
  await noEvent(memberB, 'change.policyActivated', async () => command(source, { type: 'restricted', eventType: 'change.policyActivated', ...base }));
  const reconnectToken = tokens.member; memberB.disconnect(); const reconnected = await connect(portB, reconnectToken); await join(reconnected, workspace!.id); await oneEvent(reconnected, 'change.queueChanged', () => command(source, { type: 'publish', eventType: 'change.queueChanged', ...base }));
  const rest = await fetch(`http://127.0.0.1:${portB}/api/workspaces/${workspace!.id}/changes/releases`, { headers: { cookie: `accessToken=${reconnectToken}` } }); assert.equal(rest.status, 200); checks++;
  const duplicateHint = { eventId: randomUUID(), timestamp: new Date().toISOString(), type: 'change.riskEvaluated', ...base, payload: {} };
  let duplicateCount = 0; reconnected.on('change.riskEvaluated', () => duplicateCount++); await redis.publish(`${prefix}:automation:hints:v1`, JSON.stringify(duplicateHint)); await redis.publish(`${prefix}:automation:hints:v1`, JSON.stringify(duplicateHint)); await new Promise((r) => setTimeout(r, 500)); assert.equal(duplicateCount, 1); checks++;
  await WorkspaceMemberModel.updateOne({ workspaceId: workspace!._id, userId: member!._id }, { disabled: true }); await command(source, { type: 'authorization', change: { kind: 'membership', workspaceId: workspace!.id, userId: member!.id } }); await new Promise((r) => setTimeout(r, 300)); await noEvent(reconnected, 'change.releaseCreated', () => command(source, { type: 'publish', eventType: 'change.releaseCreated', ...base }));
  await WorkspaceMemberModel.updateOne({ workspaceId: workspace!._id, userId: member!._id }, { disabled: false }); const removedSocket = await connect(portB, reconnectToken); await join(removedSocket, workspace!.id); await WorkspaceMemberModel.deleteOne({ workspaceId: workspace!._id, userId: member!._id }); await command(source, { type: 'authorization', change: { kind: 'membership', workspaceId: workspace!.id, userId: member!.id } }); await new Promise((r) => setTimeout(r, 300)); await noEvent(removedSocket, 'change.releaseCreated', () => command(source, { type: 'publish', eventType: 'change.releaseCreated', ...base }));
  const disconnected = waitFor(ownerB, 'disconnect', () => true); await command(children[1]!, { type: 'fail' }); await disconnected; checks++;
  console.log(JSON.stringify({ redisClusterTests: checks, events: 9, processes: 2, adapter: '@socket.io/redis-adapter' }));
} finally {
  sockets.forEach((socket) => socket.disconnect());
  for (const child of children) { if (child.connected) await command(child, { type: 'stop' }).catch(() => undefined); child.kill(); }
  if (redis) { let cursor = '0'; do { const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100); cursor = next; if (keys.length) await redis.unlink(...keys); } while (cursor !== '0'); await redis.quit().catch(() => redis!.disconnect()); }
  await mongoose.disconnect(); if (mongo) await mongo.stop();
}
