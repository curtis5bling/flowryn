import { createServer, type Server as HttpServer } from 'node:http';

import type { SocketAcknowledgement } from '@flowryn/shared';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { issueTokens, revokeRefreshToken, rotateRefreshToken } from '../auth/tokens.js';
import { IncidentModel } from '../models/Incident.js';
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
  await expect(UserModel.updateOne({ _id: f.user.id }, { status: 'suspended' })).rejects.toThrow('Cluster revocation could not be confirmed');
  await gone;
}, 15000);

it('quarantines before delayed reconciliation and delivers no event after acknowledged removal', async () => {
  const f = await fixture();
  await WorkspaceMemberModel.create({ workspaceId: otherWorkspaceId, userId: f.user.id, role: 'member' });
  const b = await connect(1, f.tokens.accessToken);
  await join(b, 'workspace:join', workspaceId);
  await join(b, 'project:join', f.project.id);
  await join(b, 'workspace:join', otherWorkspaceId);
  // B enforcement must not perform an exists query; the origin's decision is trusted.
  const exists = vi.spyOn(WorkspaceMemberModel, 'exists');
  exists.mockResolvedValueOnce(null);
  exists.mockImplementation(() => new Promise(() => {}) as ReturnType<typeof WorkspaceMemberModel.exists>);
  let release!: () => void;
  const removal = new Promise<void>((resolve) => { release = resolve; });
  const leave = vi.spyOn(gateways[1]!.sockets.sockets.get(b.id!)!, 'leave').mockImplementation(() => removal);
  let completed = false;
  const operation = WorkspaceMemberModel.deleteOne({ workspaceId, userId: f.user.id }).then(() => { completed = true; });
  await vi.waitFor(() => expect(leave).toHaveBeenCalled());
  expect(exists).toHaveBeenCalledTimes(1);
  expect(completed).toBe(false);
  const received = vi.fn(); b.on('task.updated', received);
  gateways[1]!.to(`workspace:${workspaceId}:project:${f.project.id}`).emit('task.updated', { protected: true });
  const barrier = waitEvent(b, 'review:barrier');
  gateways[1]!.to(`workspace:${otherWorkspaceId}`).emit('review:barrier');
  await barrier;
  expect(completed).toBe(false);
  release(); await operation;
  gateways[1]!.to(`workspace:${workspaceId}:project:${f.project.id}`).emit('task.updated', { afterRemoval: true });
  const after = waitEvent(b, 'review:after');
  gateways[1]!.to(`workspace:${otherWorkspaceId}`).emit('review:after'); await after;
  expect(received).not.toHaveBeenCalled();
  expect(gateways[1]!.sockets.sockets.get(b.id!)!.rooms.has(`workspace:${otherWorkspaceId}`)).toBe(true);
});

it('retains local membership quarantine after a missing remote acknowledgement', async () => {
  const f = await fixture(); const a = await connect(0, f.tokens.accessToken); const b = await connect(1, f.tokens.accessToken);
  await join(a, 'workspace:join', workspaceId); await join(b, 'workspace:join', workspaceId);
  vi.spyOn(transports[1]!, 'publish').mockResolvedValue(undefined);
  await expect(WorkspaceMemberModel.updateOne({ workspaceId, userId: f.user.id }, { disabled: true })).rejects.toMatchObject({ code: 'REVOCATION_INCOMPLETE' });
  await WorkspaceMemberModel.updateOne({ workspaceId, userId: f.user.id }, { disabled: false });
  expect((await join(a, 'workspace:join', workspaceId)).ok).toBe(false);
  expect(gateways[0]!.sockets.sockets.get(a.id!)!.rooms.has(`workspace:${workspaceId}`)).toBe(false);
}, 10000);

it('allows a new generation after retrying rotation whose old generation remains quarantined', async () => {
  const f = await fixture(); await connect(0, f.tokens.accessToken); await connect(1, f.tokens.accessToken);
  const lostAck = vi.spyOn(transports[1]!, 'publish').mockResolvedValue(undefined);
  await expect(rotateRefreshToken(f.tokens.refreshToken)).rejects.toMatchObject({ code: 'REVOCATION_INCOMPLETE' });
  lostAck.mockRestore();
  const replacement = await rotateRefreshToken(f.tokens.refreshToken);
  expect((await connect(0, replacement.accessToken)).connected).toBe(true);
  expect((await connect(1, replacement.accessToken)).connected).toBe(true);
  await expect(rotateRefreshToken(f.tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
}, 10000);

it('coordinates incident presence and revokes remote incident subscriptions', async () => {
  const f = await fixture();
  const incident = await IncidentModel.create({ workspaceId, incidentNumber: 'INC-000001', title: 'Cluster incident', severity: 'sev2', declaredBy: f.user.id, declaredAt: new Date() });
  const a = await connect(0, f.tokens.accessToken); const b = await connect(1, f.tokens.accessToken);
  expect((await join(a, 'incident:join', incident.id)).ok).toBe(true);
  expect((await join(b, 'incident:join', incident.id)).ok).toBe(true);
  expect(await getPresence(incident.id, gateways[0])).toEqual([f.user.id]);
  gateways[0]!.sockets.sockets.get(a.id!)!.disconnect(true);
  expect(await getPresence(incident.id, gateways[1])).toEqual([f.user.id]);
  await WorkspaceMemberModel.deleteOne({ workspaceId, userId: f.user.id });
  expect(gateways[1]!.sockets.sockets.get(b.id!)!.rooms.has(`workspace:${workspaceId}:incident:${incident.id}`)).toBe(false);
  await vi.waitFor(async () => expect(await getPresence(incident.id, gateways[1])).toEqual([]));
  expect((await join(b, 'incident:join', incident.id)).ok).toBe(false);
});
