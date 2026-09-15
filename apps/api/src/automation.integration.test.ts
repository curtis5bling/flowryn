import { randomUUID } from 'node:crypto';

import {
  automationRuleSchema,
  type AutomationPayload,
  type AutomationRuleInput,
} from '@flowryn/shared';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { issueTokens } from './auth/tokens.js';
import {
  AutomationWorker,
  claimEvent,
  claimRun,
  processEvent,
  processRun,
  retryDelay,
} from './automation/engine.js';
import { automationMetrics } from './automation/metrics.js';
import {
  AutomationRuleModel,
  AutomationRunModel,
  IntegrationModel,
  OutboxEventModel,
  WebhookDeliveryModel,
} from './automation/models.js';
import { emitDomainEvent } from './automation/outbox.js';
import {
  decryptSecret,
  encryptSecret,
  signBody,
  type NetworkAdapters,
} from './automation/security.js';
import { executeTask } from './automation/tasks.js';
import { executeIncident } from './incidents/service.js';
import { ActivityModel } from './models/Activity.js';
import { IncidentModel } from './models/Incident.js';
import { IncidentEventModel } from './models/IncidentEvent.js';
import { NotificationModel } from './models/Notification.js';
import { ProjectModel } from './models/Project.js';
import { TaskModel } from './models/Task.js';
import { UserModel } from './models/User.js';
import { WorkspaceModel } from './models/Workspace.js';
import { WorkspaceMemberModel } from './models/WorkspaceMember.js';

