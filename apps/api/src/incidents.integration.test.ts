import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import {
  incidentTransitions,
  type IncidentCommand,
  type SocketAcknowledgement,
} from '@flowryn/shared';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { issueTokens } from './auth/tokens.js';
import { automationHintSchema } from './automation/hints.js';
import { IncidentCounterModel, IncidentModel } from './models/Incident.js';
import { IncidentEventModel } from './models/IncidentEvent.js';
import { NotificationModel } from './models/Notification.js';
import { ProjectModel } from './models/Project.js';
import { RunbookModel } from './models/Runbook.js';
import { TaskModel } from './models/Task.js';
import { UserModel } from './models/User.js';
import { WorkspaceModel } from './models/Workspace.js';
import { WorkspaceMemberModel } from './models/WorkspaceMember.js';
import { createRealtimeGateway, getPresence, relayAutomationHint } from './realtime/gateway.js';

const app = createApp();
const server = createServer(app);
const gateway = createRealtimeGateway(server, ['http://localhost:5173']);
let mongo: MongoMemoryReplSet;
let url: string;
const sockets: Socket[] = [];
const declaration = (extra = {}) => ({
  operationId: randomUUID(),
  title: 'Database latency',
  summary: 'Investigating delays',
  impact: 'Slow requests',
  severity: 'sev3',
  ...extra,
});
const ack = (socket: Socket, event: string, payload: string) =>
  new Promise<SocketAcknowledgement>((resolve, reject) =>
    socket
      .timeout(2000)
      .emit(event, payload, (error: Error | null, result: SocketAcknowledgement) =>
        error ? reject(error) : resolve(result),
      ),
  );
const socketClient = async (token: string) => {
  const socket = connect(url, {
    auth: { token },
    transports: ['websocket'],
    autoConnect: false,
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  return socket;
};
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 180000);
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
});
afterEach(() => {
  sockets.splice(0).forEach((socket) => socket.disconnect());
  vi.restoreAllMocks();
});
afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  await mongoose.disconnect();
  await mongo?.stop();
});
const fixture = async () => {
  const [owner, commander, member, outsider] = await UserModel.create(
    ['owner', 'commander', 'member', 'outsider'].map((name) => ({
      name,
      email: `${name}@test.dev`,
      passwordHash: 'unused',
    })),
  );
  const workspace = await WorkspaceModel.create({ name: 'Operations', createdBy: owner!.id });
  const other = await WorkspaceModel.create({ name: 'Other', createdBy: outsider!.id });
  await WorkspaceMemberModel.create([
    { workspaceId: workspace.id, userId: owner!.id, role: 'owner' },
    { workspaceId: workspace.id, userId: commander!.id, role: 'member' },
    { workspaceId: workspace.id, userId: member!.id, role: 'member' },
    { workspaceId: other.id, userId: outsider!.id, role: 'owner' },
  ]);
  const tokens = await Promise.all(
    [owner!, commander!, member!, outsider!].map((user) => issueTokens(user.id)),
  );
  const base = `/api/workspaces/${workspace.id}/incidents`;
  const post = (path: string, body: object, actor = 0) =>
    request(app).post(path).set('Authorization', `Bearer ${tokens[actor]!.accessToken}`).send(body);
  const get = (path: string, actor = 0) =>
    request(app).get(path).set('Authorization', `Bearer ${tokens[actor]!.accessToken}`);
  const create = (extra = {}, actor = 0) => post(base, declaration(extra), actor);
  const action = (
    id: string,
    command: IncidentCommand['command'],
    actor = 0,
    operationId = randomUUID(),
  ) => post(`${base}/${id}/actions`, { operationId, command }, actor);
  return {
    owner: owner!,
    commander: commander!,
    member: member!,
    outsider: outsider!,
    workspace,
    other,
    tokens,
    base,
    post,
    get,
    create,
    action,
  };
};

