import { afterEach, expect, it, vi } from 'vitest';

import { AuthSessionModel } from '../models/AuthSession.js';
import { ProjectModel } from '../models/Project.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

import { AuthorizationMonitor, reconcileAuthorization } from './authorization.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const user = 'a'.repeat(24), other = 'b'.repeat(24), workspace = 'c'.repeat(24), second = 'd'.repeat(24), project = 'e'.repeat(24);
const query = (rows: unknown[]) => ({ select: () => ({ maxTimeMS: () => ({ lean: () => new Promise((resolve) => setTimeout(() => resolve(rows), 6000)) }) }) });

it('batches duplicate tabs, sessions, users, workspaces and projects during a slow successful cycle', async () => {
  vi.useFakeTimers();
  const users = vi.spyOn(UserModel, 'find').mockReturnValue(query([{ _id: user }, { _id: other }]) as unknown as ReturnType<typeof UserModel.find>);
  const sessions = vi.spyOn(AuthSessionModel, 'find').mockReturnValue(query([{ userId: user, tokenId: 'session' }, { userId: other, tokenId: 'other' }]) as unknown as ReturnType<typeof AuthSessionModel.find>);
  const memberships = vi.spyOn(WorkspaceMemberModel, 'find').mockReturnValue(query([{ userId: user, workspaceId: workspace }, { userId: other, workspaceId: second }]) as unknown as ReturnType<typeof WorkspaceMemberModel.find>);
  const projects = vi.spyOn(ProjectModel, 'find').mockReturnValue(query([{ _id: project, workspaceId: workspace }]) as unknown as ReturnType<typeof ProjectModel.find>);
  const sockets = Array.from({ length: 200 }, () => ({ userId: user, tokenId: 'session', expiresAt: Date.now() + 60000, rooms: [`workspace:${workspace}`, `workspace:${workspace}:project:${project}`] }));
  sockets.push({ userId: other, tokenId: 'other', expiresAt: Date.now() + 60000, rooms: [`workspace:${second}`] });
  let decisions: Awaited<ReturnType<typeof reconcileAuthorization>> = [];
  const check = vi.fn(async () => { decisions = await reconcileAuthorization(sockets); });
  const disconnect = vi.fn(); const monitor = new AuthorizationMonitor(check, disconnect);
  const running = monitor.run();
  await vi.advanceTimersByTimeAsync(5500); await monitor.run();
  expect(check).toHaveBeenCalledTimes(1); expect(disconnect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500); await running;
  expect(decisions).toHaveLength(201);
  expect(decisions.every((decision) => !decision.disconnect && !decision.removeRooms.length)).toBe(true);
  for (const spy of [users, sessions, memberships, projects]) expect(spy).toHaveBeenCalledTimes(1);
  expect(users).toHaveBeenCalledWith({ _id: { $in: [user, other] }, status: 'active' });
  expect(sessions).toHaveBeenCalledWith(expect.objectContaining({ tokenId: { $in: ['session', 'other'] } }));
  expect(projects).toHaveBeenCalledWith({ _id: { $in: [project] } });
  monitor.close();
});

it('fails closed only after three unconfirmed intervals without overlapping stalled checks', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const check = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const disconnect = vi.fn(); const monitor = new AuthorizationMonitor(check, disconnect);
  const running = monitor.run();
  await vi.advanceTimersByTimeAsync(30000); await monitor.run();
  expect(disconnect).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000);
  expect(disconnect).toHaveBeenCalledTimes(1);
  release(); await running; monitor.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('identifies suspended users, expired sessions/tokens and removed memberships or projects', async () => {
  vi.useFakeTimers();
  vi.spyOn(UserModel, 'find').mockReturnValue(query([{ _id: user }]) as unknown as ReturnType<typeof UserModel.find>);
  vi.spyOn(AuthSessionModel, 'find').mockReturnValue(query([{ userId: user, tokenId: 'valid' }]) as unknown as ReturnType<typeof AuthSessionModel.find>);
  vi.spyOn(WorkspaceMemberModel, 'find').mockReturnValue(query([{ userId: user, workspaceId: second }]) as unknown as ReturnType<typeof WorkspaceMemberModel.find>);
  vi.spyOn(ProjectModel, 'find').mockReturnValue(query([]) as unknown as ReturnType<typeof ProjectModel.find>);
  const base = { userId: user, tokenId: 'valid', expiresAt: Date.now() + 60000, rooms: [`workspace:${workspace}`, `workspace:${second}`, `workspace:${second}:project:${project}`] };
  const pending = reconcileAuthorization([base, { ...base, userId: other }, { ...base, tokenId: 'expired' }, { ...base, expiresAt: 1 }]);
  await vi.advanceTimersByTimeAsync(6000);
  const results = await pending;
  expect(results[0]).toEqual({ disconnect: false, removeRooms: [`workspace:${workspace}`, `workspace:${second}:project:${project}`] });
  expect(results.slice(1).every((result) => result.disconnect)).toBe(true);
});
