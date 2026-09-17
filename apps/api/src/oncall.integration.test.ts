import { randomUUID } from 'node:crypto';

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

import { createApp } from './app.js';
import { issueTokens } from './auth/tokens.js';
import {
  AutomationWorker,
  claimEvent,
  claimRun,
  processEvent,
  processRun,
} from './automation/engine.js';
import {
  AutomationRuleModel,
  AutomationRunModel,
  IntegrationModel,
  OutboxEventModel,
} from './automation/models.js';
import { encryptSecret, signBody, type NetworkAdapters } from './automation/security.js';
import { executeIncident } from './incidents/service.js';
import { ActivityModel } from './models/Activity.js';
import { IncidentModel } from './models/Incident.js';
import { IncidentEventModel } from './models/IncidentEvent.js';
import { NotificationModel } from './models/Notification.js';
import { UserModel } from './models/User.js';
import { WorkspaceModel } from './models/Workspace.js';
import { WorkspaceMemberModel } from './models/WorkspaceMember.js';
import { claimEscalation, processEscalation, resumeSuppressedAlert } from './oncall/escalation.js';
import { oncallMetrics } from './oncall/metrics.js';
import {
  AlertModel,
  AlertReceiptModel,
  EscalationModel,
  EscalationDeliveryModel,
  PolicyModel,
  ScheduleModel,
  OverrideModel,
  RoutingModel,
} from './oncall/models.js';
import { createAlert, transact } from './oncall/service.js';
const app = createApp();
let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  process.env.AUTOMATION_ENCRYPTION_KEYS = JSON.stringify({ '1': 'ab'.repeat(32) });
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
}, 30000);
const fixture = async () => {
  const [owner, member, outsider] = await UserModel.create(
    ['owner', 'member', 'outsider'].map((name) => ({
      name,
      email: `${name}@test.dev`,
      passwordHash: 'unused',
    })),
  );
  const workspace = await WorkspaceModel.create({ name: 'Operations', createdBy: owner!.id });
  const other = await WorkspaceModel.create({ name: 'Other', createdBy: outsider!.id });
  await WorkspaceMemberModel.create([
    { workspaceId: workspace.id, userId: owner!.id, role: 'owner' },
    { workspaceId: workspace.id, userId: member!.id, role: 'member' },
    { workspaceId: other.id, userId: outsider!.id, role: 'owner' },
  ]);
  const cookie = async (user = owner!) => `accessToken=${(await issueTokens(user.id)).accessToken}`;
  return {
    owner: owner!,
    member: member!,
    outsider: outsider!,
    workspace,
    other,
    cookie,
    base: `/api/workspaces/${workspace.id}/oncall`,
  };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
const scheduleFields = (f: Fixture) => ({
  name: 'Primary',
  description: '',
  timezone: 'UTC',
  enabled: true,
  allowSelfOverrides: false,
  layers: [
    {
      id: randomUUID(),
      name: 'Primary',
      participants: [f.member.id],
      startsAt: '2026-01-01T00:00:00Z',
      shiftMinutes: 1440,
      handoff: 'elapsedUTC',
    },
  ],
});
const policyFor = (f: Fixture, extra: Record<string, unknown> = {}) =>
  PolicyModel.create({
    workspaceId: f.workspace.id,
    name: 'Paging',
    description: '',
    enabled: true,
    steps: [
      {
        id: randomUUID(),
        delayMinutes: 0,
        target: { type: 'users', userIds: [f.member.id] },
        webhookIntegrationIds: [],
      },
    ],
    repeatCount: 0,
    repeatDelayMinutes: 5,
    createdBy: f.owner.id,
    updatedBy: f.owner.id,
    ...extra,
  });
const fields = (policyId?: string, extra: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  fingerprint: 'service/down',
  title: 'Service unavailable',
  summary: 'Safe summary',
  severity: 'sev3',
  ...(policyId ? { escalationPolicyId: policyId } : {}),
  labels: { env: 'prod' },
  ...extra,
});
const alertFor = async (f: Fixture, policyId?: string, extra: Record<string, unknown> = {}) => {
  const result = await createAlert({
    workspaceId: f.workspace.id,
    actorId: f.owner.id,
    fields: fields(policyId, extra),
  });
  return result!.alert;
};
const command = async (
  f: Fixture,
  id: string,
  action: string,
  body: Record<string, unknown> = {},
  user = f.owner,
) =>
  request(app)
    .post(`${f.base}/alerts/${id}/${action}`)
    .set('Cookie', await f.cookie(user))
    .send({ operationId: randomUUID(), ...body });
