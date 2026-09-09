import { AuthSessionModel } from '../models/AuthSession.js';
import { ProjectModel } from '../models/Project.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

import { coordinationLog } from './coordination.js';

export type AuthorizationSnapshot = { userId: string; tokenId: string; expiresAt: number; rooms: string[] };
export const reconcileAuthorization = async (sockets: AuthorizationSnapshot[]) => {
  if (!sockets.length) return [];
  const users = [...new Set(sockets.map((socket) => socket.userId))];
  const sessions = [...new Set(sockets.map((socket) => socket.tokenId))];
  const rooms = [...new Set(sockets.flatMap((socket) => socket.rooms))];
  const workspaces = [...new Set(rooms.filter((room) => room.startsWith('workspace:')).map((room) => room.slice(10, 34)))];
  const projects = [...new Set(rooms.filter((room) => room.includes(':project:')).map((room) => room.split(':')[3]!))];
  const results = await Promise.allSettled([
    UserModel.find({ _id: { $in: users }, status: 'active' }).select('_id').maxTimeMS(10000).lean(),
    AuthSessionModel.find({ tokenId: { $in: sessions }, revokedAt: null, expiresAt: { $gt: new Date() } }).select('tokenId userId').maxTimeMS(10000).lean(),
    WorkspaceMemberModel.find({ userId: { $in: users }, workspaceId: { $in: workspaces }, disabled: { $ne: true } }).select('userId workspaceId').maxTimeMS(10000).lean(),
    ProjectModel.find({ _id: { $in: projects } }).select('_id workspaceId').maxTimeMS(10000).lean(),
  ] as const);
  if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled' || results[2].status !== 'fulfilled' || results[3].status !== 'fulfilled') throw new Error('Authorization batch unavailable');
  const [activeUsers, activeSessions, memberships, activeProjects] = [results[0].value, results[1].value, results[2].value, results[3].value];
  const validUsers = new Set(activeUsers.map((user) => String(user._id)));
  const validSessions = new Set(activeSessions.map((session) => `${session.userId}:${session.tokenId}`));
  const validMemberships = new Set(memberships.map((member) => `${member.userId}:${member.workspaceId}`));
  const validProjects = new Set(activeProjects.map((project) => `${project.workspaceId}:${project._id}`));
  return sockets.map((socket) => ({
    disconnect: socket.expiresAt <= Date.now() || !validUsers.has(socket.userId) || !validSessions.has(`${socket.userId}:${socket.tokenId}`),
    removeRooms: socket.rooms.filter((room) => {
      if (!room.startsWith('workspace:')) return false;
      const [, workspace, scope, project] = room.split(':');
      return !validMemberships.has(`${socket.userId}:${workspace}`) || (scope === 'project' && !validProjects.has(`${workspace}:${project}`));
    }),
  }));
};

// Three failed batches or three unconfirmed 15-second intervals fail closed.
// A successful slow batch resets the counter; Redis readiness is independent.
export class AuthorizationMonitor {
  get available() { return !this.closed && this.failures < 3; }
  private running = false;
  private closed = false;
  private failures = 0;
  constructor(private readonly check: () => Promise<void>, private readonly failClosed: () => void, private readonly timeoutMs = 15000) {}
  private timer?: ReturnType<typeof setTimeout>;
  private failed() {
    if (this.closed) return;
    coordinationLog('authorization_reconciliation_failed');
    if (++this.failures === 3) { coordinationLog('authorization_reconciliation_unconfirmed'); this.failClosed(); }
  }
  async run() {
    if (this.running || this.closed) return;
    this.running = true;
    const overdue = () => { this.failed(); if (!this.closed) this.timer = setTimeout(overdue, this.timeoutMs); };
    this.timer = setTimeout(overdue, this.timeoutMs);
    try { await this.check(); this.failures = 0; }
    catch { this.failed(); }
    finally { clearTimeout(this.timer); this.running = false; }
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
