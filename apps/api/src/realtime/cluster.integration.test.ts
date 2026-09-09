import { createServer, type Server as HttpServer } from 'node:http';

import type { SocketAcknowledgement } from '@flowryn/shared';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { issueTokens, revokeRefreshToken } from '../auth/tokens.js';
import { ProjectModel } from '../models/Project.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

import { Coordination, MemoryCoordinationNetwork } from './coordination.js';
import { createRealtimeGateway, getPresence } from './gateway.js';

let mongo: MongoMemoryServer;
let gateways: Server[];
let servers: HttpServer[];
let coordinators: Coordination[];
let transports: Array<ReturnType<MemoryCoordinationNetwork['connect']>>;
const clients: Socket[] = [];
const workspaceId = 'a'.repeat(24);
const otherWorkspaceId = 'c'.repeat(24);
const waitEvent = (socket: Socket, name: string) => new Promise<void>((resolve) => socket.once(name, () => resolve()));
const join = (socket: Socket, event: string, id: string) => new Promise<SocketAcknowledgement>((resolve, reject) => socket.timeout(2000).emit(event, id, (error: Error | null, result: SocketAcknowledgement) => error ? reject(error) : resolve(result)));
const connect = async (index: number, token: string, accepted = true) => {
  const port = (servers[index]!.address() as { port: number }).port;
  const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], auth: { token }, reconnection: false, autoConnect: false });
  clients.push(socket);
  const ready = waitEvent(socket, accepted ? 'connect' : 'connect_error'); socket.connect(); await ready;
  return socket;
};
const fixture = async () => {
  const user = await UserModel.create({ name: 'Cluster member', email: 'cluster@test.dev', passwordHash: 'unused' });
  await WorkspaceMemberModel.create({ workspaceId, userId: user.id, role: 'member' });
  const project = await ProjectModel.create({ workspaceId, name: 'Cluster project', createdBy: user.id });
  const tokens = await issueTokens(user.id);
  return { user, project, tokens };
};
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); }, 180000);
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  const network = new MemoryCoordinationNetwork();
  transports = [network.connect(), network.connect()];
  coordinators = transports.map((transport) => new Coordination(transport));
  servers = [createServer(), createServer()];
  gateways = [
    createRealtimeGateway(servers[0]!, [], coordinators[0]),
    // Simulate a separate process: B cannot see A's in-process mutation bus.
    createRealtimeGateway(servers[1]!, [], coordinators[1], () => () => {}),
  ];
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))));
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.disconnect());
  await Promise.all(gateways.map((gateway) => new Promise<void>((resolve) => gateway.close(() => resolve()))));
  await Promise.all(coordinators.map((coordinator) => coordinator.close()));
  vi.restoreAllMocks();
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

it('propagates suspension and session revocation to the other process', async () => {
  const f = await fixture();
  const a = await connect(0, f.tokens.accessToken);
  const b = await connect(1, f.tokens.accessToken);
  const gone = [waitEvent(a, 'disconnect'), waitEvent(b, 'disconnect')];
  await UserModel.updateOne({ _id: f.user.id }, { status: 'suspended' });
  await Promise.all(gone);
  await UserModel.updateOne({ _id: f.user.id }, { status: 'active' });
  const tokens = await issueTokens(f.user.id);
  const sessionClient = await connect(1, tokens.accessToken);
  const revoked = waitEvent(sessionClient, 'disconnect');
  await revokeRefreshToken(tokens.refreshToken);
  await revoked;
});

it('evicts workspace and project rooms remotely without disturbing other workspaces', async () => {
  const f = await fixture();
  await WorkspaceMemberModel.create({ workspaceId: otherWorkspaceId, userId: f.user.id, role: 'member' });
  const b = await connect(1, f.tokens.accessToken);
  expect((await join(b, 'workspace:join', workspaceId)).ok).toBe(true);
  expect((await join(b, 'project:join', f.project.id)).ok).toBe(true);
  expect((await join(b, 'workspace:join', otherWorkspaceId)).ok).toBe(true);
  await WorkspaceMemberModel.deleteOne({ workspaceId, userId: f.user.id });
  await vi.waitFor(() => {
    const rooms = gateways[1]!.sockets.sockets.get(b.id!)!.rooms;
    expect([...rooms].some((room) => room.startsWith(`workspace:${workspaceId}`))).toBe(false);
    expect(rooms.has(`workspace:${otherWorkspaceId}`)).toBe(true);
  });
  expect((await join(b, 'project:join', f.project.id)).ok).toBe(false);
});

it('deduplicates distributed presence and retains online state until the last device leaves', async () => {
  const f = await fixture();
  const a = await connect(0, f.tokens.accessToken);
  const b = await connect(1, f.tokens.accessToken);
  await join(a, 'workspace:join', workspaceId); await join(b, 'workspace:join', workspaceId);
  expect(await getPresence(workspaceId, gateways[0])).toEqual([f.user.id]);
  expect(await getPresence(workspaceId, gateways[1])).toEqual([f.user.id]);
  gateways[0]!.sockets.sockets.get(a.id!)!.disconnect(true);
  expect(await getPresence(workspaceId, gateways[0])).toEqual([f.user.id]);
  gateways[1]!.sockets.sockets.get(b.id!)!.disconnect(true);
  expect(await getPresence(workspaceId, gateways[1])).toEqual([]);
});

it('disconnects partitioned instances, rejects joins while unhealthy, and reauthorizes after recovery', async () => {
  const f = await fixture();
  const b = await connect(1, f.tokens.accessToken);
  await join(b, 'workspace:join', workspaceId);
  const gone = waitEvent(b, 'disconnect');
  transports[1]!.setAvailable(false); await gone;
  expect((await connect(1, f.tokens.accessToken, false)).connected).toBe(false);
  await WorkspaceMemberModel.updateOne({ workspaceId, userId: f.user.id }, { disabled: true });
  transports[1]!.setAvailable(true);
  const recovered = await connect(1, f.tokens.accessToken);
  expect((await join(recovered, 'workspace:join', workspaceId)).ok).toBe(false);
  await WorkspaceMemberModel.updateOne({ workspaceId, userId: f.user.id }, { disabled: false });
  expect((await join(recovered, 'workspace:join', workspaceId)).ok).toBe(true);
});

it('reconciles a revocation missed when the publisher failed without claiming successful coordination', async () => {
  const f = await fixture();
  const b = await connect(1, f.tokens.accessToken);
  const gone = waitEvent(b, 'disconnect');
  transports[0]!.setAvailable(false);
  await expect(UserModel.updateOne({ _id: f.user.id }, { status: 'suspended' })).rejects.toThrow('Real-time coordination unavailable');
  await gone;
}, 15000);
