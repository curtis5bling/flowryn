import { createServer } from 'node:http';

import type { SocketAcknowledgement, SocketRequest } from '@flowryn/shared';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { issueTokens, revokeRefreshToken, verifyAccessToken } from './auth/tokens.js';
import { AuthSessionModel } from './models/AuthSession.js';
import { ProjectModel } from './models/Project.js';
import { UserModel } from './models/User.js';
import { WorkspaceModel } from './models/Workspace.js';
import { WorkspaceMemberModel } from './models/WorkspaceMember.js';
import { createRealtimeGateway, getPresence, publishNotification, publishRealtimeEvent, scheduleExpiration } from './realtime/gateway.js';

const app = createApp();
const server = createServer(app);
const gateway = createRealtimeGateway(server, ['http://localhost:5173']);
const sockets: Socket[] = [];
let mongo: MongoMemoryServer;
let url: string;
const once = (socket: Socket, event: string) => new Promise<unknown>((resolve) => socket.once(event, resolve));
const ack = (socket: Socket, event: SocketRequest, payload: unknown) => new Promise<SocketAcknowledgement>((resolve, reject) => {
  socket.timeout(2000).emit(event, payload, (error: Error | null, result: SocketAcknowledgement) => error ? reject(error) : resolve(result));
});
const client = async (token?: string, accepted = true) => {
  const socket = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, autoConnect: false });
  sockets.push(socket);
  const ready = once(socket, accepted ? 'connect' : 'connect_error');
  socket.connect();
  await ready;
  return socket;
};
const fixture = async () => {
  const [owner, member, outsider] = await UserModel.create([
    { name: 'Owner', email: 'owner@test.dev', passwordHash: 'unused' },
    { name: 'Member', email: 'member@test.dev', passwordHash: 'unused' },
    { name: 'Outsider', email: 'outsider@test.dev', passwordHash: 'unused' },
  ]);
  if (!owner || !member || !outsider) throw new Error('Fixture users missing');
  const workspace = await WorkspaceModel.create({ name: 'Workspace', createdBy: owner.id });
  const other = await WorkspaceModel.create({ name: 'Other', createdBy: outsider.id });
  await WorkspaceMemberModel.create([
    { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
    { workspaceId: workspace.id, userId: member.id, role: 'member' },
    { workspaceId: other.id, userId: outsider.id, role: 'owner' },
  ]);
  const project = await ProjectModel.create({ workspaceId: workspace.id, name: 'Project', createdBy: owner.id });
  const tokens = await Promise.all([issueTokens(owner.id), issueTokens(member.id), issueTokens(outsider.id)]);
  return { owner, member, outsider, workspace, other, project, tokens };
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 180000);
beforeEach(async () => { await mongoose.connection.dropDatabase(); });
afterEach(() => { sockets.splice(0).forEach((socket) => socket.disconnect()); vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  await mongoose.disconnect();
  await mongo.stop();
});

describe('collaboration boundaries', () => {
  it('accepts cookie sessions and rejects missing, invalid, expired and suspended credentials', async () => {
    const f = await fixture();
    const valid = await client(f.tokens[0].accessToken);
    expect(valid.connected).toBe(true);
    expect((await client(undefined, false)).connected).toBe(false);
    expect((await client('invalid', false)).connected).toBe(false);
    const payload = verifyAccessToken(f.tokens[0].accessToken);
    const expired = jwt.sign({ sub: payload.sub, jti: payload.jti, type: 'access', exp: 1 }, process.env.JWT_SECRET ?? 'flowryn-development-secret-change-me');
    expect((await client(expired, false)).connected).toBe(false);
    await UserModel.updateOne({ _id: f.member.id }, { status: 'suspended' });
    expect((await client(f.tokens[1].accessToken, false)).connected).toBe(false);
    const cookieClient = connect(url, { extraHeaders: { Cookie: `accessToken=${f.tokens[0].accessToken}` }, transports: ['websocket'], autoConnect: false });
    sockets.push(cookieClient);
    const ready = once(cookieClient, 'connect');
    cookieClient.connect();
    await ready;
    expect(cookieClient.connected).toBe(true);
  });

  it('delivers a private notification once, never to other workspace/project subscribers', async () => {
    const f = await fixture();
    const clients = await Promise.all(f.tokens.map((tokens) => client(tokens.accessToken)));
    for (const socket of clients.slice(0, 2)) {
      expect(await ack(socket, 'workspace:join', f.workspace.id)).toEqual({ ok: true });
      expect(await ack(socket, 'project:join', f.project.id)).toEqual({ ok: true });
    }
    const received = clients.map(() => vi.fn());
    clients.forEach((socket, index) => socket.on('notification.created', received[index]!));
    const delivered = once(clients[1]!, 'notification.created');
    const event = publishNotification(f.member.id, { workspaceId: f.workspace.id, projectId: f.project.id, actorId: f.owner.id, type: 'notification.created', payload: { title: 'Private', notificationId: f.project.id } });
    expect(await delivered).toEqual(event);
    // An acknowledgement on each transport acts as a barrier after queued events.
    await Promise.all(clients.map((socket) => ack(socket, 'presence:list', f.workspace.id)));
    expect(received[0]).not.toHaveBeenCalled();
    expect(received[1]).toHaveBeenCalledTimes(1);
    expect(received[2]).not.toHaveBeenCalled();
  });

  it('routes project creation to workspace members and tasks/comments only to the authorized project', async () => {
    const f = await fixture();
    const owner = await client(f.tokens[0].accessToken);
    const member = await client(f.tokens[1].accessToken);
    const outsider = await client(f.tokens[2].accessToken);
    await ack(owner, 'workspace:join', f.workspace.id);
    await ack(member, 'workspace:join', f.workspace.id);
    await ack(member, 'project:join', f.project.id);
    await ack(outsider, 'workspace:join', f.other.id);
    expect((await ack(outsider, 'workspace:join', f.workspace.id)).ok).toBe(false);
    expect((await ack(outsider, 'project:join', f.project.id)).ok).toBe(false);
    const leaked = vi.fn();
    outsider.onAny(leaked);
    const created = once(member, 'project.created');
    const response = await request(app).post(`/api/workspaces/${f.workspace.id}/projects`).set('Authorization', `Bearer ${f.tokens[0].accessToken}`).send({ name: 'New project' });
    expect(response.status).toBe(201);
    expect(await created).toMatchObject({ type: 'project.created', entityId: response.body.project.id });
    const ownerTask = vi.fn();
    owner.on('task.created', ownerTask);
    for (const type of ['task.created', 'comment.created'] as const) {
      const delivered = once(member, type);
      publishRealtimeEvent({ type, workspaceId: f.workspace.id, projectId: f.project.id, actorId: f.owner.id, payload: { safe: true } });
      expect(await delivered).toMatchObject({ type });
    }
    await ack(outsider, 'presence:list', f.other.id);
    await ack(owner, 'presence:list', f.workspace.id);
    expect(leaked).not.toHaveBeenCalled();
    expect(ownerTask).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads for every handler and sanitizes async database failures', async () => {
    const f = await fixture();
    const socket = await client(f.tokens[0].accessToken);
    for (const event of ['workspace:join', 'workspace:leave', 'project:join', 'project:leave', 'presence:list'] as const) {
      for (const value of ['bad-id', { $ne: null }, null, 123]) {
        expect(await ack(socket, event, value)).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
      }
    }
    vi.spyOn(WorkspaceMemberModel, 'exists').mockRejectedValueOnce(new Error('secret database connection string'));
    expect(await ack(socket, 'workspace:join', f.workspace.id)).toEqual({ ok: false, error: { code: 'UNAVAILABLE', message: 'Request unavailable' } });
    expect(await ack(socket, 'workspace:join', f.workspace.id)).toEqual({ ok: true });
    expect(socket.connected).toBe(true);
  });

  it('disconnects all tabs and invalidates sessions immediately when a user is suspended', async () => {
    const f = await fixture();
    const tabs = await Promise.all([client(f.tokens[1].accessToken), client(f.tokens[1].accessToken)]);
    await Promise.all(tabs.map((socket) => ack(socket, 'workspace:join', f.workspace.id)));
    const disconnected = tabs.map((socket) => once(socket, 'disconnect'));
    await UserModel.findOneAndUpdate({ _id: f.member.id }, { status: 'suspended' });
    await Promise.all(disconnected);
    expect(await getPresence(f.workspace.id)).not.toContain(f.member.id);
    expect(await AuthSessionModel.countDocuments({ userId: f.member.id, revokedAt: null })).toBe(0);
  });

  it.each(['delete', 'disable'] as const)('evicts every tab from workspace and project rooms on membership %s', async (operation) => {
    const f = await fixture();
    const tabs = await Promise.all([client(f.tokens[1].accessToken), client(f.tokens[1].accessToken)]);
    await Promise.all(tabs.map(async (socket) => { await ack(socket, 'workspace:join', f.workspace.id); await ack(socket, 'project:join', f.project.id); }));
    expect(await getPresence(f.workspace.id)).toEqual([f.member.id]);
    if (operation === 'delete') await WorkspaceMemberModel.deleteOne({ userId: f.member.id, workspaceId: f.workspace.id });
    else await WorkspaceMemberModel.updateOne({ userId: f.member.id, workspaceId: f.workspace.id }, { disabled: true });
    expect(await getPresence(f.workspace.id)).toEqual([]);
    for (const socket of tabs) {
      expect([...gateway.sockets.sockets.get(socket.id!)!.rooms].some((room) => room.startsWith('workspace:'))).toBe(false);
      expect((await ack(socket, 'project:join', f.project.id)).ok).toBe(false);
    }
  });

  it('keeps a member online until their last tab disconnects and restores presence on reconnect', async () => {
    const f = await fixture();
    const first = await client(f.tokens[1].accessToken);
    const second = await client(f.tokens[1].accessToken);
    await ack(first, 'workspace:join', f.workspace.id);
    await ack(second, 'workspace:join', f.workspace.id);
    expect(await getPresence(f.workspace.id)).toEqual([f.member.id]);
    gateway.sockets.sockets.get(first.id!)!.disconnect(true);
    expect(await getPresence(f.workspace.id)).toEqual([f.member.id]);
    gateway.sockets.sockets.get(second.id!)!.disconnect(true);
    expect(await getPresence(f.workspace.id)).toEqual([]);
    const reconnected = await client(f.tokens[1].accessToken);
    await ack(reconnected, 'workspace:join', f.workspace.id);
    expect(await getPresence(f.workspace.id)).toEqual([f.member.id]);
  });

  it('does not let an in-flight room join restore membership after revocation', async () => {
    const f = await fixture();
    const socket = await client(f.tokens[1].accessToken);
    let release!: (value: { _id: mongoose.Types.ObjectId }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(WorkspaceMemberModel, 'exists').mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { release = resolve; }) as ReturnType<typeof WorkspaceMemberModel.exists>;
    });
    const joining = ack(socket, 'workspace:join', f.workspace.id);
    await started;
    await WorkspaceMemberModel.deleteOne({ userId: f.member.id, workspaceId: f.workspace.id });
    release({ _id: new mongoose.Types.ObjectId() });
    expect((await joining).ok).toBe(false);
    expect(await getPresence(f.workspace.id)).not.toContain(f.member.id);
  });

  it('disconnects a revoked session and rejects subsequent socket handshakes', async () => {
    const f = await fixture();
    const socket = await client(f.tokens[0].accessToken);
    const disconnected = once(socket, 'disconnect');
    await revokeRefreshToken(f.tokens[0].refreshToken);
    await disconnected;
    expect((await client(f.tokens[0].accessToken, false)).connected).toBe(false);
  });

  it('expires a connected socket at its signed token deadline', async () => {
    const f = await fixture();
    const payload = verifyAccessToken(f.tokens[0].accessToken);
    const token = jwt.sign({ sub: payload.sub, jti: payload.jti, type: 'access', exp: Math.floor(Date.now() / 1000) + 2 }, process.env.JWT_SECRET ?? 'flowryn-development-secret-change-me');
    const socket = await client(token);
    await once(socket, 'disconnect');
    expect(socket.connected).toBe(false);
  });

  it('uses a cancellable deadline timer without extending token life', () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    scheduleExpiration(Date.now() + 1000, disconnect);
    vi.advanceTimersByTime(999);
    expect(disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    const cancel = scheduleExpiration(Date.now() + 1000, disconnect);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('enforces comment ownership/moderation, tenant isolation, and notification ownership/counts through REST', async () => {
    const f = await fixture();
    const base = `/api/workspaces/${f.workspace.id}`;
    const ownerHeader = `Bearer ${f.tokens[0].accessToken}`;
    const memberHeader = `Bearer ${f.tokens[1].accessToken}`;
    const outsiderHeader = `Bearer ${f.tokens[2].accessToken}`;
    const taskResponse = await request(app).post(`${base}/projects/${f.project.id}/tasks`).set('Authorization', ownerHeader).send({ title: 'Assigned task', assigneeId: f.member.id });
    expect(taskResponse.status).toBe(201);
    const taskId = taskResponse.body.task.id as string;
    const comments = `${base}/projects/${f.project.id}/tasks/${taskId}/comments`;
    const created = await request(app).post(comments).set('Authorization', ownerHeader).send({ body: 'Owner comment' });
    expect(created.status).toBe(201);
    const commentUrl = `${base}/comments/${created.body.comment.id}`;
    expect((await request(app).patch(commentUrl).set('Authorization', memberHeader).send({ body: 'Not mine' })).status).toBe(403);
    expect((await request(app).delete(commentUrl).set('Authorization', memberHeader)).status).toBe(403);
    expect((await request(app).get(comments).set('Authorization', outsiderHeader)).status).toBe(403);
    expect((await request(app).get(comments.replace(f.workspace.id, f.other.id)).set('Authorization', outsiderHeader)).status).toBe(404);
    expect((await request(app).get(`${comments}?page=bad`).set('Authorization', ownerHeader)).status).toBe(400);
    expect((await request(app).patch(commentUrl).set('Authorization', ownerHeader).send({ body: 'Edited' })).status).toBe(200);
    const own = await request(app).post(comments).set('Authorization', memberHeader).send({ body: 'My comment' });
    expect((await request(app).patch(`${base}/comments/${own.body.comment.id}`).set('Authorization', memberHeader).send({ body: 'My edit' })).status).toBe(200);
    expect((await request(app).delete(`${base}/comments/${own.body.comment.id}`).set('Authorization', ownerHeader)).status).toBe(204);
    const list = await request(app).get(`${base}/notifications`).set('Authorization', memberHeader);
    expect(list.body.items).toHaveLength(2);
    expect((await request(app).get(`${base}/notifications`).set('Authorization', ownerHeader)).body.items).toEqual([]);
    const notificationId = list.body.items[0].id;
    expect((await request(app).patch(`${base}/notifications/${notificationId}/read`).set('Authorization', ownerHeader)).status).toBe(404);
    expect((await request(app).get(`${base}/notifications/unread-count`).set('Authorization', memberHeader)).body.count).toBe(2);
    expect((await request(app).patch(`${base}/notifications/${notificationId}/read`).set('Authorization', memberHeader)).status).toBe(200);
    expect((await request(app).get(`${base}/notifications?unread=false`).set('Authorization', memberHeader)).body.items).toHaveLength(2);
    expect((await request(app).get(`${base}/notifications?unread=true`).set('Authorization', memberHeader)).body.items).toHaveLength(1);
    await request(app).post(`${base}/notifications/read-all`).set('Authorization', memberHeader);
    expect((await request(app).get(`${base}/notifications/unread-count`).set('Authorization', memberHeader)).body.count).toBe(0);
    await request(app).patch(`${base}/tasks/${taskId}`).set('Authorization', ownerHeader).send({ status: 'done' });
    await request(app).delete(`${base}/projects/${f.project.id}`).set('Authorization', ownerHeader);
    expect((await request(app).get(`${base}/notifications/unread-count`).set('Authorization', memberHeader)).body.count).toBe(2);
    await WorkspaceMemberModel.updateOne({ workspaceId: f.workspace.id, userId: f.member.id }, { disabled: true });
    expect((await request(app).get(`${base}/notifications`).set('Authorization', memberHeader)).status).toBe(403);
  });
});