const app = createApp();
let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  process.env.AUTOMATION_ENCRYPTION_KEYS = JSON.stringify({ '1': 'ab'.repeat(32) });
  process.env.AUTOMATION_KEY_VERSION = '1';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 180000);
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  delete process.env.AUTOMATION_ENCRYPTION_KEYS;
  delete process.env.AUTOMATION_KEY_VERSION;
});
const fixture = async () => {
  const users = await UserModel.create(
    ['owner', 'admin', 'member', 'outsider'].map((name) => ({
      name,
      email: `${name}@test.dev`,
      passwordHash: 'unused',
    })),
  );
  const [owner, admin, member, outsider] = users;
  const workspace = await WorkspaceModel.create({ name: 'Operations', createdBy: owner!.id });
  const other = await WorkspaceModel.create({ name: 'Other', createdBy: outsider!.id });
  await WorkspaceMemberModel.create([
    { workspaceId: workspace.id, userId: owner!.id, role: 'owner' },
    { workspaceId: workspace.id, userId: admin!.id, role: 'admin' },
    { workspaceId: workspace.id, userId: member!.id, role: 'member' },
    { workspaceId: other.id, userId: outsider!.id, role: 'owner' },
  ]);
  const project = await ProjectModel.create({
    workspaceId: workspace.id,
    name: 'Response',
    createdBy: owner!.id,
  });
  const cookie = async (user = owner!) => `accessToken=${(await issueTokens(user.id)).accessToken}`;
  return {
    owner: owner!,
    admin: admin!,
    member: member!,
    outsider: outsider!,
    workspace,
    other,
    project,
    cookie,
    base: `/api/workspaces/${workspace.id}/automation`,
  };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
const ruleBody = (f: Fixture, extra: Partial<AutomationRuleInput> = {}) =>
  automationRuleSchema.parse({
    name: 'Response automation',
    description: '',
    enabled: true,
    triggerType: 'automation.manual',
    triggerVersion: 1,
    conditions: { mode: 'all', children: [] },
    actions: [
      {
        id: randomUUID(),
        type: 'notification.send',
        userId: f.member.id,
        title: 'Automation update',
      },
    ],
    ...extra,
  });
const ruleFor = (f: Fixture, extra: Partial<AutomationRuleInput> = {}) =>
  AutomationRuleModel.create({
    ...ruleBody(f, extra),
    workspaceId: f.workspace.id,
    createdBy: f.owner.id,
    updatedBy: f.owner.id,
  });
const queue = async (
  f: Fixture,
  rule: Awaited<ReturnType<typeof ruleFor>>,
  extra: Partial<AutomationPayload> = {},
) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() =>
      emitDomainEvent(session, {
        workspaceId: f.workspace.id,
        eventType: rule.triggerType,
        aggregateType: 'automation',
        aggregateId: rule.id,
        eventId: randomUUID(),
        payload: { actorId: f.owner.id, ...extra },
        ...(rule.triggerType === 'automation.manual' ? { targetRuleId: rule.id } : {}),
      }),
    );
  } finally {
    await session.endSession();
  }
  const event = await claimEvent('test');
  expect(event).toBeTruthy();
  await processEvent(event!);
  return AutomationRunModel.findOne({ workspaceId: f.workspace.id, ruleId: rule._id });
};
const executeNext = async (adapters?: NetworkAdapters) => {
  const run = await claimRun('test');
  expect(run).toBeTruthy();
  await processRun(run!, adapters);
  return AutomationRunModel.findById(run!._id);
};
describe('automation authorization and workspace boundaries', () => {
  it('terminates an invalid persisted snapshot without effects or repeated claims', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    const queued = await queue(f, rule);
    await AutomationRunModel.updateOne({ _id: queued!._id }, { ruleSnapshot: { version: 99 } });
    const result = await executeNext();
    expect(result!.status).toBe('failed');
    expect(result!.error).toBe('INVALID_RULE_SNAPSHOT');
    expect(result!.leaseOwner).toBeUndefined();
    expect(await TaskModel.countDocuments()).toBe(0);
    expect(await claimRun('next')).toBeNull();
  });
  it('deduplicates an ambiguous manual retry even when the target state changed', async () => {
    const f = await fixture();
    const task = await executeTask({
      workspaceId: f.workspace.id,
      actorId: f.owner.id,
      projectId: f.project.id,
      fields: { title: 'Target' },
    });
    await OutboxEventModel.updateMany({}, { status: 'processed' });
    const rule = await ruleFor(f, {
      actions: [{ id: randomUUID(), type: 'task.update', field: 'status', value: 'todo' }],
    });
    const body = { operationId: randomUUID(), taskId: task.id };
    const cookie = await f.cookie();
    expect(
      (
        await request(app)
          .post(`${f.base}/rules/${rule.id}/execute`)
          .set('Cookie', cookie)
          .send(body)
      ).status,
    ).toBe(202);
    const event = await claimEvent('manual');
    await processEvent(event!);
    await executeNext();
    expect(
      (
        await request(app)
          .post(`${f.base}/rules/${rule.id}/execute`)
          .set('Cookie', cookie)
          .send(body)
      ).status,
    ).toBe(202);
    expect(await AutomationRunModel.countDocuments()).toBe(1);
    expect(
      (
        await request(app)
          .post(`${f.base}/rules/${rule.id}/execute`)
          .set('Cookie', cookie)
          .send({ ...body, taskId: undefined })
      ).status,
    ).toBe(409);
  });
  it('allows owner/admin management and denies members, outsiders and suspended users', async () => {
    const f = await fixture();
    for (const user of [f.owner, f.admin])
      expect(
        (
          await request(app)
            .post(`${f.base}/rules`)
            .set('Cookie', await f.cookie(user))
            .send(ruleBody(f))
        ).status,
      ).toBe(201);
    expect(
      (
        await request(app)
          .post(`${f.base}/rules`)
          .set('Cookie', await f.cookie(f.member))
          .send(ruleBody(f))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`${f.base}/rules`)
          .set('Cookie', await f.cookie(f.outsider))
      ).status,
    ).toBe(403);
    const cookie = await f.cookie(f.member);
    await UserModel.updateOne({ _id: f.member._id }, { status: 'suspended' });
    expect((await request(app).get(`${f.base}/rules`).set('Cookie', cookie)).status).toBe(401);
  });
  it('scopes rules, runs, integrations and dead letters and validates IDs before access', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    const run = await queue(f, rule);
    const foreignBase = `/api/workspaces/${f.other.id}/automation`;
    const cookie = await f.cookie(f.outsider);
    expect(
      (await request(app).get(`${foreignBase}/rules/${rule.id}`).set('Cookie', cookie)).status,
    ).toBe(404);
    expect(
      (await request(app).get(`${foreignBase}/runs/${run!.id}`).set('Cookie', cookie)).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`${foreignBase}/runs/${run!.id}/retry`)
          .set('Cookie', cookie)
          .send({})
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .get(`${f.base}/rules/invalid`)
          .set('Cookie', await f.cookie())
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get(`${f.base}/runs?limit=101`)
          .set('Cookie', await f.cookie())
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get(`${f.base}/runs`)
          .set('Cookie', await f.cookie(f.member))
      ).status,
    ).toBe(403);
  });
  it('rejects foreign assignments and stale rule versions', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    const cookie = await f.cookie();
    const invalid = ruleBody(f, {
      actions: [{ id: randomUUID(), type: 'task.assign', userId: f.outsider.id }],
    });
    expect(
      (await request(app).post(`${f.base}/rules/validate`).set('Cookie', cookie).send(invalid))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`${f.base}/rules/${rule.id}`)
          .set('Cookie', cookie)
          .send({ version: 9, rule: ruleBody(f) })
      ).status,
    ).toBe(409);
  });
  it('dry-runs without creating work, runs or notifications', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    const result = await request(app)
      .post(`${f.base}/rules/${rule.id}/dry-run`)
      .set('Cookie', await f.cookie())
      .send({ operationId: randomUUID() });
    expect(result.status).toBe(200);
    expect(result.body.matched).toBe(true);
    expect(await AutomationRunModel.countDocuments()).toBe(0);
    expect(await NotificationModel.countDocuments()).toBe(0);
  });
});
describe('transactional events, leases and effects', () => {
  it('confirms a committed receipt after an ambiguous transaction error', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    await queue(f, rule);
    const run = await claimRun('ambiguous');
    const actionSession = await mongoose.startSession();
    const original = actionSession.withTransaction.bind(actionSession);
    vi.spyOn(actionSession, 'withTransaction').mockImplementation(async (callback) => {
      await original(callback);
      throw new Error('Ambiguous committed response');
    });
    vi.spyOn(mongoose, 'startSession').mockResolvedValueOnce(actionSession);
    await processRun(run!);
    expect((await AutomationRunModel.findById(run!._id))!.status).toBe('succeeded');
    expect(await NotificationModel.countDocuments()).toBe(1);
  });
  it('prevents indirect severity/timeline cycles and enforces maximum depth', async () => {
    const f = await fixture();
    const incident = await executeIncident({
      workspaceId: f.workspace.id,
      actorId: f.owner.id,
      declaration: {
        operationId: randomUUID(),
        title: 'Cycle',
        summary: '',
        impact: '',
        severity: 'sev3',
        confirmSev1: false,
        responderIds: [],
        linkedProjectIds: [],
        linkedTaskIds: [],
      },
    });
    await OutboxEventModel.updateMany({}, { status: 'processed' });
    const a = await ruleFor(f, {
      triggerType: 'incident.severityChanged',
      actions: [{ id: randomUUID(), type: 'incident.timeline', message: 'Severity noted' }],
    });
    await ruleFor(f, {
      triggerType: 'incident.timelineAdded',
      actions: [{ id: randomUUID(), type: 'incident.severity', severity: 'sev2' }],
    });
    await queue(f, a, { incidentId: incident.id });
    await executeNext();
    const timeline = await claimEvent('timeline');
    await processEvent(timeline!);
    await executeNext();
    const severity = await claimEvent('severity');
    await processEvent(severity!);
    expect(await claimRun('cycle')).toBeNull();
    expect(
      await AutomationRunModel.countDocuments({ status: 'skipped', error: 'LOOP_PREVENTED' }),
    ).toBe(1);
    expect(await IncidentEventModel.countDocuments()).toBe(3);
    await OutboxEventModel.updateOne(
      { _id: severity!._id },
      { status: 'pending', eventId: randomUUID(), chainDepth: 8, rulePath: [] },
    );
    const deep = await claimEvent('deep');
    await processEvent(deep!);
    expect(
      await AutomationRunModel.countDocuments({ status: 'skipped', error: 'LOOP_PREVENTED' }),
    ).toBe(2);
  });
  it('rolls back partially queued rule matching and recovers on retry', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() =>
        emitDomainEvent(session, {
          workspaceId: f.workspace.id,
          eventType: 'automation.manual',
          aggregateType: 'automation',
          aggregateId: rule.id,
          payload: { actorId: f.owner.id },
        }),
      );
    } finally {
      await session.endSession();
    }
    vi.spyOn(AutomationRunModel, 'updateOne').mockRejectedValueOnce(
      new Error('Interrupted snapshot write'),
    );
    const event = await claimEvent('first');
    await processEvent(event!);
    expect(await AutomationRunModel.countDocuments()).toBe(0);
    expect((await OutboxEventModel.findById(event!._id))!.status).toBe('pending');
    await OutboxEventModel.updateOne({ _id: event!._id }, { availableAt: new Date(0) });
    const recovered = await claimEvent('second');
    await processEvent(recovered!);
    expect(await AutomationRunModel.countDocuments()).toBe(1);
  });
  it('rolls back incident state, timeline, activity and notifications when outbox insertion fails', async () => {
    const f = await fixture();
    vi.spyOn(OutboxEventModel, 'create').mockRejectedValueOnce(
      new Error('Injected outbox failure'),
    );
    await expect(
      executeIncident({
        workspaceId: f.workspace.id,
        actorId: f.owner.id,
        declaration: {
          operationId: randomUUID(),
          title: 'Failure',
          summary: '',
          impact: '',
          severity: 'sev3',
          confirmSev1: false,
          responderIds: [],
          linkedProjectIds: [],
          linkedTaskIds: [],
        },
      }),
    ).rejects.toThrow();
    expect(await IncidentModel.countDocuments()).toBe(0);
    expect(await IncidentEventModel.countDocuments()).toBe(0);
    expect(await ActivityModel.countDocuments()).toBe(0);
    expect(await NotificationModel.countDocuments()).toBe(0);
  });
  it('rolls back task creation when event insertion fails', async () => {
    const f = await fixture();
    vi.spyOn(OutboxEventModel, 'create').mockRejectedValueOnce(new Error('Injected'));
    await expect(
      executeTask({
        workspaceId: f.workspace.id,
        actorId: f.owner.id,
        projectId: f.project.id,
        fields: { title: 'Task', assigneeId: f.member.id },
      }),
    ).rejects.toThrow();
    expect(await TaskModel.countDocuments()).toBe(0);
    expect(await NotificationModel.countDocuments()).toBe(0);
  });
  it('claims one event concurrently, recovers expired leases and fences stale workers', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() =>
        emitDomainEvent(session, {
          workspaceId: f.workspace.id,
          eventType: 'automation.manual',
          aggregateType: 'automation',
          aggregateId: rule.id,
          payload: { actorId: f.owner.id },
        }),
      );
    } finally {
      await session.endSession();
    }
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, n) => claimEvent(`worker-${n}`)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const stale = claims.find(Boolean)!;
    await OutboxEventModel.updateOne({ _id: stale._id }, { leaseExpiresAt: new Date(0) });
    const recovered = await claimEvent('replacement');
    expect(recovered!.leaseOwner).not.toBe(stale.leaseOwner);
    await processEvent(stale);
    expect(await AutomationRunModel.countDocuments()).toBe(0);
    await processEvent(recovered!);
    expect(await AutomationRunModel.countDocuments()).toBe(1);
  });
  it('atomically claims runs and resumes a crashed worker without duplicate effects', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    await queue(f, rule);
    const claims = await Promise.all([claimRun('a'), claimRun('b')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const stale = claims.find(Boolean)!;
    await AutomationRunModel.updateOne({ _id: stale._id }, { leaseExpiresAt: new Date(0) });
    const recovered = await claimRun('c');
    await processRun(recovered!);
    await processRun(stale).catch(() => undefined);
    expect(await NotificationModel.countDocuments()).toBe(1);
    expect((await AutomationRunModel.findById(stale._id))!.status).toBe('succeeded');
  });
  it('preserves the rule snapshot and uses a system identity after the creator loses membership', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    await queue(f, rule);
    await AutomationRuleModel.updateOne(
      { _id: rule._id },
      {
        actions: [
          { id: randomUUID(), type: 'notification.send', userId: f.outsider.id, title: 'Changed' },
        ],
      },
    );
    await WorkspaceMemberModel.deleteOne({ workspaceId: f.workspace.id, userId: f.owner.id });
    const run = await executeNext();
    expect(run!.status).toBe('succeeded');
    const notification = await NotificationModel.findOne();
    expect(String(notification!.actorId)).toBe('000000000000000000000006');
    expect(String(notification!.recipientId)).toBe(f.member.id);
    expect((await ActivityModel.findOne({ entityType: 'automation' }))!.metadata.configuredBy).toBe(
      f.owner.id,
    );
  });
  it('retries only failed actions and never duplicates tasks or notifications', async () => {
    const f = await fixture();
    const rule = await ruleFor(f, {
      actions: [
        { id: randomUUID(), type: 'task.create', projectId: f.project.id, title: 'Created once' },
        {
          id: randomUUID(),
          type: 'notification.send',
          userId: f.member.id,
          title: 'Delivered once',
        },
      ],
    });
    await queue(f, rule);
    await WorkspaceMemberModel.updateOne(
      { workspaceId: f.workspace.id, userId: f.member.id },
      { disabled: true },
    );
    const failed = await executeNext();
    expect(failed!.status).toBe('partiallyFailed');
    expect(failed!.actionResults[0].status).toBe('succeeded');
    expect(await TaskModel.countDocuments()).toBe(1);
    await WorkspaceMemberModel.updateOne(
      { workspaceId: f.workspace.id, userId: f.member.id },
      { disabled: false },
    );
    expect(
      (
        await request(app)
          .post(`${f.base}/runs/${failed!.id}/retry`)
          .set('Cookie', await f.cookie())
          .send({})
      ).status,
    ).toBe(200);
    const succeeded = await executeNext();
    expect(succeeded!.status).toBe('succeeded');
    expect(await TaskModel.countDocuments()).toBe(1);
    expect(await NotificationModel.countDocuments()).toBe(1);
    expect(succeeded!.attemptCount).toBe(2);
  });
  it('bounds temporary retries and enters dead-letter state', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    await queue(f, rule);
    const event = await OutboxEventModel.findOne();
    await OutboxEventModel.updateOne(
      { _id: event!._id },
      { status: 'pending', payload: { bad: true }, attemptCount: 4 },
    );
    const claimed = await claimEvent('bad');
    await processEvent(claimed!);
    expect((await OutboxEventModel.findById(event!._id))!.status).toBe('dead');
    expect(
      (
        await request(app)
          .post(`${f.base}/dead-letters/${event!.id}/replay`)
          .set('Cookie', await f.cookie(f.member))
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${f.base}/dead-letters/${event!.id}/replay`)
          .set('Cookie', await f.cookie())
          .send({})
      ).status,
    ).toBe(202);
    expect(retryDelay(2, () => 0)).toBe(4000);
  });
  it('cancels queued runs without effects and denies cancelling running work', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    const run = await queue(f, rule);
    const cookie = await f.cookie();
    expect(
      (await request(app).post(`${f.base}/runs/${run!.id}/cancel`).set('Cookie', cookie).send({}))
        .status,
    ).toBe(200);
    expect(await claimRun('worker')).toBeNull();
    expect(await NotificationModel.countDocuments()).toBe(0);
    await queue(f, rule);
    const running = await claimRun('worker');
    expect(
      (
        await request(app)
          .post(`${f.base}/runs/${running!.id}/cancel`)
          .set('Cookie', cookie)
          .send({})
      ).status,
    ).toBe(409);
  });
  it('prevents a rule from recursively creating tasks', async () => {
    const f = await fixture();
    const rule = await ruleFor(f, {
      triggerType: 'task.created',
      actions: [
        { id: randomUUID(), type: 'task.create', projectId: f.project.id, title: 'Follow-up' },
      ],
    });
    await queue(f, rule);
    await executeNext();
    const event = await claimEvent('loop');
    await processEvent(event!);
    expect(await TaskModel.countDocuments()).toBe(1);
    expect(
      await AutomationRunModel.countDocuments({ status: 'skipped', error: 'LOOP_PREVENTED' }),
    ).toBe(1);
  });
  it('enforces the incident state machine and makes invalid transitions side-effect free', async () => {
    const f = await fixture();
    const incident = await executeIncident({
      workspaceId: f.workspace.id,
      actorId: f.owner.id,
      declaration: {
        operationId: randomUUID(),
        title: 'Response',
        summary: '',
        impact: '',
        severity: 'sev3',
        confirmSev1: false,
        responderIds: [],
        linkedProjectIds: [],
        linkedTaskIds: [],
      },
    });
    await OutboxEventModel.updateMany({}, { status: 'processed' });
    const rule = await ruleFor(f, {
      actions: [
        {
          id: randomUUID(),
          type: 'incident.transition',
          status: 'resolved',
          resolutionSummary: 'Invalid shortcut',
        },
      ],
    });
    await queue(f, rule, { incidentId: incident.id });
    const run = await executeNext();
    expect(run!.status).toBe('failed');
    expect((await IncidentModel.findById(incident._id))!.status).toBe('declared');
    expect(await IncidentEventModel.countDocuments()).toBe(1);
  });
  it('runs multiple independent workers and stops claiming during shutdown', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    await queue(f, rule);
    await queue(f, rule);
    const a = new AutomationWorker(1),
      b = new AutomationWorker(1);
    expect(a.id).not.toBe(b.id);
    await Promise.all([a.tick(), b.tick()]);
    await Promise.all([a.stop(), b.stop()]);
    expect(await NotificationModel.countDocuments()).toBe(2);
    await a.tick();
    expect(await AutomationRunModel.countDocuments({ status: 'running' })).toBe(0);
  });
});
describe('integration credentials, signed ingestion and deliveries', () => {
  const createIntegration = async (f: Fixture) =>
    request(app)
      .post(`${f.base}/integrations`)
      .set('Cookie', await f.cookie())
      .send({
        name: 'Alerts',
        type: 'genericWebhook',
        status: 'active',
        endpoint: 'https://hooks.company.com/alerts',
        inboundEvents: ['alert.received'],
        outboundEvents: ['automation.manual'],
      });
  it('encrypts with tenant-bound authentication and never returns stored credentials', async () => {
    const f = await fixture();
    const result = await createIntegration(f);
    expect(result.status).toBe(201);
    const stored = await IntegrationModel.findById(result.body.integration.id).select(
      '+credentials',
    );
    expect(stored!.credentials).not.toContain(result.body.secret);
    expect(decryptSecret(stored as NonNullable<typeof stored> & { credentials: string })).toBe(
      result.body.secret,
    );
    expect(
      (
        await request(app)
          .get(`${f.base}/integrations`)
          .set('Cookie', await f.cookie())
      ).text,
    ).not.toContain(result.body.secret);
    expect(result.body.integration.credentials).toBeUndefined();
    expect(() =>
      decryptSecret({ ...stored!.toObject(), workspaceId: f.other._id } as NonNullable<
        typeof stored
      > & { credentials: string }),
    ).toThrow();
    const encrypted = encryptSecret('secret', f.workspace.id, result.body.integration.id);
    expect(encrypted.keyVersion).toBe('1');
  });
  it('ingests authenticated alerts only for explicit rules and rejects replay and cross-workspace IDs', async () => {
    const f = await fixture();
    const result = await createIntegration(f);
    const id = result.body.integration.id as string;
    await ruleFor(f, {
      inboundIntegrationId: id,
      actions: [
        { id: randomUUID(), type: 'incident.declare', title: 'Signed alert', severity: 'sev3' },
      ],
    });
    const body = JSON.stringify({
      schemaVersion: 1,
      eventType: 'alert.received',
      severity: 'sev3',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = randomUUID();
    const send = (
      workspaceId = f.workspace.id,
      signature = signBody(result.body.secret, timestamp, deliveryId, body),
    ) =>
      request(app)
        .post(`/api/webhooks/${workspaceId}/${id}`)
        .set('content-type', 'application/json')
        .set('x-flowryn-timestamp', timestamp)
        .set('x-flowryn-delivery-id', deliveryId)
        .set('x-flowryn-signature', signature)
        .send(body);
    expect((await send(f.workspace.id, '00'.repeat(32))).status).toBe(401);
    expect(await OutboxEventModel.countDocuments()).toBe(0);
    expect((await send(f.other.id)).status).toBe(401);
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(401);
    const event = await claimEvent('inbound');
    await processEvent(event!);
    expect((await executeNext())!.status).toBe('succeeded');
    expect(await IncidentModel.countDocuments()).toBe(1);
    expect(await WebhookDeliveryModel.countDocuments({ direction: 'inbound' })).toBe(1);
  });
  it('rejects expired, malformed, oversized, unconfigured and rate-limited alerts without work', async () => {
    const f = await fixture();
    const result = await createIntegration(f);
    const id = result.body.integration.id as string;
    const url = `/api/webhooks/${f.workspace.id}/${id}`;
    const send = (body: string, timestamp = String(Math.floor(Date.now() / 1000))) => {
      const deliveryId = randomUUID();
      return request(app)
        .post(url)
        .set('content-type', 'application/json')
        .set('x-flowryn-timestamp', timestamp)
        .set('x-flowryn-delivery-id', deliveryId)
        .set('x-flowryn-signature', signBody(result.body.secret, timestamp, deliveryId, body))
        .send(body);
    };
    expect((await send('{bad')).status).toBe(401);
    expect(
      (
        await send(
          JSON.stringify({ schemaVersion: 1, eventType: 'alert.received', severity: 'sev3' }),
        )
      ).status,
    ).toBe(401);
    expect((await send('{}', String(Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
    expect((await send('x'.repeat(17000))).status).toBe(400);
    for (let n = 0; n < 60; n++) await send('{}');
    expect((await send('{}')).status).toBe(429);
    expect(await OutboxEventModel.countDocuments()).toBe(0);
    expect(await IncidentModel.countDocuments()).toBe(0);
  });
  it('rotates secrets, redacts delivery failures and retries one persistent delivery', async () => {
    const f = await fixture();
    const result = await createIntegration(f);
    const id = result.body.integration.id as string;
    const rule = await ruleFor(f, {
      actions: [{ id: randomUUID(), type: 'webhook.invoke', integrationId: id }],
    });
    await queue(f, rule);
    const send = vi.fn().mockResolvedValueOnce(503).mockResolvedValueOnce(204);
    const adapters: NetworkAdapters = {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send,
    };
    const first = await executeNext(adapters);
    expect(first!.status).toBe('queued');
    await AutomationRunModel.updateOne({ _id: first!._id }, { availableAt: new Date(0) });
    expect((await executeNext(adapters))!.status).toBe('succeeded');
    expect(await WebhookDeliveryModel.countDocuments({ direction: 'outbound' })).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    const deliveryIds = send.mock.calls.map(
      (call) => (call[2] as Record<string, string>)['x-flowryn-delivery-id'],
    );
    expect(deliveryIds[0]).toBe(deliveryIds[1]);
    const rotated = await request(app)
      .post(`${f.base}/integrations/${id}/rotate`)
      .set('Cookie', await f.cookie())
      .send({});
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).not.toBe(result.body.secret);
    expect(rotated.body.integration.credentials).toBeUndefined();
    const history = await request(app)
      .get(`${f.base}/integrations/${id}/deliveries`)
      .set('Cookie', await f.cookie());
    expect(history.text).not.toContain(result.body.secret);
  });
  it('aggregates terminal rates, skipped/cancelled exclusions and retry counts server-side', async () => {
    const f = await fixture();
    const rule = await ruleFor(f);
    await queue(f, rule);
    await executeNext();
    await queue(f, rule);
    await AutomationRunModel.updateOne(
      { status: 'queued' },
      { status: 'partiallyFailed', attemptCount: 3 },
    );
    await queue(f, rule);
    await AutomationRunModel.updateOne({ status: 'queued' }, { status: 'cancelled' });
    const metrics = await automationMetrics(f.workspace.id);
    expect(metrics.successRate).toBe(0.5);
    expect(metrics.failureRate).toBe(0.5);
    expect(metrics.summary.retryCount).toBe(2);
    expect(metrics.failingRules).toHaveLength(1);
    expect((await automationMetrics(f.other.id)).successRate).toBeNull();
  });
});
