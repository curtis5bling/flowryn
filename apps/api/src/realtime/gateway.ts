import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import {
  socketPayloadSchemas,
  type RealtimeEvent,
  type SocketAcknowledgement,
  type SocketRequest,
} from '@flowryn/shared';
import { parse } from 'cookie';
import { Server, type Socket } from 'socket.io';

import { onAuthorizationChange, type Change } from '../auth/revocation.js';
import { authenticateAccessToken } from '../auth/tokens.js';
import type { AutomationHint } from '../automation/hints.js';
import { IncidentModel } from '../models/Incident.js';
import { ProjectModel } from '../models/Project.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

import { reconcileAuthorization, AuthorizationMonitor } from './authorization.js';
import {
  type Coordination,
  coordinationLog,
  createMemoryCoordination,
  heartbeatMs,
  type PresenceState,
} from './coordination.js';

const workspaceRoom = (id: string) => `workspace:${id}`;
const projectRoom = (workspaceId: string, id: string) => `workspace:${workspaceId}:project:${id}`;
let io: Server | undefined;
const coordinators = new WeakMap<Server, Coordination>();
export const realtimeAvailable = () => Boolean(io && coordinators.get(io)?.available);
type EventInput = Omit<RealtimeEvent, 'eventId' | 'timestamp'>;
const envelope = (event: EventInput): RealtimeEvent => ({
  ...event,
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
});
export const relayAutomationHint = async (hint: AutomationHint) => {
  if (!io || !coordinators.get(io)?.available) return;
  if (hint.type.startsWith('automation.rule')) {
    io.local.to(workspaceRoom(hint.workspaceId)).emit(hint.type, hint);
    return;
  }
  if (hint.type === 'notification.created') {
    io.local.to(`workspace:${hint.workspaceId}:user:${hint.recipientId}`).emit(hint.type, hint);
    return;
  }
  if (!hint.type.startsWith('automation.') && !hint.type.startsWith('integration.')) {
    const audience = audiences[hint.type];
    if (
      audience === 'private' ||
      (audience === 'project' && !hint.projectId) ||
      (audience === 'incident' && !hint.incidentId)
    )
      return;
    io.local
      .to(
        audience === 'workspace'
          ? workspaceRoom(hint.workspaceId)
          : audience === 'incident'
            ? `workspace:${hint.workspaceId}:incident:${hint.incidentId}`
            : projectRoom(hint.workspaceId, hint.projectId!),
      )
      .emit(hint.type, hint);
    return;
  }
  const admins = await WorkspaceMemberModel.find({
    workspaceId: hint.workspaceId,
    role: { $in: ['owner', 'admin'] },
    disabled: { $ne: true },
  }).select('userId');
  // Private rooms retain the existing active account/session/membership revocation boundary.
  for (const admin of admins)
    io.local.to(`workspace:${hint.workspaceId}:user:${admin.userId}`).emit(hint.type, hint);
};
const audiences: Record<
  Exclude<RealtimeEvent['type'], 'notification.created'>,
  'workspace' | 'project' | 'incident' | 'private'
> = {
  'project.created': 'workspace',
  'project.updated': 'workspace',
  'project.archived': 'workspace',
  'presence.updated': 'workspace',
  'task.created': 'project',
  'task.updated': 'project',
  'task.moved': 'project',
  'task.reordered': 'project',
  'task.assigned': 'project',
  'task.deleted': 'project',
  'incident.declared': 'workspace',
  'incident.updated': 'workspace',
  'incident.severity_changed': 'workspace',
  'incident.status_changed': 'workspace',
  'incident.commander_changed': 'workspace',
  'incident.responder_changed': 'workspace',
  'incident.resolved': 'workspace',
  'incident.reopened': 'workspace',
  'incident.timeline_added': 'incident',
  'incident.runbook_attached': 'incident',
  'incident.step_completed': 'incident',
  'automation.ruleCreated': 'workspace',
  'automation.ruleUpdated': 'workspace',
  'automation.ruleEnabled': 'workspace',
  'automation.ruleDisabled': 'workspace',
  'automation.ruleArchived': 'workspace',
  'automation.runQueued': 'private',
  'automation.runStarted': 'private',
  'automation.runCompleted': 'private',
  'automation.runSkipped': 'private',
  'automation.runFailed': 'private',
  'integration.healthChanged': 'private',
  'integration.deliveryFailed': 'private',
  'comment.created': 'project',
  'comment.updated': 'project',
  'comment.deleted': 'project',
};