const integrationFor = async (f: Fixture) => {
  const id = new mongoose.Types.ObjectId();
  return IntegrationModel.create({
    _id: id,
    workspaceId: f.workspace.id,
    name: 'Webhook',
    status: 'active',
    endpoint: 'https://hooks.company.com/page',
    inboundEvents: ['alert.received'],
    outboundEvents: ['escalation.advanced'],
    ...encryptSecret('secret', f.workspace.id, String(id)),
    createdBy: f.owner.id,
    updatedBy: f.owner.id,
  });
};
const adapters: NetworkAdapters = {
  resolve: async () => [{ address: '8.8.8.8', family: 4 }],
  send: async () => 204,
};
describe('on-call authorization, scheduling and routing', () => {
  it('allows members to view but prevents schedule, policy and routing administration', async () => {
    const f = await fixture();
    const body = scheduleFields(f);
    expect(
      (
        await request(app)
          .post(`${f.base}/schedules`)
          .set('Cookie', await f.cookie(f.member))
          .send(body)
      ).status,
    ).toBe(403);
    const created = await request(app)
      .post(`${f.base}/schedules`)
      .set('Cookie', await f.cookie())
      .send(body);
    expect(created.status).toBe(201);
    expect(
      (
        await request(app)
          .get(`${f.base}/schedules/${created.body.item.id}/current`)
          .set('Cookie', await f.cookie(f.member))
      ).body.layerRecipients[0].userId,
    ).toBe(f.member.id);
    expect(
      (
        await request(app)
          .get(`${f.base}/schedules`)
          .set('Cookie', await f.cookie(f.outsider))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${f.base}/policies`)
          .set('Cookie', await f.cookie(f.member))
          .send({
            name: 'P',
            enabled: true,
            steps: [
              {
                id: randomUUID(),
                delayMinutes: 0,
                target: { type: 'users', userIds: [f.member.id] },
              },
            ],
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`${f.base}/schedules/invalid`)
          .set('Cookie', await f.cookie())
      ).status,
    ).toBe(400);
  });
  it('rejects cross-workspace and suspended participants and stale schedule edits', async () => {
    const f = await fixture();
    const body = scheduleFields(f);
    body.layers[0]!.participants = [f.outsider.id];
    expect(
      (
        await request(app)
          .post(`${f.base}/schedules`)
          .set('Cookie', await f.cookie())
          .send(body)
      ).status,
    ).toBe(400);
    body.layers[0]!.participants = [f.member.id];
    const created = await request(app)
      .post(`${f.base}/schedules`)
      .set('Cookie', await f.cookie())
      .send(body);
    expect(
      (
        await request(app)
          .put(`${f.base}/schedules/${created.body.item.id}`)
          .set('Cookie', await f.cookie())
          .send({ version: 99, config: body })
      ).status,
    ).toBe(409);
    await UserModel.updateOne({ _id: f.member._id }, { status: 'suspended' });
    expect(
      (
        await request(app)
          .post(`${f.base}/schedules`)
          .set('Cookie', await f.cookie())
          .send(body)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get(`${f.base}/schedules/${created.body.item.id}/current`)
          .set('Cookie', await f.cookie())
      ).body.layerRecipients[0].userId,
    ).toBeNull();
    expect(
      (
        await request(app)
          .get(`${f.base}/alerts`)
          .set('Cookie', await f.cookie(f.member))
      ).status,
    ).toBe(401);
  });
  it('serializes overlapping overrides and preserves cancelled history', async () => {
    const f = await fixture();
    const config = scheduleFields(f);
    const schedule = await ScheduleModel.create({
      ...config,
      workspaceId: f.workspace.id,
      createdBy: f.owner.id,
      updatedBy: f.owner.id,
    });
    const body = {
      layerId: config.layers[0]!.id,
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-01-01T01:00:00Z',
      replacementUserId: f.owner.id,
      reason: 'Cover shift',
    };
    const cookie = await f.cookie();
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(app)
          .post(`${f.base}/schedules/${schedule.id}/overrides`)
          .set('Cookie', cookie)
          .send(body),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const item = await OverrideModel.findOne({ workspaceId: f.workspace.id });
    expect(
      (
        await request(app)
          .post(`${f.base}/schedules/${schedule.id}/overrides/${item!.id}/cancel`)
          .set('Cookie', cookie)
          .send({})
      ).status,
    ).toBe(200);
    expect(await OverrideModel.countDocuments()).toBe(1);
    expect((await OverrideModel.findById(item!._id))!.cancelledAt).toBeTruthy();
    expect(await ActivityModel.countDocuments({ action: 'oncall.overrideCancelled' })).toBe(1);
  });
  it('requires explicit self-override permission and proves the entire interval is owned', async () => {
    const f = await fixture();
    const config = scheduleFields(f);
    const schedule = await ScheduleModel.create({
      ...config,
      workspaceId: f.workspace.id,
      createdBy: f.owner.id,
      updatedBy: f.owner.id,
    });
    const from = new Date(Math.ceil(Date.now() / 60000) * 60000 + 60000).toISOString();
    const body = {
      layerId: config.layers[0]!.id,
      startsAt: from,
      endsAt: new Date(Date.parse(from) + 60000).toISOString(),
      replacementUserId: f.owner.id,
      originalUserId: f.member.id,
      reason: 'Swap',
    };
    const send = async () =>
      request(app)
        .post(`${f.base}/schedules/${schedule.id}/overrides`)
        .set('Cookie', await f.cookie(f.member))
        .send(body);
    expect((await send()).status).toBe(403);
    await ScheduleModel.updateOne({ _id: schedule._id }, { allowSelfOverrides: true });
    expect((await send()).status).toBe(201);
    expect(
      (
        await request(app)
          .post(`${f.base}/schedules/${schedule.id}/overrides`)
          .set('Cookie', await f.cookie(f.member))
          .send({ ...body, originalUserId: f.owner.id })
      ).status,
    ).toBe(403);
  });
  it('validates policies and rejects foreign schedules and excessive repeats', async () => {
    const f = await fixture();
    const foreign = await ScheduleModel.create({
      ...scheduleFields(f),
      workspaceId: f.other.id,
      createdBy: f.outsider.id,
      updatedBy: f.outsider.id,
    });
    const body = {
      name: 'Policy',
      enabled: true,
      steps: [
        { id: randomUUID(), delayMinutes: 0, target: { type: 'schedule', scheduleId: foreign.id } },
      ],
      repeatCount: 0,
    };
    expect(
      (
        await request(app)
          .post(`${f.base}/policies`)
          .set('Cookie', await f.cookie())
          .send(body)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`${f.base}/policies`)
          .set('Cookie', await f.cookie())
          .send({ ...body, repeatCount: 4 })
      ).status,
    ).toBe(400);
  });
  it('selects deterministic priorities, skips inactive policies and applies fallback without effects in dry-run', async () => {
    const f = await fixture();
    const first = await policyFor(f),
      second = await policyFor(f);
    await RoutingModel.create([
      {
        workspaceId: f.workspace.id,
        name: 'Low',
        enabled: true,
        priority: 10,
        policyId: second._id,
        conditions: [],
        createdBy: f.owner.id,
        updatedBy: f.owner.id,
      },
      {
        workspaceId: f.workspace.id,
        name: 'High',
        enabled: true,
        priority: 0,
        policyId: first._id,
        conditions: [{ field: 'severity', value: 'sev3' }],
        createdBy: f.owner.id,
        updatedBy: f.owner.id,
      },
    ]);
    const preview = await request(app)
      .post(`${f.base}/routing/dry-run`)
      .set('Cookie', await f.cookie())
      .send(fields());
    expect(preview.body.policyId).toBe(first.id);
    expect(await AlertModel.countDocuments()).toBe(0);
    await RoutingModel.updateMany({ workspaceId: f.workspace.id }, { enabled: false });
    await WorkspaceModel.updateOne(
      { _id: f.workspace._id },
      { oncallFallbackPolicyId: second._id },
    );
    expect((await alertFor(f)).escalationPolicyId!.toString()).toBe(second.id);
  });
});
describe('atomic alerts and lifecycle integration', () => {
  it('deduplicates concurrent fingerprints and stable operation IDs into one escalation', async () => {
    const f = await fixture();
    const policy = await policyFor(f);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        createAlert({
          workspaceId: f.workspace.id,
          actorId: f.owner.id,
          fields: fields(policy.id),
        }),
      ),
    );
    expect(responses.every(Boolean)).toBe(true);
    expect(await AlertModel.countDocuments()).toBe(1);
    expect((await AlertModel.findOne())!.occurrenceCount).toBe(6);
    expect(await EscalationModel.countDocuments()).toBe(1);
    const same = fields(policy.id);
    await Promise.all(
      [1, 2].map(() =>
        createAlert({ workspaceId: f.workspace.id, actorId: f.owner.id, fields: same }),
      ),
    );
    expect((await AlertModel.findOne())!.occurrenceCount).toBe(7);
  });
  it('rolls back alert, escalation, activity and outbox together', async () => {
    const f = await fixture();
    const policy = await policyFor(f);
    await expect(
      transact(async (session) => {
        await createAlert({
          workspaceId: f.workspace.id,
          actorId: f.owner.id,
          fields: fields(policy.id),
          session,
        });
        throw new Error('Rollback');
      }),
    ).rejects.toThrow('Rollback');
    expect(await AlertModel.countDocuments()).toBe(0);
    expect(await EscalationModel.countDocuments()).toBe(0);
    expect(await AlertReceiptModel.countDocuments()).toBe(0);
    expect(await OutboxEventModel.countDocuments()).toBe(0);
  });
  it('allows workspace members to acknowledge, restricts management and rejects foreign policy linking', async () => {
    const f = await fixture();
    const policy = await policyFor(f);
    const alert = await alertFor(f, policy.id);
    expect((await command(f, alert.id, 'resolve', {}, f.member)).status).toBe(403);
    expect((await command(f, alert.id, 'acknowledge', {}, f.member)).status).toBe(200);
    expect((await EscalationModel.findOne())!.status).toBe('cancelled');
    const foreign = await policyFor(f, { workspaceId: f.other.id });
    expect(
      (
        await request(app)
          .post(`${f.base}/alerts`)
          .set('Cookie', await f.cookie())
          .send(fields(foreign.id))
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get(`${f.base}/alerts/${alert.id}/history`)
          .set('Cookie', await f.cookie(f.member))
      ).status,
    ).toBe(403);
  });
  it('retains deduplicated resolved alerts and starts only explicit reopen cycles', async () => {
    const f = await fixture();
    const policy = await policyFor(f);
    const alert = await alertFor(f, policy.id);
    await command(f, alert.id, 'resolve');
    await alertFor(f, policy.id);
    expect((await AlertModel.findById(alert._id))!.status).toBe('resolved');
    expect(await EscalationModel.countDocuments()).toBe(1);
    expect((await command(f, alert.id, 'reopen')).status).toBe(200);
    expect(await EscalationModel.countDocuments()).toBe(2);
    const states = await EscalationModel.find().sort({ alertCycle: 1 });
    expect(states.map((row) => row.status)).toEqual(['cancelled', 'queued']);
  });
  it('expires suppression through the existing worker and cancels previous work', async () => {
    const f = await fixture();
    const policy = await policyFor(f);
    const alert = await alertFor(f, policy.id);
    await command(f, alert.id, 'acknowledge', {}, f.member);
    const until = new Date(Date.now() + 60000).toISOString();
    expect((await command(f, alert.id, 'suppress', { until })).status).toBe(200);
    await resumeSuppressedAlert(new Date(Date.parse(until) + 1));
    const reopened = await AlertModel.findById(alert._id);
    expect(reopened!.status).toBe('open');
    expect(reopened!.acknowledgedAt).toBeUndefined();
    expect(reopened!.acknowledgedBy).toBeUndefined();
    expect(reopened!.acknowledgedStep).toBeUndefined();
    expect(await EscalationModel.countDocuments({ status: 'queued' })).toBe(1);
    expect(await EscalationModel.countDocuments({ status: 'cancelled' })).toBe(1);
  });
  it('declares incidents through the existing service and rejects cross-workspace links', async () => {
    const f = await fixture();
    const alert = await alertFor(f);
    const declared = await command(f, alert.id, 'declare-incident');
    expect(declared.status).toBe(200);
    expect(await IncidentModel.countDocuments()).toBe(1);
    expect((await command(f, alert.id, 'timeline')).status).toBe(200);
    expect(await IncidentEventModel.countDocuments({ eventType: 'incident.timeline_added' })).toBe(
      1,
    );
    const foreign = await executeIncident({
      workspaceId: f.other.id,
      actorId: f.outsider.id,
      declaration: {
        operationId: randomUUID(),
        title: 'Foreign',
        summary: '',
        impact: '',
        severity: 'sev3',
        confirmSev1: false,
        responderIds: [],
        linkedProjectIds: [],
        linkedTaskIds: [],
      },
    });
    expect((await command(f, alert.id, 'link', { incidentId: foreign.id })).status).toBe(400);
  });
  it('ingests version-2 signed alerts, rejects replay and uses routing once', async () => {
    const f = await fixture();
    const policy = await policyFor(f);
    await WorkspaceModel.updateOne(
      { _id: f.workspace._id },
      { oncallFallbackPolicyId: policy._id },
    );
    const integration = await integrationFor(f);
    await AutomationRuleModel.create({
      workspaceId: f.workspace.id,
      name: 'Opened alert automation',
      enabled: true,
      triggerType: 'alert.opened',
      triggerVersion: 1,
      conditions: { mode: 'all', children: [] },
      actions: [
        {
          id: randomUUID(),
          type: 'alert.create',
          fingerprint: 'follow-up',
          title: 'Follow-up',
          severity: 'sev4',
        },
      ],
      createdBy: f.owner.id,
      updatedBy: f.owner.id,
    });
    const send = async (deliveryId: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000)),
        body = JSON.stringify({
          schemaVersion: 2,
          eventType: 'alert.received',
          fingerprint: 'signed/service',
          title: 'Signed alert',
          severity: 'sev3',
          labels: { env: 'prod' },
        });
      return request(app)
        .post(`/api/webhooks/${f.workspace.id}/${integration.id}`)
        .set('content-type', 'application/json')
        .set('x-flowryn-timestamp', timestamp)
        .set('x-flowryn-delivery-id', deliveryId)
        .set('x-flowryn-signature', signBody('secret', timestamp, deliveryId, body))
        .send(body);
    };
    const id = randomUUID();
    expect((await send(id)).status).toBe(202);
    await processEvent((await claimEvent('alert-opened'))!);
    expect(await AutomationRunModel.countDocuments()).toBe(1);
    expect((await send(id)).status).toBe(401);
    expect((await send(randomUUID())).status).toBe(202);
    expect((await AlertModel.findOne())!.occurrenceCount).toBe(2);
    expect(await EscalationModel.countDocuments()).toBe(1);
  });
  it('creates alerts through idempotent automation actions using the same chain', async () => {
    const f = await fixture();
    const policy = await policyFor(f);
    const rule = await AutomationRuleModel.create({
      workspaceId: f.workspace.id,
      name: 'Alert',
      enabled: true,
      triggerType: 'automation.manual',
      triggerVersion: 1,
      conditions: { mode: 'all', children: [] },
      actions: [
        {
          id: randomUUID(),
          type: 'alert.create',
          fingerprint: 'automated',
          title: 'Automated alert',
          severity: 'sev3',
          escalationPolicyId: policy.id,
        },
      ],
      createdBy: f.owner.id,
      updatedBy: f.owner.id,
    });
    const queued = await request(app)
      .post(`/api/workspaces/${f.workspace.id}/automation/rules/${rule.id}/execute`)
      .set('Cookie', await f.cookie())
      .send({ operationId: randomUUID() });
    expect(queued.status).toBe(202);
    await processEvent((await claimEvent('event'))!);
    await processRun((await claimRun('run'))!);
    expect(await AlertModel.countDocuments()).toBe(1);
    expect(await EscalationModel.countDocuments()).toBe(1);
  });
});
describe('durable escalation and acknowledgement arbitration', () => {
  it('claims once across workers, recovers leases and fences stale workers', async () => {
    const f = await fixture();
    await alertFor(f, (await policyFor(f)).id);
    const claims = await Promise.all([claimEscalation('a'), claimEscalation('b')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    await EscalationModel.updateOne({ _id: first._id }, { leaseExpiresAt: new Date(0) });
    const recovered = await claimEscalation('c');
    await processEscalation(first);
    expect(await NotificationModel.countDocuments()).toBe(0);
    await processEscalation(recovered!);
    expect(await NotificationModel.countDocuments()).toBe(1);
    expect((await EscalationModel.findById(first._id))!.status).toBe('completed');
    expect(await OutboxEventModel.countDocuments({ eventType: 'escalation.advanced' })).toBe(1);
  });
  it('prevents all deliveries when acknowledgement commits before a claimed step', async () => {
    const f = await fixture();
    const integration = await integrationFor(f);
    const policy = await policyFor(f, {
      steps: [
        {
          id: randomUUID(),
          delayMinutes: 0,
          target: { type: 'users', userIds: [f.member.id] },
          webhookIntegrationIds: [integration.id],
        },
      ],
    });
    const alert = await alertFor(f, policy.id);
    const job = await claimEscalation('worker');
    await command(f, alert.id, 'acknowledge', {}, f.member);
    const send = vi.fn().mockResolvedValue(204);
    await processEscalation(job!, { ...adapters, send });
    expect(send).not.toHaveBeenCalled();
    expect(await NotificationModel.countDocuments()).toBe(0);
  });
  it('arbitrates acknowledgement racing an admitted external dispatch and stops later steps', async () => {
    const f = await fixture();
    const integration = await integrationFor(f);
    const policy = await policyFor(f, {
      steps: [
        {
          id: randomUUID(),
          delayMinutes: 0,
          target: { type: 'users', userIds: [f.member.id] },
          webhookIntegrationIds: [integration.id],
        },
        {
          id: randomUUID(),
          delayMinutes: 1,
          target: { type: 'users', userIds: [f.owner.id] },
          webhookIntegrationIds: [],
        },
      ],
    });
    const alert = await alertFor(f, policy.id);
    let release!: () => void;
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      entered();
      await gate;
      return 204;
    });
    const work = processEscalation((await claimEscalation('worker'))!, { ...adapters, send });
    await admitted;
    const acknowledgement = command(f, alert.id, 'acknowledge', {}, f.member);
    release();
    await Promise.all([work, acknowledgement]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await AlertModel.findById(alert._id))!.status).toBe('acknowledged');
    expect(await claimEscalation('next', new Date(Date.now() + 86400000))).toBeNull();
  });
  it('resumes failed webhooks without duplicating successful private notifications', async () => {
    const f = await fixture();
    const integration = await integrationFor(f);
    const policy = await policyFor(f, {
      steps: [
        {
          id: randomUUID(),
          delayMinutes: 0,
          target: { type: 'users', userIds: [f.member.id] },
          webhookIntegrationIds: [integration.id],
        },
      ],
    });
    const alert = await alertFor(f, policy.id);
    const send = vi.fn().mockResolvedValueOnce(503).mockResolvedValueOnce(204);
    await processEscalation((await claimEscalation('first'))!, { ...adapters, send });
    expect(await NotificationModel.countDocuments()).toBe(1);
    await EscalationModel.updateMany({ alertId: alert._id }, { nextEscalationAt: new Date(0) });
    await processEscalation((await claimEscalation('retry'))!, { ...adapters, send });
    expect(await NotificationModel.countDocuments()).toBe(1);
    expect(send.mock.calls[0]![2]['x-flowryn-delivery-id']).toBe(
      send.mock.calls[1]![2]['x-flowryn-delivery-id'],
    );
    expect(await EscalationDeliveryModel.countDocuments({ status: 'succeeded' })).toBe(2);
  });
  it('uses live schedule recipients and immutable policy versions', async () => {
    const f = await fixture();
    const config = scheduleFields(f);
    const schedule = await ScheduleModel.create({
      ...config,
      workspaceId: f.workspace.id,
      createdBy: f.owner.id,
      updatedBy: f.owner.id,
    });
    const policy = await policyFor(f, {
      steps: [
        {
          id: randomUUID(),
          delayMinutes: 0,
          target: { type: 'schedule', scheduleId: schedule.id },
          webhookIntegrationIds: [],
        },
      ],
    });
    await alertFor(f, policy.id);
    await PolicyModel.updateOne({ _id: policy._id }, { steps: [], version: 2 });
    await ScheduleModel.updateOne(
      { _id: schedule._id },
      { layers: [{ ...config.layers[0], participants: [f.owner.id] }] },
    );
    await processEscalation((await claimEscalation('worker'))!);
    expect((await NotificationModel.findOne())!.recipientId.toString()).toBe(f.owner.id);
    expect((await EscalationModel.findOne())!.policyVersion).toBe(1);
  });
  it('dead-letters missing recipients and permanently denied webhooks with safe eligible retry', async () => {
    const f = await fixture();
    const integration = await integrationFor(f);
    const policy = await policyFor(f, {
      steps: [
        {
          id: randomUUID(),
          delayMinutes: 0,
          target: { type: 'users', userIds: [f.member.id] },
          webhookIntegrationIds: [integration.id],
        },
      ],
    });
    const alert = await alertFor(f, policy.id);
    await processEscalation((await claimEscalation('worker'))!, {
      ...adapters,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const delivery = await EscalationDeliveryModel.findOne({ channel: 'webhook' });
    expect(delivery!.status).toBe('dead');
    expect(delivery!.error).toBe('DESTINATION_DENIED');
    const retryOperationId = randomUUID();
    expect(
      (
        await request(app)
          .post(`${f.base}/deliveries/${delivery!.id}/retry`)
          .set('Cookie', await f.cookie())
          .send({ operationId: retryOperationId })
      ).status,
    ).toBe(202);
    expect(
      (
        await request(app)
          .post(`${f.base}/deliveries/${delivery!.id}/retry`)
          .set('Cookie', await f.cookie())
          .send({ operationId: retryOperationId })
      ).status,
    ).toBe(202);
    expect(
      (
        await request(app)
          .post(`${f.base}/deliveries/${delivery!.id}/retry`)
          .set('Cookie', await f.cookie())
          .send({ operationId: randomUUID() })
      ).status,
    ).toBe(409);
    await processEscalation((await claimEscalation('retry'))!, adapters);
    expect((await EscalationDeliveryModel.findById(delivery!._id))!.status).toBe('succeeded');
    expect((await EscalationModel.findOne())!.status).toBe('completed');
    expect(await OutboxEventModel.countDocuments({ eventType: 'escalation.advanced' })).toBe(1);
    await command(f, alert.id, 'acknowledge', {}, f.member);
    expect(
      (
        await request(app)
          .post(`${f.base}/deliveries/${delivery!.id}/retry`)
          .set('Cookie', await f.cookie())
          .send({ operationId: randomUUID() })
      ).status,
    ).toBe(409);
  });
  it('executes bounded repeats and shares graceful shutdown with automation', async () => {
    const f = await fixture();
    const policy = await policyFor(f, { repeatCount: 1, repeatDelayMinutes: 1 });
    await alertFor(f, policy.id);
    await processEscalation((await claimEscalation('a'))!);
    await EscalationModel.updateMany({}, { nextEscalationAt: new Date(0) });
    await processEscalation((await claimEscalation('b'))!);
    expect(await NotificationModel.countDocuments()).toBe(2);
    expect((await EscalationModel.findOne())!.status).toBe('completed');
    const worker = new AutomationWorker(1, 250);
    await worker.stop();
    await worker.tick();
    expect(worker.ready).toBe(false);
  });
  it('calculates workspace-only alert, acknowledgement, duplicate and page metrics', async () => {
    const f = await fixture();
    const policy = await policyFor(f);
    const alert = await alertFor(f, policy.id);
    await alertFor(f, policy.id);
    await processEscalation((await claimEscalation('worker'))!);
    await command(f, alert.id, 'acknowledge', {}, f.member);
    await command(f, alert.id, 'resolve');
    const metrics = await oncallMetrics(f.workspace.id);
    expect(metrics.duplicateOccurrenceRate).toBe(0.5);
    expect(metrics.acknowledgement.count).toBe(1);
    expect(metrics.escalationCount).toBe(1);
    expect(metrics.pageVolumePerResponder[0]!._id).toBe(f.member.id);
    expect((await oncallMetrics(f.other.id)).escalationCount).toBe(0);
  });
});
