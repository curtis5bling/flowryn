import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { socketPayloadSchemas, type RealtimeEvent, type SocketAcknowledgement, type SocketRequest } from '@flowryn/shared';
import { parse } from 'cookie';
import { Server, type Socket } from 'socket.io';

import { onAuthorizationChange, type Change } from '../auth/revocation.js';
import { authenticateAccessToken } from '../auth/tokens.js';
import { ProjectModel } from '../models/Project.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

import { type Coordination, coordinationLog, createMemoryCoordination, heartbeatMs, type PresenceState } from './coordination.js';

const workspaceRoom = (id: string) => `workspace:${id}`;
const projectRoom = (workspaceId: string, id: string) => `workspace:${workspaceId}:project:${id}`;
let io: Server | undefined;
const coordinators = new WeakMap<Server, Coordination>();
export const realtimeAvailable = () => Boolean(io && coordinators.get(io)?.available);
type EventInput = Omit<RealtimeEvent, 'eventId' | 'timestamp'>;
const envelope = (event: EventInput): RealtimeEvent => ({ ...event, eventId: randomUUID(), timestamp: new Date().toISOString() });
const audiences: Record<Exclude<RealtimeEvent['type'], 'notification.created'>, 'workspace' | 'project'> = {
  'project.created': 'workspace', 'project.updated': 'workspace', 'project.archived': 'workspace', 'presence.updated': 'workspace',
  'task.created': 'project', 'task.updated': 'project', 'task.moved': 'project', 'task.reordered': 'project', 'task.assigned': 'project', 'task.deleted': 'project',
  'comment.created': 'project', 'comment.updated': 'project', 'comment.deleted': 'project',
};

export const publishRealtimeEvent = (event: EventInput & { type: Exclude<RealtimeEvent['type'], 'notification.created'> }) => {
  const message = envelope(event);
  if (io && !coordinators.get(io)?.available) return message;
  const audience = audiences[event.type];
  if (audience === 'project' && !event.projectId) throw new Error('Project audience requires a project');
  io?.to(audience === 'workspace' ? workspaceRoom(event.workspaceId) : projectRoom(event.workspaceId, event.projectId!)).emit(event.type, message);
  return message;
};

export const publishNotification = (recipientId: string, event: EventInput) => {
  const message = envelope({ ...event, type: 'notification.created' });
  if (io && !coordinators.get(io)?.available) return message;
  io?.to(`user:${recipientId}`).emit('notification.created', message);
  return message;
};

export const getPresenceState = async (workspaceId: string, server = io): Promise<PresenceState> => server
  ? coordinators.get(server)!.presence(workspaceId) : { users: [], lastSeen: {} };
export const getPresence = async (workspaceId: string, server = io) => (await getPresenceState(workspaceId, server)).users;

export const scheduleExpiration = (expiresAt: number, disconnect: () => void) => {
  const timer = setTimeout(disconnect, Math.max(0, Math.min(expiresAt - Date.now(), 2 ** 31 - 1)));
  timer.unref?.();
  return () => clearTimeout(timer);
};