export const publishRealtimeEvent = (
  event: EventInput & { type: Exclude<RealtimeEvent['type'], 'notification.created'> },
) => {
  const message = envelope(event);
  if (io && !coordinators.get(io)?.available) return message;
  const audience = audiences[event.type];
  if (audience === 'private') throw new Error('Use the restricted automation hint relay');
  if (audience === 'project' && !event.projectId)
    throw new Error('Project audience requires a project');
  if (audience === 'incident' && !event.incidentId)
    throw new Error('Incident audience requires an incident');
  io?.to(
    audience === 'workspace'
      ? workspaceRoom(event.workspaceId)
      : audience === 'incident'
        ? `workspace:${event.workspaceId}:incident:${event.incidentId}`
        : projectRoom(event.workspaceId, event.projectId!),
  ).emit(event.type, message);
  return message;
};

export const publishNotification = (recipientId: string, event: EventInput) => {
  const message = envelope({ ...event, type: 'notification.created' });
  if (io && !coordinators.get(io)?.available) return message;
  io?.to(`workspace:${event.workspaceId}:user:${recipientId}`).emit(
    'notification.created',
    message,
  );
  return message;
};

export const getPresenceState = async (workspaceId: string, server = io): Promise<PresenceState> =>
  server ? coordinators.get(server)!.presence(workspaceId) : { users: [], lastSeen: {} };
export const getPresence = async (workspaceId: string, server = io) =>
  (await getPresenceState(workspaceId, server)).users;

export const scheduleExpiration = (expiresAt: number, disconnect: () => void) => {
  const timer = setTimeout(disconnect, Math.max(0, Math.min(expiresAt - Date.now(), 2 ** 31 - 1)));
  timer.unref?.();
  return () => clearTimeout(timer);
};

const authenticationError = () =>
  Object.assign(new Error('Authentication required'), {
    data: { code: 'AUTHENTICATION_REQUIRED' },
  });
const denied = (): SocketAcknowledgement => ({
  ok: false,
  error: { code: 'UNAUTHORIZED', message: 'Access denied' },
});
const activeMembership = (workspaceId: string, userId: string) =>
  WorkspaceMemberModel.exists({ workspaceId, userId, disabled: { $ne: true } });