describe('transactional incident response', () => {
  it('restricts automation failures to administrator private rooms and rule hints to authorized workspaces', async () => {
    const f = await fixture();
    const owner = await socketClient(f.tokens[0]!.accessToken),
      member = await socketClient(f.tokens[2]!.accessToken),
      outsider = await socketClient(f.tokens[3]!.accessToken);
    await ack(owner, 'workspace:join', f.workspace.id);
    await ack(member, 'workspace:join', f.workspace.id);
    await ack(outsider, 'workspace:join', f.other.id);
    const ownerFailures = vi.fn(),
      memberFailures = vi.fn(),
      outsideFailures = vi.fn(),
      memberRules = vi.fn(),
      outsideRules = vi.fn();
    owner.on('automation.runFailed', ownerFailures);
    member.on('automation.runFailed', memberFailures);
    outsider.on('automation.runFailed', outsideFailures);
    member.on('automation.ruleCreated', memberRules);
    outsider.on('automation.ruleCreated', outsideRules);
    const hint = automationHintSchema.parse({
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      workspaceId: f.workspace.id,
      entityId: f.workspace.id,
      actorId: f.owner.id,
      type: 'automation.runFailed',
      payload: {},
    });
    await relayAutomationHint(hint);
    await relayAutomationHint({ ...hint, eventId: randomUUID(), type: 'automation.ruleCreated' });
    const ownerEscalationFailures = vi.fn(),
      memberEscalationFailures = vi.fn(),
      outsideAlerts = vi.fn(),
      memberAlerts = vi.fn(),
      ownerPages = vi.fn(),
      memberPages = vi.fn();
    owner.on('escalation.deliveryFailed', ownerEscalationFailures);
    member.on('escalation.deliveryFailed', memberEscalationFailures);
    outsider.on('alert.opened', outsideAlerts);
    member.on('alert.opened', memberAlerts);
    owner.on('notification.created', ownerPages);
    member.on('notification.created', memberPages);
    await relayAutomationHint({
      ...hint,
      eventId: randomUUID(),
      type: 'escalation.deliveryFailed',
    });
    await relayAutomationHint({ ...hint, eventId: randomUUID(), type: 'alert.opened' });
    await relayAutomationHint({
      ...hint,
      eventId: randomUUID(),
      type: 'notification.created',
      recipientId: f.member.id,
    });
    await vi.waitFor(() => {
      expect(ownerFailures).toHaveBeenCalledTimes(1);
      expect(memberRules).toHaveBeenCalledTimes(1);
      expect(ownerEscalationFailures).toHaveBeenCalledTimes(1);
      expect(memberAlerts).toHaveBeenCalledTimes(1);
      expect(memberPages).toHaveBeenCalledTimes(1);
    });
    expect(memberFailures).not.toHaveBeenCalled();
    expect(outsideFailures).not.toHaveBeenCalled();
    expect(outsideRules).not.toHaveBeenCalled();
    expect(memberEscalationFailures).not.toHaveBeenCalled();
    expect(outsideAlerts).not.toHaveBeenCalled();
    expect(ownerPages).not.toHaveBeenCalled();
    expect(ownerFailures.mock.calls[0]![0].payload).toEqual({});
    expect(
      automationHintSchema.safeParse({ ...hint, payload: { signingSecret: 'secret' } }).success,
    ).toBe(false);
  });
  it('sanitizes malformed-body failures without logging incident narrative', async () => {
    const f = await fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await request(app)
      .post(f.base)
      .set('Authorization', `Bearer ${f.tokens[0]!.accessToken}`)
      .set('Content-Type', 'application/json')
      .send('{"summary":"private operational details"');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request body');
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ service: 'api', event: 'request_failed', status: 400 }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private operational details');
  });

  it('allocates unique numbers concurrently and deduplicates retried declaration notifications', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.create()));
    expect(results.map((result) => result.status)).toEqual(Array(8).fill(201));
    expect(new Set(results.map((result) => result.body.incident.incidentNumber)).size).toBe(8);
    expect((await IncidentCounterModel.findById(f.workspace.id))?.value).toBe(8);
    const body = declaration({
      severity: 'sev1',
      confirmSev1: true,
      commanderId: f.commander.id,
      responderIds: [f.member.id],
    });
    const first = await f.post(f.base, body);
    const second = await f.post(f.base, body);
    expect(first.status).toBe(201);
    expect(second.body.incident.id).toBe(first.body.incident.id);
    expect(await IncidentEventModel.countDocuments({ operationId: body.operationId })).toBe(1);
    expect(await NotificationModel.countDocuments({ operationId: body.operationId })).toBe(2);
    expect((await f.post(f.base, { ...body, title: 'Different' })).status).toBe(409);
    expect((await f.create({ severity: 'sev1' })).status).toBe(400);
  }, 30000);
  it('enforces the full state machine, resolution summaries and first-acknowledgement timestamps', async () => {
    const f = await fixture();
    const { incident } = (await f.create()).body;
    const id = incident.id;
    expect(incident.acknowledgedAt).toBeNull();
    expect(incident.resolvedAt).toBeNull();
    expect(
      (
        await f.action(id, {
          action: 'transition',
          status: 'resolved',
          resolutionSummary: 'Invalid shortcut',
        })
      ).status,
    ).toBe(409);
    const op = randomUUID();
    const acknowledged = await f.action(id, { action: 'acknowledge' }, 0, op);
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.incident.acknowledgedAt).toBeTruthy();
    expect(
      (await f.action(id, { action: 'acknowledge' }, 0, op)).body.incident.acknowledgedAt,
    ).toBe(acknowledged.body.incident.acknowledgedAt);
    for (const status of ['identified', 'monitoring'] as const)
      expect((await f.action(id, { action: 'transition', status })).status).toBe(200);
    expect(
      (await f.action(id, { action: 'transition', status: 'resolved', resolutionSummary: ' ' }))
        .status,
    ).toBe(400);
    const resolved = await f.action(id, {
      action: 'transition',
      status: 'resolved',
      resolutionSummary: 'Restored capacity',
    });
    expect(resolved.body.incident.resolvedAt).toBeTruthy();
    const reopened = await f.action(id, { action: 'transition', status: 'investigating' });
    expect(reopened.body.incident.resolvedAt).toBeNull();
    expect(reopened.body.incident.acknowledgedAt).toBe(acknowledged.body.incident.acknowledgedAt);
    const timeline = await f.get(`${f.base}/${id}/timeline`);
    expect(
      timeline.body.items.map((event: { nextValue: string }) => event.nextValue).filter(Boolean),
    ).toEqual(['investigating', 'identified', 'monitoring', 'resolved', 'investigating']);
    expect(
      timeline.body.items.find(
        (event: { eventType: string }) => event.eventType === 'incident.resolved',
      ).message,
    ).toBe('Restored capacity');
    expect(JSON.stringify(timeline.body)).not.toMatch(/requestHash|operationId/);
    expect(incidentTransitions.resolved).toEqual(['investigating']);
  });
  it('serializes conflicting transitions without overwriting state or issuing duplicate receipts', async () => {
    const f = await fixture();
    const id = (await f.create()).body.incident.id;
    const op = randomUUID();
    const results = await Promise.all([
      f.action(id, { action: 'acknowledge' }, 0, op),
      f.action(id, { action: 'acknowledge' }, 0, op),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(await IncidentEventModel.countDocuments({ incidentId: id, operationId: op })).toBe(1);
    expect((await IncidentModel.findById(id))?.status).toBe('investigating');
  });
  it('allows member declaration and timeline participation but prevents self-elevation and inactive assignments', async () => {
    const f = await fixture();
    expect((await f.create({ commanderId: f.member.id }, 2)).status).toBe(403);
    const id = (await f.create({}, 2)).body.incident.id;
    expect((await f.action(id, { action: 'commander', userId: f.member.id }, 2)).status).toBe(403);
    expect((await f.action(id, { action: 'acknowledge' }, 2)).status).toBe(403);
    expect(
      (
        await f.action(
          id,
          { action: 'timeline', message: 'Investigating cache', mentionIds: [] },
          2,
        )
      ).status,
    ).toBe(200);
    expect((await f.action(id, { action: 'commander', userId: f.commander.id })).status).toBe(200);
    expect((await f.action(id, { action: 'acknowledge' }, 1)).status).toBe(200);
    expect((await f.action(id, { action: 'archive' }, 1)).status).toBe(403);
    expect((await f.action(id, { action: 'responders', userIds: [f.outsider.id] })).status).toBe(
      400,
    );
    await UserModel.updateOne({ _id: f.member.id }, { status: 'suspended' });
    expect((await f.action(id, { action: 'responders', userIds: [f.member.id] })).status).toBe(400);
    expect((await f.action(id, { action: 'commander', userId: f.member.id })).status).toBe(400);
    expect((await f.get(f.base, 2)).status).toBe(401);
    await WorkspaceMemberModel.deleteOne({ workspaceId: f.workspace.id, userId: f.commander.id });
    expect((await f.action(id, { action: 'transition', status: 'identified' }, 1)).status).toBe(
      403,
    );
  });
  it('rejects cross-workspace IDs, links and payload field bypasses before mutation', async () => {
    const f = await fixture();
    const id = (await f.create()).body.incident.id;
    const project = await ProjectModel.create({
      workspaceId: f.other.id,
      createdBy: f.outsider.id,
      name: 'Private project',
    });
    const task = await TaskModel.create({
      workspaceId: f.other.id,
      projectId: project.id,
      createdBy: f.outsider.id,
      title: 'Private task',
    });
    expect(
      (await f.action(id, { action: 'links', projectIds: [project.id], taskIds: [] })).status,
    ).toBe(400);
    expect(
      (await f.action(id, { action: 'links', projectIds: [], taskIds: [task.id] })).status,
    ).toBe(400);
    expect((await f.get(f.base, 3)).status).toBe(403);
    expect((await f.get(`/api/workspaces/${f.other.id}/incidents/${id}`, 3)).status).toBe(404);
    expect((await f.get(`${f.base}/invalid`)).status).toBe(400);
    expect((await f.get(`${f.base}?commanderId=invalid`)).status).toBe(400);
    expect(
      (
        await f.post(`${f.base}/${id}/actions`, {
          operationId: randomUUID(),
          command: { action: 'edit', fields: { status: 'resolved', workspaceId: f.other.id } },
        })
      ).status,
    ).toBe(400);
    expect((await request(app).get(f.base)).status).toBe(401);
    expect(
      (await f.get(`${f.base}?from=2026-09-02T00:00:00.000Z&to=2026-09-01T00:00:00.000Z`)).status,
    ).toBe(400);
  });
  it('preserves append-only history and makes archived incidents read-only', async () => {
    const f = await fixture();
    const id = (await f.create()).body.incident.id;
    const first = await IncidentEventModel.findOne({ incidentId: id });
    await expect(
      IncidentEventModel.updateOne({ _id: first!._id }, { message: 'tampered' }),
    ).rejects.toThrow('append-only');
    await expect(IncidentEventModel.deleteOne({ _id: first!._id })).rejects.toThrow('append-only');
    first!.message = 'tampered';
    await expect(first!.save()).rejects.toThrow('append-only');
    await f.action(id, { action: 'edit', fields: { title: 'Updated title' } });
    expect((await IncidentEventModel.findById(first!._id))?.message).toBe('Incident declared');
    expect((await f.action(id, { action: 'archive' })).status).toBe(409);
    for (const status of ['investigating', 'identified', 'monitoring', 'resolved'] as const)
      await f.action(id, { action: 'transition', status, resolutionSummary: 'Fixed' });
    expect((await f.action(id, { action: 'archive' })).status).toBe(200);
    expect(
      (await f.action(id, { action: 'timeline', message: 'late update', mentionIds: [] })).status,
    ).toBe(409);
    expect((await f.get(f.base)).body.pagination.total).toBe(0);
    expect((await f.get(`${f.base}?archived=true`)).body.pagination.total).toBe(1);
  });
  it('isolates runbook snapshots and progress and validates owners and attachment tenants', async () => {
    const f = await fixture();
    const path = `/api/workspaces/${f.workspace.id}/runbooks`;
    const step = {
      id: randomUUID(),
      title: 'Check health',
      instructions: 'Read dashboard',
      position: 0,
    };
    const body = {
      name: 'Recovery',
      description: '',
      ownerId: f.owner.id,
      status: 'active',
      steps: [step],
    };
    expect((await f.post(path, body, 2)).status).toBe(403);
    expect((await f.post(path, { ...body, ownerId: f.outsider.id })).status).toBe(400);
    const book = (await f.post(path, body)).body.runbook;
    const one = (await f.create()).body.incident.id;
    const two = (await f.create()).body.incident.id;
    for (const id of [one, two])
      expect((await f.action(id, { action: 'attach-runbook', runbookId: book.id })).status).toBe(
        200,
      );
    expect(
      (
        await f.action(
          one,
          { action: 'step', runbookId: book.id, stepId: step.id, completed: true },
          2,
        )
      ).status,
    ).toBe(403);
    await f.action(one, { action: 'responders', userIds: [f.member.id] });
    expect(
      (
        await f.action(
          one,
          { action: 'step', runbookId: book.id, stepId: step.id, completed: true },
          2,
        )
      ).status,
    ).toBe(200);
    await RunbookModel.updateOne({ _id: book.id }, { 'steps.0.title': 'Revised source' });
    const first = (await f.get(`${f.base}/${one}`)).body.incident;
    const second = (await f.get(`${f.base}/${two}`)).body.incident;
    expect(first.runbooks[0].steps[0].title).toBe('Check health');
    expect(first.runbooks[0].steps[0].completedAt).toBeTruthy();
    expect(second.runbooks[0].steps[0].completedAt).toBeNull();
    expect((await RunbookModel.findById(book.id))?.steps[0]?.toObject()).not.toHaveProperty(
      'completedAt',
    );
    await f.action(one, { action: 'step', runbookId: book.id, stepId: step.id, completed: false });
    expect(
      (await f.get(`${f.base}/${one}`)).body.incident.runbooks[0].steps[0].completedAt,
    ).toBeNull();
    const otherBook = await RunbookModel.create({
      ...body,
      workspaceId: f.other.id,
      ownerId: f.outsider.id,
    });
    expect(
      (await f.action(one, { action: 'attach-runbook', runbookId: otherBook.id })).status,
    ).toBe(404);
  });
  it('rolls back state, timeline, counter, progress and notifications when a transaction fails', async () => {
    const f = await fixture();
    const body = declaration({ commanderId: f.commander.id });
    const failure = vi
      .spyOn(NotificationModel, 'create')
      .mockRejectedValueOnce(new Error('simulated database failure'));
    expect((await f.post(f.base, body)).status).toBe(503);
    failure.mockRestore();
    expect(await IncidentModel.countDocuments()).toBe(0);
    expect(await IncidentEventModel.countDocuments()).toBe(0);
    expect((await IncidentCounterModel.findById(f.workspace.id))?.value).toBe(0);
    const id = (await f.post(f.base, body)).body.incident.id;
    const events = await IncidentEventModel.countDocuments();
    const notifications = await NotificationModel.countDocuments();
    vi.spyOn(NotificationModel, 'create').mockRejectedValueOnce(
      new Error('simulated notification failure'),
    );
    expect((await f.action(id, { action: 'acknowledge' })).status).toBe(503);
    expect((await IncidentModel.findById(id))?.status).toBe('declared');
    expect(await IncidentEventModel.countDocuments()).toBe(events);
    expect(await NotificationModel.countDocuments()).toBe(notifications);
    vi.restoreAllMocks();
    const stepId = randomUUID();
    const book = await RunbookModel.create({
      workspaceId: f.workspace.id,
      ownerId: f.owner.id,
      name: 'Rollback test',
      status: 'active',
      steps: [{ id: stepId, title: 'Check', instructions: '', position: 0 }],
    });
    await f.action(id, { action: 'attach-runbook', runbookId: book.id });
    const beforeStep = await IncidentEventModel.countDocuments();
    vi.spyOn(NotificationModel, 'create').mockRejectedValueOnce(
      new Error('progress notification failure'),
    );
    expect(
      (await f.action(id, { action: 'step', runbookId: book.id, stepId, completed: true })).status,
    ).toBe(503);
    expect((await IncidentModel.findById(id))?.runbooks[0]?.steps[0]?.completedAt).toBeNull();
    expect(await IncidentEventModel.countDocuments()).toBe(beforeStep);
  });
  it('aggregates filtered UTC cohorts and excludes missing timestamps from averages', async () => {
    const f = await fixture();
    const one = (await f.create()).body.incident.id;
    const two = (await f.create({ severity: 'sev2' })).body.incident.id;
    await IncidentModel.updateOne(
      { _id: one },
      {
        declaredAt: new Date('2026-09-01T00:00:00Z'),
        acknowledgedAt: new Date('2026-09-01T00:01:00Z'),
        resolvedAt: new Date('2026-09-01T00:04:00Z'),
        status: 'resolved',
      },
    );
    await IncidentModel.updateOne({ _id: two }, { declaredAt: new Date('2026-09-01T00:00:00Z') });
    const metrics = (await f.get(`${f.base}/metrics`)).body;
    expect(metrics.averages).toMatchObject({
      meanAcknowledgeMs: 60000,
      acknowledgedCount: 1,
      meanResolveMs: 240000,
      resolvedCount: 1,
    });
    expect(metrics.openBySeverity).toEqual([{ _id: 'sev2', count: 1 }]);
    expect(metrics.createdOverTime).toEqual([{ _id: '2026-09-01', count: 2 }]);
    expect((await f.get(`${f.base}/metrics?severity=sev2`)).body.averages).toMatchObject({
      meanAcknowledgeMs: null,
      acknowledgedCount: 0,
      meanResolveMs: null,
      resolvedCount: 0,
    });
    expect((await f.get(`${f.base}?severity=sev2&limit=1`)).body.pagination.total).toBe(1);
  });
  it('authorizes incident rooms, delivers only private recipient hints and restores clean subscriptions', async () => {
    const f = await fixture();
    const id = (await f.create()).body.incident.id;
    const recipient = await socketClient(f.tokens[1]!.accessToken);
    const member = await socketClient(f.tokens[2]!.accessToken);
    const outsider = await socketClient(f.tokens[3]!.accessToken);
    for (const socket of [recipient, member])
      expect((await ack(socket, 'workspace:join', f.workspace.id)).ok).toBe(true);
    expect((await ack(outsider, 'incident:join', id)).ok).toBe(false);
    expect((await ack(recipient, 'incident:join', id)).ok).toBe(true);
    const privateEvents = vi.fn();
    const leaked = vi.fn();
    const timeline = vi.fn();
    const unjoinedTimeline = vi.fn();
    recipient.on('notification.created', privateEvents);
    member.on('notification.created', leaked);
    outsider.on('incident.updated', leaked);
    recipient.on('incident.timeline_added', timeline);
    member.on('incident.timeline_added', unjoinedTimeline);
    await f.action(id, { action: 'commander', userId: f.commander.id });
    await vi.waitFor(() => expect(privateEvents).toHaveBeenCalledTimes(1));
    await f.action(id, {
      action: 'timeline',
      message: 'Sensitive operational narrative stays in REST',
      mentionIds: [f.commander.id],
    });
    await vi.waitFor(() => expect(timeline).toHaveBeenCalledTimes(1));
    expect(leaked).not.toHaveBeenCalled();
    expect(unjoinedTimeline).not.toHaveBeenCalled();
    expect(JSON.stringify(timeline.mock.calls)).not.toMatch(/Sensitive|token|socketId|serverId/);
    expect(await getPresence(id)).toContain(f.commander.id);
    recipient.disconnect();
    await vi.waitFor(async () => expect(await getPresence(id)).not.toContain(f.commander.id));
    await new Promise<void>((resolve) => {
      recipient.once('connect', resolve);
      recipient.connect();
    });
    await ack(recipient, 'workspace:join', f.workspace.id);
    await ack(recipient, 'incident:join', id);
    await ack(recipient, 'incident:join', id);
    timeline.mockClear();
    await f.action(id, { action: 'timeline', message: 'Recovered', mentionIds: [] });
    await vi.waitFor(() => expect(timeline).toHaveBeenCalledTimes(1));
    await WorkspaceMemberModel.deleteOne({ workspaceId: f.workspace.id, userId: f.commander.id });
    privateEvents.mockClear();
    timeline.mockClear();
    await f.action(id, { action: 'timeline', message: 'After removal', mentionIds: [] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(privateEvents).not.toHaveBeenCalled();
    expect(timeline).not.toHaveBeenCalled();
  });
});