const denied = (): SocketAcknowledgement => ({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Access denied' } });
const activeMembership = (workspaceId: string, userId: string) => WorkspaceMemberModel.exists({ workspaceId, userId, disabled: { $ne: true } });

export const createRealtimeGateway = (server: HttpServer, allowedOrigins: string[], coordination = createMemoryCoordination(), subscribeChanges = onAuthorizationChange) => {
  const socketServer = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true },
    allowRequest: (request, callback) => callback(null, !request.headers.origin || allowedOrigins.includes(request.headers.origin)),
  });
  io = socketServer;
  coordinators.set(socketServer, coordination);
  if (coordination.adapter) socketServer.adapter(coordination.adapter);
  socketServer.of('/').adapter.on('error', () => { coordinationLog('socket_adapter_error'); coordination.fail(); });
  const tokens = new WeakMap<Socket, string>();
  // A revision prevents an in-flight join from restoring access after eviction.
  let authorizationRevision = 0;
  const syncPresence = () => coordination.writePresence([...socketServer.sockets.sockets.values()].flatMap((socket) =>
    [...socket.rooms].filter((room) => /^workspace:[a-f\d]{24}$/i.test(room)).map((room) => ({ workspaceId: room.slice(10), userId: String(socket.data.userId) }))),
  );
  const announcePresence = async (workspaceId: string, userId: string) => {
    await syncPresence();
    const presence = await coordination.presence(workspaceId);
    const online = presence.users.includes(userId);
    const message = envelope({ type: 'presence.updated', workspaceId, actorId: userId, payload: { userId, online, lastSeen: online ? null : presence.lastSeen[userId] ?? null } });
    if (coordination.available) socketServer.to(workspaceRoom(workspaceId)).emit('presence.updated', message);
  };
  const leaveWorkspace = (socket: Socket, workspaceId: string) => {
    const joined = socket.rooms.has(workspaceRoom(workspaceId));
    for (const room of [...socket.rooms]) {
      if (room === workspaceRoom(workspaceId) || room.startsWith(`${workspaceRoom(workspaceId)}:project:`)) void socket.leave(room);
    }
    if (joined) void announcePresence(workspaceId, socket.data.userId).catch(() => coordination.fail());
  };
  const applyChange = async (change: Change) => {
    authorizationRevision++;
    const sockets = [...socketServer.sockets.sockets.values()].filter((socket) => socket.data.userId === change.userId);
    try {
      if (change.kind === 'session') {
        sockets.filter((socket) => socket.data.tokenId === change.tokenId).forEach((socket) => socket.disconnect(true));
      } else if (change.kind === 'user') {
        const active = await UserModel.exists({ _id: change.userId, status: 'active' });
        if (!active) sockets.forEach((socket) => socket.disconnect(true));
      } else if (change.workspaceId && !await activeMembership(change.workspaceId, change.userId)) {
        sockets.forEach((socket) => leaveWorkspace(socket, change.workspaceId!));
      }
    } catch {
      // A failed authorization lookup must not preserve an existing subscription.
      sockets.forEach((socket) => socket.disconnect(true));
    }
    if (coordination.available) await syncPresence();
  };
  const unsubscribe = subscribeChanges(async (change) => {
    await applyChange(change);
    await coordination.publish(change);
  });
  const unsubscribeRemote = coordination.onChange(applyChange);
  const unsubscribeHealth = coordination.onHealth((healthy) => {
    authorizationRevision++;
    if (!healthy) socketServer.local.disconnectSockets(true);
  });
  // Reconcile against MongoDB even if a Pub/Sub message was lost in a partition.
  let checking = false;
  const heartbeat = setInterval(() => {
    if (checking || !coordination.available) return;
    checking = true;
    const deadline = setTimeout(() => coordination.fail(), heartbeatMs);
    void (async () => {
      for (const socket of socketServer.sockets.sockets.values()) {
        try { await authenticateAccessToken(tokens.get(socket)!); }
        catch { socket.disconnect(true); continue; }
        const workspaces = new Set([...socket.rooms].filter((room) => room.startsWith('workspace:')).map((room) => room.slice(10, 34)));
        for (const workspace of workspaces) if (!await activeMembership(workspace, socket.data.userId)) {
          authorizationRevision++;
          leaveWorkspace(socket, workspace);
        }
      }
      await syncPresence();
    })().catch(() => { coordination.fail(); }).finally(() => { clearTimeout(deadline); checking = false; });
  }, heartbeatMs);
  heartbeat.unref();
  server.once('close', () => {
    clearInterval(heartbeat); unsubscribe(); unsubscribeRemote(); unsubscribeHealth();
    void coordination.close().catch(() => coordinationLog('coordination_shutdown_failed'));
    if (io === socketServer) io = undefined;
  });
  socketServer.use(async (socket, next) => {
    try {
      const revision = authorizationRevision;
      coordination.assertAvailable();
      const token = parse(socket.handshake.headers.cookie ?? '').accessToken ?? socket.handshake.auth?.token;
      if (typeof token !== 'string') return next(new Error('Authentication required'));
      const { user, payload } = await authenticateAccessToken(token);
      if (revision !== authorizationRevision || payload.exp! * 1000 <= Date.now()) return next(new Error('Authentication required'));
      socket.data.userId = user.id;
      tokens.set(socket, token);
      socket.data.tokenId = payload.jti;
      socket.data.expiresAt = payload.exp! * 1000;
      next();
    } catch {
      next(coordination.available ? new Error('Authentication required')
        : Object.assign(new Error('Real-time temporarily unavailable'), { data: { code: 'UNAVAILABLE' } }));
    }
  });
  socketServer.on('connection', (socket) => {
    const cancelExpiration = scheduleExpiration(socket.data.expiresAt, () => socket.disconnect(true));
    void socket.join(`user:${socket.data.userId}`);
    const handle = (name: SocketRequest, action: (id: string, revision: number) => Promise<SocketAcknowledgement>) => {
      socket.on(name, (input: unknown, callback: unknown) => {
        const acknowledge = (result: SocketAcknowledgement) => { if (typeof callback === 'function') callback(result); };
        void (async () => {
          const parsed = socketPayloadSchemas[name].safeParse(input);
          if (!parsed.success) return acknowledge({ ok: false, error: { code: 'INVALID_PAYLOAD', message: 'Invalid request' } });
          const revision = authorizationRevision;
          coordination.assertAvailable();
          try { await authenticateAccessToken(tokens.get(socket)!); }
          catch { acknowledge(denied()); socket.disconnect(true); return; }
          acknowledge(await action(parsed.data, revision));
        })().catch(() => acknowledge({ ok: false, error: { code: 'UNAVAILABLE', message: 'Request unavailable' } }));
      });
    };
    const stillAuthorized = (revision: number) => coordination.available && socket.connected && revision === authorizationRevision && Date.now() < socket.data.expiresAt;
    handle('workspace:join', async (id, revision) => {
      if (!await activeMembership(id, socket.data.userId) || !stillAuthorized(revision)) return denied();
      const alreadyJoined = socket.rooms.has(workspaceRoom(id));
      void socket.join(workspaceRoom(id));
      if (!alreadyJoined) await announcePresence(id, socket.data.userId);
      return stillAuthorized(revision) ? { ok: true } : denied();
    });
    handle('workspace:leave', async (id) => { leaveWorkspace(socket, id); return { ok: true }; });
    handle('project:join', async (id, revision) => {
      const project = await ProjectModel.findById(id).select('workspaceId');
      if (!project || !await activeMembership(String(project.workspaceId), socket.data.userId) || !stillAuthorized(revision)) return denied();
      void socket.join(projectRoom(String(project.workspaceId), id));
      return { ok: true };
    });
    handle('project:leave', async (id) => {
      for (const room of socket.rooms) if (room.endsWith(`:project:${id}`)) void socket.leave(room);
      return { ok: true };
    });
    handle('presence:list', async (id, revision) => {
      if (!await activeMembership(id, socket.data.userId) || !stillAuthorized(revision)) return denied();
      const users = await getPresence(id, socketServer);
      return stillAuthorized(revision) ? { ok: true, users } : denied();
    });
    socket.on('disconnecting', () => {
      cancelExpiration();
      for (const room of [...socket.rooms]) if (/^workspace:[a-f\d]{24}$/i.test(room)) leaveWorkspace(socket, room.slice(10));
    });
  });
  return socketServer;
};