export const createRealtimeGateway = (
  server: HttpServer,
  allowedOrigins: string[],
  coordination = createMemoryCoordination(),
  subscribeChanges = onAuthorizationChange,
) => {
  const socketServer = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true },
    allowRequest: (request, callback) =>
      callback(null, !request.headers.origin || allowedOrigins.includes(request.headers.origin)),
  });
  io = socketServer;
  coordinators.set(socketServer, coordination);
  if (coordination.adapter) socketServer.adapter(coordination.adapter);
  socketServer.of('/').adapter.on('error', () => {
    coordinationLog('socket_adapter_error');
    coordination.fail();
  });
  const tokens = new WeakMap<Socket, string>();
  // A revision prevents an in-flight join from restoring access after eviction.
  let authorizationRevision = 0;
  const syncPresence = () =>
    coordination.writePresence(
      [...socketServer.sockets.sockets.values()].flatMap((socket) =>
        [...socket.rooms]
          .filter((room) => /^workspace:[a-f\d]{24}(:incident:[a-f\d]{24})?$/i.test(room))
          .map((room) => ({
            workspaceId: room.split(':').at(-1)!,
            userId: String(socket.data.userId),
          })),
      ),
    );
  const announcePresence = async (workspaceId: string, userId: string) => {
    await syncPresence();
    const presence = await coordination.presence(workspaceId);
    const online = presence.users.includes(userId);
    const message = envelope({
      type: 'presence.updated',
      workspaceId,
      actorId: userId,
      payload: { userId, online, lastSeen: online ? null : (presence.lastSeen[userId] ?? null) },
    });
    if (coordination.available)
      socketServer.to(workspaceRoom(workspaceId)).emit('presence.updated', message);
  };
  const leaveWorkspace = (socket: Socket, workspaceId: string) => {
    const joined = socket.rooms.has(workspaceRoom(workspaceId));
    for (const room of [...socket.rooms]) {
      if (room === workspaceRoom(workspaceId) || room.startsWith(`${workspaceRoom(workspaceId)}:`))
        void socket.leave(room);
    }
    if (joined)
      void announcePresence(workspaceId, socket.data.userId).catch(() => coordination.fail());
  };
  const quarantines = new Map<string, { change: Change; count: number }>();
  const scopeKey = (change: Change) => JSON.stringify(change);
  const blocked = (userId: string, tokenId: string, workspaceId?: string, projectId?: string) =>
    [...quarantines.values()].some(
      ({ change }) =>
        change.userId === userId &&
        (change.kind === 'user' ||
          (change.kind === 'session' && change.tokenId === tokenId) ||
          (change.kind === 'membership' && change.workspaceId === workspaceId) ||
          (change.kind === 'project' &&
            change.workspaceId === workspaceId &&
            change.projectId === projectId)),
    );
  const releaseQuarantine = (change: Change) => {
    const quarantine = quarantines.get(scopeKey(change));
    if (quarantine && --quarantine.count <= 0) quarantines.delete(scopeKey(change));
  };
  const applyChange = async (change: Change) => {
    authorizationRevision++;
    quarantines.set(scopeKey(change), {
      change,
      count: (quarantines.get(scopeKey(change))?.count ?? 0) + 1,
    });
    const removals: Array<void | Promise<void>> = [];
    // Official adapters update local room indexes synchronously. Remove every
    // protected room before yielding, including scoped notification audiences.
    for (const socket of socketServer.sockets.sockets.values()) {
      if (socket.data.userId !== change.userId) continue;
      if (
        change.kind === 'user' ||
        (change.kind === 'session' && socket.data.tokenId === change.tokenId)
      ) {
        socket.disconnect(true);
      } else if (change.kind === 'membership' || change.kind === 'project') {
        for (const room of [...socket.rooms]) {
          if (
            change.kind === 'membership'
              ? room === workspaceRoom(change.workspaceId) ||
                room.startsWith(`${workspaceRoom(change.workspaceId)}:`)
              : room === projectRoom(change.workspaceId, change.projectId) ||
                room.startsWith(`${projectRoom(change.workspaceId, change.projectId)}:`)
          ) {
            socketServer.of('/').adapter.del(socket.id, room);
            removals.push(socket.leave(room));
          }
        }
      }
    }
    await Promise.all(removals);
    // Presence is not an enforcement prerequisite and cannot delay the ack.
    void syncPresence().catch(() => coordination.fail());
  };
  const unsubscribe = subscribeChanges(async (change) => {
    await applyChange(change);
    await coordination.publish(change);
    releaseQuarantine(change);
  });
  const unsubscribeRemote = coordination.onChange(applyChange);
  const unsubscribeConfirmed = coordination.onConfirmed(releaseQuarantine);
  const unsubscribeHealth = coordination.onHealth((healthy) => {
    authorizationRevision++;
    if (!healthy) socketServer.local.disconnectSockets(true);
  });
  const monitor = new AuthorizationMonitor(
    async () => {
      const snapshot = [...socketServer.sockets.sockets.values()];
      const decisions = await reconcileAuthorization(
        snapshot.map((socket) => ({
          userId: String(socket.data.userId),
          tokenId: String(socket.data.tokenId),
          expiresAt: Number(socket.data.expiresAt),
          rooms: [...socket.rooms],
        })),
      );
      decisions.forEach((decision, index) => {
        const socket = snapshot[index]!;
        if (!socket.connected) return;
        if (decision.disconnect) socket.disconnect(true);
        else
          decision.removeRooms.forEach((room) => {
            authorizationRevision++;
            void socket.leave(room);
          });
      });
    },
    () => socketServer.local.disconnectSockets(true),
  );
  const heartbeat = setInterval(() => {
    if (!coordination.available) return;
    void monitor.run();
    // Renew presence independently of database latency.
    void syncPresence().catch(() => coordination.fail());
  }, heartbeatMs);
  heartbeat.unref();
  server.once('close', () => {
    clearInterval(heartbeat);
    monitor.close();
    unsubscribe();
    unsubscribeRemote();
    unsubscribeConfirmed();
    unsubscribeHealth();
    void coordination.close().catch(() => coordinationLog('coordination_shutdown_failed'));
    if (io === socketServer) io = undefined;
  });
  socketServer.use(async (socket, next) => {
    try {
      const revision = authorizationRevision;
      coordination.assertAvailable();
      if (!monitor.available) throw new Error('Authorization unavailable');
      const token =
        parse(socket.handshake.headers.cookie ?? '').accessToken ?? socket.handshake.auth?.token;
      if (typeof token !== 'string') return next(authenticationError());
      const { user, payload } = await authenticateAccessToken(token);
      if (
        blocked(user.id, payload.jti!) ||
        revision !== authorizationRevision ||
        payload.exp! * 1000 <= Date.now()
      )
        return next(authenticationError());
      socket.data.userId = user.id;
      tokens.set(socket, token);
      socket.data.tokenId = payload.jti;
      socket.data.expiresAt = payload.exp! * 1000;
      next();
    } catch {
      next(
        coordination.available && monitor.available
          ? authenticationError()
          : Object.assign(new Error('Real-time temporarily unavailable'), {
              data: { code: 'UNAVAILABLE' },
            }),
      );
    }
  });
  socketServer.on('connection', (socket) => {
    const cancelExpiration = scheduleExpiration(socket.data.expiresAt, () =>
      socket.disconnect(true),
    );
    void socket.join(`user:${socket.data.userId}`);
    const handle = (
      name: SocketRequest,
      action: (id: string, revision: number) => Promise<SocketAcknowledgement>,
    ) => {
      socket.on(name, (input: unknown, callback: unknown) => {
        const acknowledge = (result: SocketAcknowledgement) => {
          if (typeof callback === 'function') callback(result);
        };
        void (async () => {
          const parsed = socketPayloadSchemas[name].safeParse(input);
          if (!parsed.success)
            return acknowledge({
              ok: false,
              error: { code: 'INVALID_PAYLOAD', message: 'Invalid request' },
            });
          const revision = authorizationRevision;
          coordination.assertAvailable();
          try {
            await authenticateAccessToken(tokens.get(socket)!);
          } catch {
            acknowledge(denied());
            socket.disconnect(true);
            return;
          }
          acknowledge(await action(parsed.data, revision));
        })().catch(() =>
          acknowledge({
            ok: false,
            error: { code: 'UNAVAILABLE', message: 'Request unavailable' },
          }),
        );
      });
    };
    const stillAuthorized = (revision: number) =>
      coordination.available &&
      monitor.available &&
      socket.connected &&
      revision === authorizationRevision &&
      Date.now() < socket.data.expiresAt;
    handle('workspace:join', async (id, revision) => {
      if (
        !(await activeMembership(id, socket.data.userId)) ||
        blocked(socket.data.userId, socket.data.tokenId, id) ||
        !stillAuthorized(revision)
      )
        return denied();
      const alreadyJoined = socket.rooms.has(workspaceRoom(id));
      void socket.join([workspaceRoom(id), `workspace:${id}:user:${socket.data.userId}`]);
      if (!alreadyJoined) await announcePresence(id, socket.data.userId);
      return stillAuthorized(revision) ? { ok: true } : denied();
    });
    handle('workspace:leave', async (id) => {
      leaveWorkspace(socket, id);
      return { ok: true };
    });
    handle('project:join', async (id, revision) => {
      const project = await ProjectModel.findById(id).select('workspaceId');
      if (
        !project ||
        !(await activeMembership(String(project.workspaceId), socket.data.userId)) ||
        blocked(socket.data.userId, socket.data.tokenId, String(project.workspaceId), id) ||
        !stillAuthorized(revision)
      )
        return denied();
      void socket.join(projectRoom(String(project.workspaceId), id));
      return { ok: true };
    });
    handle('incident:join', async (id, revision) => {
      const incident = await IncidentModel.findById(id).select('workspaceId');
      if (
        !incident ||
        !(await activeMembership(String(incident.workspaceId), socket.data.userId)) ||
        blocked(socket.data.userId, socket.data.tokenId, String(incident.workspaceId)) ||
        !stillAuthorized(revision)
      )
        return denied();
      await socket.join(`workspace:${incident.workspaceId}:incident:${id}`);
      await syncPresence();
      return stillAuthorized(revision) ? { ok: true } : denied();
    });
    handle('incident:leave', async (id) => {
      for (const room of socket.rooms)
        if (room.endsWith(`:incident:${id}`)) await socket.leave(room);
      await syncPresence();
      return { ok: true };
    });
    handle('project:leave', async (id) => {
      for (const room of socket.rooms) if (room.includes(`:project:${id}`)) void socket.leave(room);
      return { ok: true };
    });
    handle('presence:list', async (id, revision) => {
      if (
        !(await activeMembership(id, socket.data.userId)) ||
        blocked(socket.data.userId, socket.data.tokenId, id) ||
        !stillAuthorized(revision)
      )
        return denied();
      const users = await getPresence(id, socketServer);
      return stillAuthorized(revision) ? { ok: true, users } : denied();
    });
    socket.on('disconnect', () => {
      void syncPresence().catch(() => coordination.fail());
    });
    socket.on('disconnecting', () => {
      cancelExpiration();
      for (const room of [...socket.rooms])
        if (/^workspace:[a-f\d]{24}$/i.test(room)) leaveWorkspace(socket, room.slice(10));
    });
  });
  return socketServer;
};
