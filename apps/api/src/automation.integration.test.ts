import { createHash, randomUUID } from 'node:crypto';

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
import { AlertModel, EscalationModel, PolicyModel } from './oncall/models.js';
import { ServiceDependencyModel, ServiceLevelObjectiveModel, ServiceModel, ServiceRelationshipModel, SliSampleModel, SloEvaluationModel, SyntheticMonitorModel, SyntheticMonitorRunModel } from './reliability/models.js';
import { calculateEvaluation, ingestSliBatch, processReliabilityWork, storeEvaluation } from './reliability/service.js';

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

describe('signed reliability ingestion integration', () => {
  const reliabilityFixture = async () => {
    const f = await fixture();
    const integration = await request(app)
      .post(`${f.base}/integrations`)
      .set('Cookie', await f.cookie())
      .send({ name: 'SLI input', type: 'genericWebhook', status: 'active', inboundEvents: ['sli.received'], outboundEvents: [] });
    expect(integration.status).toBe(201);
    const service = await ServiceModel.create({ workspaceId: f.workspace.id, name: 'API', slug: 'api', description: '', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const slo = await ServiceLevelObjectiveModel.create({ workspaceId: f.workspace.id, serviceId: service._id, objectiveKey: randomUUID(), name: 'Availability', description: '', enabled: true, indicatorType: 'availability', objectiveTarget: 99.9, rollingWindowDays: 30, dataSource: { type: 'webhook', sourceId: integration.body.integration.id }, missingDataPolicy: 'unknown', burnRateAlerts: [], version: 1, createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    return { f, integration, service, slo };
  };
  const signedRequest = (input: Awaited<ReturnType<typeof reliabilityFixture>>, body: string, deliveryId = randomUUID(), timestamp = String(Math.floor(Date.now() / 1000)), workspaceId = input.f.workspace.id, signature = signBody(input.integration.body.secret, timestamp, deliveryId, body)) => request(app).post(`/api/webhooks/reliability/${workspaceId}/${input.integration.body.integration.id}`).set('content-type', 'application/json').set('x-flowryn-timestamp', timestamp).set('x-flowryn-delivery-id', deliveryId).set('x-flowryn-signature', signature).send(body);

  it('authenticates raw bytes and rejects replay, invalid signatures, time skew, malformed data, and cross-workspace use', async () => {
    const x = await reliabilityFixture();
    const body = JSON.stringify({ schemaVersion: 1, eventType: 'sli.received', samples: [{ serviceId: x.service.id, sloId: x.slo.id, timestamp: new Date().toISOString(), good: 9, total: 10, idempotencyKey: 'signed:sample:1', metadata: { region: 'test' } }] });
    const deliveryId = randomUUID();
    expect((await signedRequest(x, body, deliveryId, undefined, undefined, '00'.repeat(32))).status).toBe(401);
    expect((await signedRequest(x, body, randomUUID(), String(Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
    expect((await signedRequest(x, body, randomUUID(), String(Math.floor(Date.now() / 1000) + 600))).status).toBe(401);
    expect((await signedRequest(x, body, randomUUID(), undefined, x.f.other.id)).status).toBe(401);
    expect((await signedRequest(x, '{bad')).status).toBe(401);
    expect((await signedRequest(x, body, deliveryId)).status).toBe(202);
    expect((await signedRequest(x, body, deliveryId)).status).toBe(401);
    expect(await SliSampleModel.countDocuments({ workspaceId: x.f.workspace.id })).toBe(1);
  });

  it('is concurrency-safe for sample idempotency and rejects late, future, oversized-batch, and high-cardinality samples', async () => {
    const x = await reliabilityFixture();
    const sample = { serviceId: x.service.id, sloId: x.slo.id, timestamp: new Date().toISOString(), good: 1, total: 1, idempotencyKey: 'concurrent:sample:1', metadata: {} };
    const body = JSON.stringify({ schemaVersion: 1, eventType: 'sli.received', samples: [sample] });
    const results = await Promise.all([signedRequest(x, body), signedRequest(x, body)]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 202]);
    expect(await SliSampleModel.countDocuments({ workspaceId: x.f.workspace.id, idempotencyKey: sample.idempotencyKey })).toBe(1);
    for (const timestamp of [new Date(Date.now() + 6 * 60_000), new Date(Date.now() - 8 * 86400_000)]) {
      const invalid = JSON.stringify({ schemaVersion: 1, eventType: 'sli.received', samples: [{ ...sample, timestamp: timestamp.toISOString(), idempotencyKey: `invalid:${timestamp.getTime()}` }] });
      expect((await signedRequest(x, invalid)).status).toBe(401);
    }
    const oversized = JSON.stringify({ schemaVersion: 1, eventType: 'sli.received', samples: Array.from({ length: 101 }, (_, index) => ({ ...sample, idempotencyKey: `batch:${index}` })) });
    expect((await signedRequest(x, oversized)).status).toBe(401);
    const cardinality = JSON.stringify({ schemaVersion: 1, eventType: 'sli.received', samples: [{ ...sample, idempotencyKey: 'metadata:large', metadata: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key${index}`, 'value'])) }] });
    expect((await signedRequest(x, cardinality)).status).toBe(401);
  });

  it('serializes SLO archival with ingestion in both orderings', async () => {
    const ingestionFirst = await reliabilityFixture();
    const body = JSON.stringify({ schemaVersion: 1, eventType: 'sli.received', samples: [{ serviceId: ingestionFirst.service.id, sloId: ingestionFirst.slo.id, timestamp: new Date().toISOString(), good: 1, total: 1, idempotencyKey: 'archive-order:ingest-first', metadata: {} }] });
    await signedRequest(ingestionFirst, body).expect(202);
    await request(app).delete(`/api/workspaces/${ingestionFirst.f.workspace.id}/reliability/slos/${ingestionFirst.slo.id}`).set('Cookie', await ingestionFirst.f.cookie()).expect(204);
    expect(await SliSampleModel.countDocuments({ sloId: ingestionFirst.slo._id })).toBe(1);
    expect(await storeEvaluation(ingestionFirst.f.workspace.id, ingestionFirst.slo, new Date())).toMatchObject({ sloVersion: 1 });
    expect(await SloEvaluationModel.countDocuments({ sloId: ingestionFirst.slo._id })).toBe(0);

    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    const archiveFirst = await reliabilityFixture();
    await request(app).delete(`/api/workspaces/${archiveFirst.f.workspace.id}/reliability/slos/${archiveFirst.slo.id}`).set('Cookie', await archiveFirst.f.cookie()).expect(204);
    const deniedBody = JSON.stringify({ schemaVersion: 1, eventType: 'sli.received', samples: [{ serviceId: archiveFirst.service.id, sloId: archiveFirst.slo.id, timestamp: new Date().toISOString(), good: 1, total: 1, idempotencyKey: 'archive-order:archive-first', metadata: {} }] });
    expect((await signedRequest(archiveFirst, deniedBody)).status).toBe(401);
    expect(await SliSampleModel.countDocuments({ sloId: archiveFirst.slo._id })).toBe(0);
    await storeEvaluation(archiveFirst.f.workspace.id, archiveFirst.slo, new Date());
    expect(await SloEvaluationModel.countDocuments({ sloId: archiveFirst.slo._id })).toBe(0);
  });

  it('write-fences an active SLO until concurrent ingestion commits', async () => {
    const x = await reliabilityFixture(); const now = new Date();
    let entered!: () => void; const atWrite = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const continueWrite = new Promise<void>((resolve) => { release = resolve; });
    const original = SliSampleModel.bulkWrite.bind(SliSampleModel);
    vi.spyOn(SliSampleModel, 'bulkWrite').mockImplementationOnce(async (operations, options) => { entered(); await continueWrite; return original(operations, options); });
    const ingestion = ingestSliBatch({ workspaceId: x.f.workspace.id, source: 'webhook', sourceId: x.integration.body.integration.id, now, batch: { samples: [{ serviceId: x.service.id, sloId: x.slo.id, timestamp: now.toISOString(), good: 1, total: 1, idempotencyKey: 'archive-race:fenced', metadata: {} }] } });
    await atWrite;
    const archival = request(app).delete(`/api/workspaces/${x.f.workspace.id}/reliability/slos/${x.slo.id}`).set('Cookie', await x.f.cookie());
    release(); await ingestion; await archival.expect(204);
    expect(await SliSampleModel.countDocuments({ sloId: x.slo._id, idempotencyKey: 'archive-race:fenced' })).toBe(1);
    expect((await ServiceLevelObjectiveModel.findById(x.slo._id))!.ingestionRevision).toBe(1);
  });
});

describe('durable reliability monitor execution', () => {
  const monitorFixture = async () => {
    const f = await fixture();
    const service = await ServiceModel.create({ workspaceId: f.workspace.id, name: 'API', slug: 'api', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const due = new Date('2026-09-29T12:00:00.000Z');
    const monitor = await SyntheticMonitorModel.create({ workspaceId: f.workspace.id, serviceId: service._id, name: 'Health', enabled: true, url: 'https://health.company.com/', method: 'GET', intervalSeconds: 60, timeoutMs: 1000, maxRedirects: 0, expectedStatusMin: 200, expectedStatusMax: 299, configVersion: 1, nextRunAt: due, createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    return { f, service, monitor, due };
  };

  it('allows only one worker to claim a scheduled check and stores one stable execution', async () => {
    const x = await monitorFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const network = async () => { entered += 1; await gate; return { statusCode: 200, latencyMs: 12, body: 'ok' }; };
    const first = processReliabilityWork(x.due, 'worker-a', network);
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await processReliabilityWork(x.due, 'worker-b', network)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await SyntheticMonitorRunModel.countDocuments({ monitorId: x.monitor._id })).toBe(1);
    expect((await SyntheticMonitorRunModel.findOne({ monitorId: x.monitor._id }))!.status).toBe('completed');
  });

  it('distinguishes endpoint failure from infrastructure retry and recovers expired work', async () => {
    const endpoint = await monitorFixture();
    await processReliabilityWork(endpoint.due, 'endpoint', async () => { throw new Error('ECONNRESET'); });
    expect(await SyntheticMonitorRunModel.findOne({ monitorId: endpoint.monitor._id })).toMatchObject({ status: 'completed', endpointHealthy: false, errorCode: 'ENDPOINT_UNREACHABLE' });
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    const infrastructure = await monitorFixture();
    await processReliabilityWork(infrastructure.due, 'infra', async () => { throw Object.assign(new Error('lookup'), { code: 'ENOTFOUND' }); });
    const retry = await SyntheticMonitorRunModel.findOne({ monitorId: infrastructure.monitor._id });
    expect(retry).toMatchObject({ status: 'retrying', errorCode: 'MONITOR_INFRASTRUCTURE_FAILURE', attemptCount: 1 });
    expect(retry!.nextAttemptAt!.getTime()).toBeGreaterThan(infrastructure.due.getTime());
    await SyntheticMonitorModel.updateOne({ _id: infrastructure.monitor._id }, { $set: { nextRunAt: retry!.nextAttemptAt, retryScheduledAt: retry!.scheduledAt, leaseExpiresAt: new Date(infrastructure.due.getTime() - 1) }, $unset: { leaseOwner: 1 } });
    await processReliabilityWork(retry!.nextAttemptAt!, 'recovery', async () => ({ statusCode: 200, latencyMs: 5, body: 'ok' }));
    expect(await SyntheticMonitorRunModel.countDocuments({ monitorId: infrastructure.monitor._id })).toBe(1);
    expect(await SyntheticMonitorRunModel.findById(retry!._id)).toMatchObject({ status: 'completed', attemptCount: 2, endpointHealthy: true });
  });

  it('preserves an expired execution when a manual test is requested', async () => {
    const x = await monitorFixture();
    const expiredAt = new Date(x.due.getTime() - 1);
    const key = createHash('sha256').update(`${x.monitor.id}:${x.due.toISOString()}`).digest('hex');
    const run = await SyntheticMonitorRunModel.create({ workspaceId: x.f.workspace.id, serviceId: x.service._id, monitorId: x.monitor._id, scheduledAt: x.due, idempotencyKey: key, status: 'running', attemptCount: 1, startedAt: expiredAt, leaseOwner: 'crashed-worker', leaseExpiresAt: expiredAt });
    await SyntheticMonitorModel.updateOne({ _id: x.monitor._id }, { $set: { leaseOwner: 'crashed-worker', leaseExpiresAt: expiredAt } });

    const response = await request(app).post(`/api/workspaces/${x.f.workspace.id}/reliability/monitors/${x.monitor.id}/test`).set('Cookie', await x.f.cookie()).send({});
    expect(response.status).toBe(409);
    expect((await SyntheticMonitorModel.findById(x.monitor._id))!.nextRunAt).toEqual(x.due);

    let calls = 0;
    expect(await processReliabilityWork(x.due, 'recovery-worker', async () => { calls += 1; return { statusCode: 200, latencyMs: 4, body: 'ok' }; })).toBe(true);
    expect(calls).toBe(1);
    expect(await SyntheticMonitorRunModel.countDocuments({ monitorId: x.monitor._id })).toBe(1);
    expect(await SyntheticMonitorRunModel.findById(run._id)).toMatchObject({ idempotencyKey: key, status: 'completed', endpointHealthy: true });
  });

  it('terminalizes recoverable executions when a monitor is archived', async () => {
    const x = await monitorFixture();
    const run = await SyntheticMonitorRunModel.create({ workspaceId: x.f.workspace.id, serviceId: x.service._id, monitorId: x.monitor._id, scheduledAt: x.due, idempotencyKey: 'archive:retrying', status: 'retrying', attemptCount: 2, nextAttemptAt: new Date(x.due.getTime() + 30_000), leaseOwner: 'retry-worker', leaseExpiresAt: new Date(x.due.getTime() + 10_000) });
    await SyntheticMonitorModel.updateOne({ _id: x.monitor._id }, { $set: { retryScheduledAt: x.due, leaseOwner: 'retry-worker', leaseExpiresAt: new Date(x.due.getTime() + 10_000) } });

    await request(app).delete(`/api/workspaces/${x.f.workspace.id}/reliability/monitors/${x.monitor.id}`).set('Cookie', await x.f.cookie()).expect(204);

    expect(await SyntheticMonitorRunModel.findById(run._id)).toMatchObject({ status: 'completed', errorCode: 'MONITOR_CONFIGURATION_CHANGED' });
    const archived = await SyntheticMonitorModel.findById(x.monitor._id);
    expect(archived).toMatchObject({ enabled: false });
    expect(archived!.archivedAt).toBeTruthy();
    expect(archived!.leaseOwner).toBeUndefined();
    expect(archived!.retryScheduledAt).toBeUndefined();
  });

  it('atomically invalidates recoverable executions when monitor configuration changes', async () => {
    const x = await monitorFixture();
    const run = await SyntheticMonitorRunModel.create({ workspaceId: x.f.workspace.id, serviceId: x.service._id, monitorId: x.monitor._id, scheduledAt: x.due, idempotencyKey: 'configuration:retrying', status: 'retrying', attemptCount: 2, nextAttemptAt: new Date(x.due.getTime() + 30_000), leaseOwner: 'retry-worker', leaseExpiresAt: new Date(x.due.getTime() + 10_000) });
    await SyntheticMonitorModel.updateOne({ _id: x.monitor._id }, { $set: { retryScheduledAt: x.due, leaseOwner: 'retry-worker', leaseExpiresAt: new Date(x.due.getTime() + 10_000) } });

    const response = await request(app).patch(`/api/workspaces/${x.f.workspace.id}/reliability/monitors/${x.monitor.id}`).set('Cookie', await x.f.cookie()).send({ enabled: false });
    expect(response.status).toBe(200);
    expect(await SyntheticMonitorRunModel.findById(run._id)).toMatchObject({ status: 'completed', errorCode: 'MONITOR_CONFIGURATION_CHANGED' });
    const monitor = await SyntheticMonitorModel.findById(x.monitor._id);
    expect(monitor).toMatchObject({ enabled: false });
    expect(monitor!.leaseOwner).toBeUndefined();
    expect(monitor!.retryScheduledAt).toBeUndefined();
  });

  it('terminalizes recoverable monitor executions when their service is archived', async () => {
    const x = await monitorFixture();
    const run = await SyntheticMonitorRunModel.create({ workspaceId: x.f.workspace.id, serviceId: x.service._id, monitorId: x.monitor._id, scheduledAt: x.due, idempotencyKey: 'service-archive:running', status: 'running', attemptCount: 1, leaseOwner: 'crashed-worker', leaseExpiresAt: new Date(x.due.getTime() - 1) });
    await SyntheticMonitorModel.updateOne({ _id: x.monitor._id }, { $set: { retryScheduledAt: x.due, leaseOwner: 'crashed-worker', leaseExpiresAt: new Date(x.due.getTime() - 1) } });

    await request(app).delete(`/api/workspaces/${x.f.workspace.id}/reliability/services/${x.service.id}`).set('Cookie', await x.f.cookie()).expect(204);

    expect(await SyntheticMonitorRunModel.findById(run._id)).toMatchObject({ status: 'completed', errorCode: 'SERVICE_ARCHIVED' });
    const monitor = await SyntheticMonitorModel.findById(x.monitor._id);
    expect(monitor).toMatchObject({ enabled: false });
    expect(monitor!.archivedAt).toBeTruthy();
    expect(monitor!.leaseOwner).toBeUndefined();
    expect(monitor!.retryScheduledAt).toBeUndefined();
  });

  it('does not execute disabled, archived, or service-archived monitors', async () => {
    for (const state of ['disabled', 'archived', 'service-archived'] as const) {
      const x = await monitorFixture();
      if (state === 'disabled') await SyntheticMonitorModel.updateOne({ _id: x.monitor._id }, { $set: { enabled: false } });
      if (state === 'archived') await SyntheticMonitorModel.updateOne({ _id: x.monitor._id }, { $set: { archivedAt: x.due } });
      if (state === 'service-archived') await ServiceModel.updateOne({ _id: x.service._id }, { $set: { archivedAt: x.due } });
      let calls = 0;
      const result = await processReliabilityWork(x.due, state, async () => { calls += 1; return { statusCode: 200, latencyMs: 1, body: '' }; });
      expect(calls).toBe(0);
      expect(state === 'service-archived' ? result : !result).toBe(true);
      await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    }
  });

  it('uses bounded deterministic retry delays, preserves identity, and dead-letters after exhaustion', async () => {
    const x = await monitorFixture();
    let at = x.due;
    let runId: string | undefined; let key: string | undefined; let previousDelay = 0;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await processReliabilityWork(at, `retry-${attempt}`, async () => { throw Object.assign(new Error('lookup'), { code: 'ENOTFOUND' }); });
      const run = await SyntheticMonitorRunModel.findOne({ monitorId: x.monitor._id });
      runId ??= run!.id; key ??= run!.idempotencyKey!;
      expect(run!.id).toBe(runId); expect(run!.idempotencyKey).toBe(key); expect(run!.attemptCount).toBe(attempt);
      if (attempt < 5) { const delay = run!.nextAttemptAt!.getTime() - at.getTime(); expect(delay).toBeGreaterThanOrEqual(30_000 * 2 ** (attempt - 1)); expect(delay).toBeLessThan(30_000 * 2 ** (attempt - 1) + 5_000); expect(delay).toBeGreaterThan(previousDelay); previousDelay = delay; at = run!.nextAttemptAt!; }
      else expect(run!.status).toBe('deadLetter');
    }
    expect(await SyntheticMonitorRunModel.countDocuments({ monitorId: x.monitor._id })).toBe(1);
  });

  it('authorizes one administrative dead-letter retry and rejects concurrent or member retries', async () => {
    const x = await monitorFixture();
    const run = await SyntheticMonitorRunModel.create({ workspaceId: x.f.workspace.id, serviceId: x.service._id, monitorId: x.monitor._id, scheduledAt: x.due, idempotencyKey: 'dead-letter:stable', status: 'deadLetter', attemptCount: 5, completedAt: x.due, errorCode: 'MONITOR_INFRASTRUCTURE_FAILURE' });
    const url = `/api/workspaces/${x.f.workspace.id}/reliability/monitors/${x.monitor.id}/runs/${run.id}/retry`;
    expect((await request(app).post(url).set('Cookie', await x.f.cookie(x.f.member)).send({})).status).toBe(403);
    const cookie = await x.f.cookie(x.f.owner);
    const results = await Promise.all([request(app).post(url).set('Cookie', cookie).send({}), request(app).post(url).set('Cookie', cookie).send({})]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    expect(await SyntheticMonitorRunModel.countDocuments({ _id: run._id, status: 'retrying' })).toBe(1);
  });

  it('fences administrative retries when disable or archive wins and rechecks before execution', async () => {
    for (const transition of ['disable', 'archive'] as const) {
      const x = await monitorFixture();
      const run = await SyntheticMonitorRunModel.create({ workspaceId: x.f.workspace.id, serviceId: x.service._id, monitorId: x.monitor._id, scheduledAt: x.due, idempotencyKey: `admin-race:${transition}`, status: 'deadLetter', attemptCount: 5, completedAt: x.due, errorCode: 'MONITOR_INFRASTRUCTURE_FAILURE' });
      const base = `/api/workspaces/${x.f.workspace.id}/reliability/monitors/${x.monitor.id}`; const cookie = await x.f.cookie();
      if (transition === 'disable') await request(app).patch(base).set('Cookie', cookie).send({ enabled: false }).expect(200);
      else await request(app).delete(base).set('Cookie', cookie).expect(204);
      expect((await request(app).post(`${base}/runs/${run.id}/retry`).set('Cookie', cookie).send({})).status).toBe(409);
      let calls = 0; expect(await processReliabilityWork(x.due, `transition-first:${transition}`, async () => { calls += 1; return { statusCode: 200, latencyMs: 1, body: '' }; })).toBe(false); expect(calls).toBe(0);
      await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    }

    const retryFirst = await monitorFixture();
    const run = await SyntheticMonitorRunModel.create({ workspaceId: retryFirst.f.workspace.id, serviceId: retryFirst.service._id, monitorId: retryFirst.monitor._id, scheduledAt: retryFirst.due, idempotencyKey: 'admin-race:retry-first', status: 'deadLetter', attemptCount: 5, completedAt: retryFirst.due, errorCode: 'MONITOR_INFRASTRUCTURE_FAILURE' });
    const base = `/api/workspaces/${retryFirst.f.workspace.id}/reliability/monitors/${retryFirst.monitor.id}`; const cookie = await retryFirst.f.cookie();
    await request(app).post(`${base}/runs/${run.id}/retry`).set('Cookie', cookie).send({}).expect(202);
    await request(app).patch(base).set('Cookie', cookie).send({ enabled: false }).expect(200);
    let calls = 0; expect(await processReliabilityWork(new Date(), 'retry-first', async () => { calls += 1; return { statusCode: 200, latencyMs: 1, body: '' }; })).toBe(false); expect(calls).toBe(0);
    expect(await SyntheticMonitorRunModel.countDocuments({ monitorId: retryFirst.monitor._id })).toBe(1);
    expect(await OutboxEventModel.countDocuments({ 'payload.monitorId': retryFirst.monitor.id })).toBe(0);
  });

  it('keeps one stable execution when dead-letter retry races a worker claim and a lease expires', async () => {
    const x = await monitorFixture();
    const stableKey = createHash('sha256').update(`${x.monitor.id}:${x.due.toISOString()}`).digest('hex');
    const run = await SyntheticMonitorRunModel.create({ workspaceId: x.f.workspace.id, serviceId: x.service._id, monitorId: x.monitor._id, scheduledAt: x.due, idempotencyKey: stableKey, status: 'deadLetter', attemptCount: 5, completedAt: x.due, errorCode: 'MONITOR_INFRASTRUCTURE_FAILURE', leaseExpiresAt: new Date(x.due.getTime() - 1) });
    let calls = 0; const network = async () => { calls += 1; return { statusCode: 200, latencyMs: 5, body: 'ok' }; };
    const retry = request(app).post(`/api/workspaces/${x.f.workspace.id}/reliability/monitors/${x.monitor.id}/runs/${run.id}/retry`).set('Cookie', await x.f.cookie()).send({});
    const [, response] = await Promise.all([processReliabilityWork(x.due, 'racing-worker', network), retry]);
    expect([202, 409]).toContain(response.status);
    const retried = await SyntheticMonitorRunModel.findById(run._id); expect(retried!.idempotencyKey).toBe(stableKey);
    if (retried!.status === 'retrying') await processReliabilityWork(retried!.nextAttemptAt!, 'retry-worker', network);
    expect(calls).toBeLessThanOrEqual(1); expect(await SyntheticMonitorRunModel.countDocuments({ monitorId: x.monitor._id })).toBe(1);
    expect(await OutboxEventModel.countDocuments({ 'payload.monitorId': x.monitor.id })).toBeLessThanOrEqual(1);
    expect(await AlertModel.countDocuments({ serviceId: x.service.id })).toBe(0);
  });
  it('rechecks archival after a claimed check and never starts work when archival wins', async () => {
    const claimed = await monitorFixture(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let signalEntered!: () => void; const enteredNetwork = new Promise<void>((resolve) => { signalEntered = resolve; });
    const running = processReliabilityWork(claimed.due, 'archive-race', async () => { signalEntered(); await gate; return { statusCode: 200, latencyMs: 1, body: 'ok' }; });
    const reachedNetwork = await Promise.race([enteredNetwork.then(() => true), running.then(() => false)]); expect(reachedNetwork).toBe(true);
    await SyntheticMonitorModel.updateOne({ _id: claimed.monitor._id }, { $set: { enabled: false, archivedAt: claimed.due }, $inc: { configVersion: 1 }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); release(); await running;
    expect(await SyntheticMonitorRunModel.findOne({ monitorId: claimed.monitor._id })).toMatchObject({ status: 'completed', errorCode: 'MONITOR_CONFIGURATION_CHANGED' });
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    const archived = await monitorFixture(); await SyntheticMonitorModel.updateOne({ _id: archived.monitor._id }, { $set: { enabled: false, archivedAt: archived.due } }); let calls = 0;
    expect(await processReliabilityWork(archived.due, 'archive-first', async () => { calls += 1; return { statusCode: 200, latencyMs: 1, body: '' }; })).toBe(false); expect(calls).toBe(0);
  });

  it('write-fences a synthetic SLO while its monitor observation commits', async () => {
    const x = await monitorFixture();
    const slo = await ServiceLevelObjectiveModel.create({ workspaceId: x.f.workspace.id, serviceId: x.service._id, objectiveKey: randomUUID(), name: 'Synthetic availability', enabled: true, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'synthetic', sourceId: x.monitor.id }, missingDataPolicy: 'unknown', burnRateAlerts: [], version: 1, createdBy: x.f.owner.id, updatedBy: x.f.owner.id, archivedAt: null });
    await SyntheticMonitorModel.updateOne({ _id: x.monitor._id }, { $set: { sloId: slo._id } });
    let entered!: () => void; const atSample = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const continueSample = new Promise<void>((resolve) => { release = resolve; });
    const original = SliSampleModel.updateOne.bind(SliSampleModel);
    vi.spyOn(SliSampleModel, 'updateOne').mockImplementationOnce((...args) => { entered(); const query = original(...args); const execute = query.exec.bind(query); query.exec = async () => { await continueSample; return execute(); }; return query; });
    const worker = processReliabilityWork(x.due, 'synthetic-slo-race', async () => ({ statusCode: 200, latencyMs: 1, body: 'ok' }));
    await atSample;
    const archival = request(app).delete(`/api/workspaces/${x.f.workspace.id}/reliability/slos/${slo.id}`).set('Cookie', await x.f.cookie());
    release(); expect(await worker).toBe(true); await archival.expect(204);
    expect(await SliSampleModel.countDocuments({ sloId: slo._id })).toBe(1);
    expect((await ServiceLevelObjectiveModel.findById(slo._id))!.ingestionRevision).toBe(1);
  });
});

describe('reliability authorization and archival boundaries', () => {
  const serviceBody = (ownerId: string, slug = 'api') => ({ name: 'API', slug, description: '', lifecycle: 'active', criticality: 'tier1', ownerIds: [ownerId], projectIds: [], labels: {}, links: [] });
  it('enforces owner/admin/member/suspended boundaries and denies cross-workspace histories and relationships', async () => {
    const f = await fixture(); const base = `/api/workspaces/${f.workspace.id}/reliability`;
    expect((await request(app).post(`${base}/services`).set('Cookie', await f.cookie(f.member)).send(serviceBody(f.owner.id))).status).toBe(403);
    const created = await request(app).post(`${base}/services`).set('Cookie', await f.cookie(f.admin)).send(serviceBody(f.owner.id)).expect(201); const serviceId = created.body.service._id as string;
    const slo = await request(app).post(`${base}/slos`).set('Cookie', await f.cookie()).send({ serviceId, name: 'Availability', description: '', enabled: true, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [] }).expect(201);
    expect((await request(app).get(`${base}/services`).set('Cookie', await f.cookie(f.member))).status).toBe(200);
    const suspendedCookie = await f.cookie(f.owner); await UserModel.updateOne({ _id: f.owner._id }, { $set: { status: 'suspended' } });
    expect((await request(app).patch(`${base}/services/${serviceId}`).set('Cookie', suspendedCookie).send({ name: 'Denied' })).status).toBe(401); await UserModel.updateOne({ _id: f.owner._id }, { $set: { status: 'active' } });
    expect((await request(app).get(`/api/workspaces/${f.other.id}/reliability/slos/${slo.body.slo._id}/history`).set('Cookie', await f.cookie(f.outsider))).status).toBe(404);
    expect((await request(app).get(`/api/workspaces/${f.other.id}/reliability/services/${serviceId}/relationships`).set('Cookie', await f.cookie(f.outsider))).status).toBe(404);
    await request(app).delete(`${base}/slos/${slo.body.slo._id}`).set('Cookie', await f.cookie()).expect(204);
    expect((await request(app).patch(`${base}/slos/${slo.body.slo._id}`).set('Cookie', await f.cookie()).send({ name: 'Denied' })).status).toBe(404);
    await request(app).delete(`${base}/services/${serviceId}`).set('Cookie', await f.cookie()).expect(204);
    expect((await request(app).patch(`${base}/services/${serviceId}`).set('Cookie', await f.cookie()).send({ name: 'Denied' })).status).toBe(404);
  });
  it('rejects indirect dependency cycles and graph depth beyond the documented bound', async () => {
    const f = await fixture(); const base = `/api/workspaces/${f.workspace.id}/reliability`; const cookie = await f.cookie();
    const services = await ServiceModel.create(Array.from({ length: 12 }, (_, index) => ({ workspaceId: f.workspace.id, name: `Service ${index}`, slug: `service-${index}`, lifecycle: 'active', criticality: 'tier2', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null })));
    const edge = (upstreamServiceId: string, downstreamServiceId: string) => ({ upstreamServiceId, downstreamServiceId, type: 'runtime', criticality: 'required', description: '', enabled: true });
    await request(app).post(`${base}/dependencies`).set('Cookie', cookie).send(edge(services[0]!.id, services[1]!.id)).expect(201);
    await request(app).post(`${base}/dependencies`).set('Cookie', cookie).send(edge(services[1]!.id, services[2]!.id)).expect(201);
    await request(app).post(`${base}/dependencies`).set('Cookie', cookie).send(edge(services[2]!.id, services[0]!.id)).expect(409);
    for (let index = 2; index < 10; index++) await request(app).post(`${base}/dependencies`).set('Cookie', cookie).send(edge(services[index]!.id, services[index + 1]!.id)).expect(201);
    await request(app).post(`${base}/dependencies`).set('Cookie', cookie).send(edge(services[10]!.id, services[11]!.id)).expect(409);
    const impact = await request(app).get(`${base}/services/${services[0]!.id}/impact`).query({ direction: 'downstream' }).set('Cookie', cookie).expect(200);
    expect(impact.body.edges).toHaveLength(10); expect(new Set(impact.body.serviceIds).size).toBeLessThanOrEqual(500);
  });
  it('serializes service archival against dependent SLO, monitor, dependency, and relationship writes', async () => {
    const f = await fixture(); const base = `/api/workspaces/${f.workspace.id}/reliability`; const cookie = await f.cookie();
    const [service, peer] = await ServiceModel.create([{ workspaceId: f.workspace.id, name: 'Race', slug: 'race', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null }, { workspaceId: f.workspace.id, name: 'Peer', slug: 'peer', lifecycle: 'active', criticality: 'tier2', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null }]);
    const existingMonitor = await SyntheticMonitorModel.create({ workspaceId: f.workspace.id, serviceId: peer!._id, name: 'Moving monitor', enabled: false, url: 'https://moving.company.com', method: 'GET', intervalSeconds: 60, timeoutMs: 1000, maxRedirects: 0, expectedStatusMin: 200, expectedStatusMax: 299, configVersion: 1, nextRunAt: new Date(), createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    let releaseStart!: () => void;
    const start = new Promise<void>((resolve) => { releaseStart = resolve; });
    const launch = <T>(work: () => Promise<T>) => start.then(work);
    const operations = [
      launch(() => request(app).post(`${base}/slos`).set('Cookie', cookie).send({ serviceId: service!.id, name: 'Race SLO', description: '', enabled: true, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [] })),
      launch(() => request(app).post(`${base}/monitors`).set('Cookie', cookie).send({ serviceId: service!.id, name: 'Race monitor', enabled: false, url: 'https://race.company.com', method: 'GET', intervalSeconds: 60, timeoutMs: 1000, maxRedirects: 0, expectedStatusMin: 200, expectedStatusMax: 299 })),
      launch(() => request(app).post(`${base}/dependencies`).set('Cookie', cookie).send({ upstreamServiceId: service!.id, downstreamServiceId: peer!.id, type: 'runtime', criticality: 'required', description: '', enabled: true })),
      launch(() => request(app).post(`${base}/relationships`).set('Cookie', cookie).send({ serviceId: service!.id, targetType: 'project', targetId: f.project.id })),
      launch(() => request(app).patch(`${base}/monitors/${existingMonitor.id}`).set('Cookie', cookie).send({ serviceId: service!.id })),
      launch(() => request(app).delete(`${base}/services/${service!.id}`).set('Cookie', cookie)),
    ]; releaseStart(); const results = await Promise.all(operations); expect(results.at(-1)!.status).toBe(204); expect(results.slice(0, 5).every((result: { status: number }) => [200, 201, 400, 404, 409].includes(result.status))).toBe(true);
    expect(await ServiceLevelObjectiveModel.countDocuments({ serviceId: service!._id, archivedAt: null })).toBe(0); expect(await SyntheticMonitorModel.countDocuments({ serviceId: service!._id, archivedAt: null })).toBe(0); expect(await ServiceRelationshipModel.countDocuments({ serviceId: service!._id, archivedAt: null })).toBe(0);
    expect(await mongoose.model('ServiceDependency').countDocuments({ $or: [{ upstreamServiceId: service!._id }, { downstreamServiceId: service!._id }], archivedAt: null })).toBe(0);
    expect(await SyntheticMonitorModel.countDocuments({ serviceId: service!._id, archivedAt: null })).toBe(0);
    expect((await request(app).post(`${base}/slos`).set('Cookie', cookie).send({ serviceId: service!.id, name: 'Denied SLO', description: '', enabled: true, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [] })).status).not.toBe(201);
    expect((await request(app).post(`${base}/monitors`).set('Cookie', cookie).send({ serviceId: service!.id, name: 'Denied monitor', enabled: false, url: 'https://denied.company.com', method: 'GET', intervalSeconds: 60, timeoutMs: 1000, maxRedirects: 0, expectedStatusMin: 200, expectedStatusMax: 299 })).status).not.toBe(201);
    expect((await request(app).post(`${base}/relationships`).set('Cookie', cookie).send({ serviceId: service!.id, targetType: 'project', targetId: f.project.id })).status).not.toBe(201);
    expect((await request(app).post(`${base}/dependencies`).set('Cookie', cookie).send({ upstreamServiceId: service!.id, downstreamServiceId: peer!.id, type: 'runtime', criticality: 'required', description: '', enabled: true })).status).not.toBe(201);
  });
});

describe('dependency graph bounds', () => {
  it('rejects an edge that would push an affected ancestor beyond 500 reachable services', async () => {
    const f = await fixture();
    const services = await ServiceModel.insertMany(Array.from({ length: 501 }, (_, index) => ({ workspaceId: f.workspace.id, name: `Bounded ${index}`, slug: `bounded-${index}`, lifecycle: 'active', criticality: 'tier3', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null })));
    const root = services[0]!; const leaves = services.slice(1, 500); const extra = services[500]!;
    await ServiceDependencyModel.insertMany(leaves.map((leaf) => ({ workspaceId: f.workspace.id, upstreamServiceId: root._id, downstreamServiceId: leaf._id, type: 'runtime', criticality: 'required', description: '', enabled: true, createdBy: f.owner.id, archivedAt: null })));

    const response = await request(app).post(`/api/workspaces/${f.workspace.id}/reliability/dependencies`).set('Cookie', await f.cookie()).send({ upstreamServiceId: leaves[0]!.id, downstreamServiceId: extra.id, type: 'runtime', criticality: 'required', description: '', enabled: true });

    expect(response.status).toBe(409);
    expect(await ServiceDependencyModel.countDocuments({ workspaceId: f.workspace.id, archivedAt: null })).toBe(499);
  });
});

describe('SLO evaluation and alert concurrency', () => {
  it('reports insufficient data distinctly and calculates deterministic compliance and burn windows', async () => {
    const f = await fixture();
    const service = await ServiceModel.create({ workspaceId: f.workspace.id, name: 'API', slug: 'api', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const slo = await ServiceLevelObjectiveModel.create({ workspaceId: f.workspace.id, serviceId: service._id, objectiveKey: randomUUID(), name: 'Availability', enabled: true, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [{ shortWindowMinutes: 5, longWindowMinutes: 60, threshold: 2 }], version: 1, createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(await calculateEvaluation(f.workspace.id, slo, now)).toMatchObject({ state: 'unknown', total: 0, compliance: null, remainingBudget: null });
    await SliSampleModel.create({ workspaceId: f.workspace.id, serviceId: service._id, sloId: slo._id, sloVersion: 1, timestamp: new Date(now.getTime() - 60_000), bucketAt: new Date(now.getTime() - 300_000), good: 90, total: 100, source: 'api', idempotencyKey: 'evaluation:1', metadata: {}, expiresAt: new Date(now.getTime() + 86400_000) });
    const result = await calculateEvaluation(f.workspace.id, slo, now);
    expect(result).toMatchObject({ state: 'breaching', good: 90, total: 100, compliance: 0.9, remainingBudget: 0, breaching: true });
    expect(result.consumption).toBeCloseTo(10); expect(result.shortBurnRate).toBeCloseTo(10); expect(result.longBurnRate).toBeCloseTo(10);
    expect(result.windowEnd).toEqual(now);
    await SliSampleModel.deleteMany({ sloId: slo._id });
    slo.burnRateAlerts = [{ shortWindowMinutes: 5, longWindowMinutes: 60, threshold: 2, recoveryThreshold: 0 }];
    await SliSampleModel.create({ workspaceId: f.workspace.id, serviceId: service._id, sloId: slo._id, sloVersion: 1, timestamp: new Date(now.getTime() - 60_000), bucketAt: new Date(now.getTime() - 300_000), good: 100, total: 100, source: 'api', idempotencyKey: 'evaluation:zero-recovery', metadata: {}, expiresAt: new Date(now.getTime() + 86400_000) });
    expect((await calculateEvaluation(f.workspace.id, slo, now)).burnWindows[0]).toMatchObject({ recoveryThreshold: 0, shortBurnRate: 0, longBurnRate: 0, recovered: true });
  });

  it('deduplicates concurrent evaluation snapshots, alerts, and transition outbox events', async () => {
    const f = await fixture();
    const policy = await PolicyModel.create({ workspaceId: f.workspace.id, name: 'SLO paging', description: '', enabled: true, steps: [{ id: randomUUID(), delayMinutes: 0, target: { type: 'users', userIds: [f.member.id] }, webhookIntegrationIds: [] }], repeatCount: 0, repeatDelayMinutes: 5, version: 1, createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const service = await ServiceModel.create({ workspaceId: f.workspace.id, name: 'API', slug: 'api', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const slo = await ServiceLevelObjectiveModel.create({ workspaceId: f.workspace.id, serviceId: service._id, objectiveKey: randomUUID(), name: 'Availability', enabled: true, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [{ shortWindowMinutes: 5, longWindowMinutes: 60, threshold: 2, escalationPolicyId: policy._id }], version: 1, createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const now = new Date('2026-09-29T12:00:00.000Z');
    await SliSampleModel.create({ workspaceId: f.workspace.id, serviceId: service._id, sloId: slo._id, sloVersion: 1, timestamp: new Date(now.getTime() - 60_000), bucketAt: new Date(now.getTime() - 300_000), good: 0, total: 100, source: 'api', idempotencyKey: 'breach:1', metadata: {}, expiresAt: new Date(now.getTime() + 86400_000) });
    await Promise.allSettled([storeEvaluation(f.workspace.id, slo, now), storeEvaluation(f.workspace.id, slo, now)]);
    expect(await AlertModel.countDocuments({ workspaceId: f.workspace.id, fingerprint: `slo:${slo.objectiveKey}` })).toBe(1);
    expect(await OutboxEventModel.countDocuments({ workspaceId: f.workspace.id, eventType: 'slo.breached' })).toBe(1);
    expect(await OutboxEventModel.countDocuments({ workspaceId: f.workspace.id, eventType: 'slo.errorBudgetThresholdReached' })).toBe(1);
    expect(await EscalationModel.countDocuments({ workspaceId: f.workspace.id })).toBe(1);
  });

  it('recovers only the matching alert once and does not recover from missing data', async () => {
    const f = await fixture(); const now = new Date('2026-09-29T12:00:00.000Z');
    const service = await ServiceModel.create({ workspaceId: f.workspace.id, name: 'API', slug: 'api', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const slo = await ServiceLevelObjectiveModel.create({ workspaceId: f.workspace.id, serviceId: service._id, objectiveKey: randomUUID(), name: 'Availability', enabled: true, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [], version: 3, createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const previousWindow = new Date(now.getTime() - 60_000);
    await SloEvaluationModel.create({ workspaceId: f.workspace.id, serviceId: service._id, sloId: slo._id, objectiveKey: slo.objectiveKey, sloVersion: 3, windowStart: new Date(previousWindow.getTime() - 7 * 86400_000), windowEnd: previousWindow, shortWindowStart: new Date(previousWindow.getTime() - 300_000), longWindowStart: new Date(previousWindow.getTime() - 3600_000), burnWindows: [], state: 'breaching', good: 0, total: 100, compliance: 0, remainingBudget: 0, consumption: 100, shortBurnRate: 100, longBurnRate: 100, breaching: true, breachedAt: previousWindow });
    const matching = await AlertModel.create({ workspaceId: f.workspace.id, fingerprint: `slo:${slo.objectiveKey}`, title: 'Matching', severity: 'sev2', status: 'open', occurrenceCount: 1, firstReceivedAt: previousWindow, lastReceivedAt: previousWindow, serviceId: service.id, correlationId: randomUUID(), createdBy: f.owner.id });
    const unrelated = await AlertModel.create({ workspaceId: f.workspace.id, fingerprint: 'slo:unrelated', title: 'Unrelated', severity: 'sev2', status: 'open', occurrenceCount: 1, firstReceivedAt: previousWindow, lastReceivedAt: previousWindow, serviceId: service.id, correlationId: randomUUID(), createdBy: f.owner.id });
    await Promise.allSettled([storeEvaluation(f.workspace.id, slo, now), storeEvaluation(f.workspace.id, slo, now)]);
    expect((await AlertModel.findById(matching._id))!.status).toBe('open'); expect(await OutboxEventModel.countDocuments({ eventType: 'slo.recovered' })).toBe(0);
    await SliSampleModel.create({ workspaceId: f.workspace.id, serviceId: service._id, sloId: slo._id, sloVersion: 3, timestamp: now, bucketAt: new Date(Math.floor(now.getTime() / 300000) * 300000), good: 100, total: 100, source: 'api', idempotencyKey: 'recovery:healthy', metadata: {}, expiresAt: new Date(now.getTime() + 86400_000) });
    const recoveryAt = new Date(now.getTime() + 60_000); await Promise.allSettled([storeEvaluation(f.workspace.id, slo, recoveryAt), storeEvaluation(f.workspace.id, slo, recoveryAt)]);
    expect((await AlertModel.findById(matching._id))!.status).toBe('resolved'); expect((await AlertModel.findById(unrelated._id))!.status).toBe('open');
    expect(await OutboxEventModel.countDocuments({ eventType: 'slo.recovered' })).toBe(1); const stored = await SloEvaluationModel.findOne({ sloId: slo._id, windowEnd: recoveryAt }); expect(stored).toMatchObject({ sloVersion: 3, windowEnd: recoveryAt, recoveredAt: recoveryAt });
    expect((await SloEvaluationModel.findOne({ sloId: slo._id, windowEnd: previousWindow }))!.state).toBe('breaching');
    await SliSampleModel.create({ workspaceId: f.workspace.id, serviceId: service._id, sloId: slo._id, sloVersion: 3, timestamp: new Date(now.getTime() - 30_000), bucketAt: new Date(Math.floor(now.getTime() / 300000) * 300000), good: 0, total: 1000, source: 'api', idempotencyKey: 'recovery:late-bad', metadata: {}, expiresAt: new Date(now.getTime() + 86400_000) });
    const staleAt = new Date(now.getTime() + 30_000); await storeEvaluation(f.workspace.id, slo, staleAt);
    expect(await SloEvaluationModel.findOne({ sloId: slo._id, windowEnd: staleAt })).toBeNull(); expect((await AlertModel.findById(matching._id))!.status).toBe('resolved'); expect(await OutboxEventModel.countDocuments({ eventType: 'slo.breached' })).toBe(0);
    expect(await OutboxEventModel.countDocuments({ eventType: 'slo.recovered' })).toBe(1);
    expect(await EscalationModel.countDocuments({ alertId: matching._id })).toBeLessThanOrEqual(1);
    expect(await AlertModel.countDocuments({ workspaceId: f.workspace.id, fingerprint: `slo:${slo.objectiveKey}` })).toBe(1);
  });

  it('aggregates bounded workspace metrics and preserves empty and tenant-isolated states', async () => {
    const f = await fixture(); const now = new Date();
    const [owned, ownerless] = await ServiceModel.create([
      { workspaceId: f.workspace.id, name: 'API', slug: 'api', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null },
      { workspaceId: f.workspace.id, name: 'Legacy', slug: 'legacy', lifecycle: 'deprecated', criticality: 'tier3', ownerIds: [f.outsider.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null },
    ]);
    const slo = await ServiceLevelObjectiveModel.create({ workspaceId: f.workspace.id, serviceId: owned!._id, objectiveKey: randomUUID(), name: 'Availability', enabled: true, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [], version: 1, nextEvaluationAt: new Date(now.getTime() + 60_000), createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    await SliSampleModel.create({ workspaceId: f.workspace.id, serviceId: owned!._id, sloId: slo._id, sloVersion: 1, timestamp: new Date(now.getTime() - 1000), bucketAt: new Date(Math.floor(now.getTime() / 300000) * 300000), good: 99, total: 100, source: 'api', idempotencyKey: 'metrics:sample', metadata: {}, expiresAt: new Date(now.getTime() + 86400_000) });
    const monitor = await SyntheticMonitorModel.create({ workspaceId: f.workspace.id, serviceId: owned!._id, name: 'Health', enabled: true, url: 'https://health.company.com', method: 'GET', intervalSeconds: 60, timeoutMs: 1000, maxRedirects: 0, expectedStatusMin: 200, expectedStatusMax: 299, health: 'healthy', nextRunAt: new Date(now.getTime() + 60_000), createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    await SyntheticMonitorRunModel.create([{ workspaceId: f.workspace.id, serviceId: owned!._id, monitorId: monitor._id, scheduledAt: new Date(now.getTime() - 2000), idempotencyKey: 'metrics:run:1', status: 'completed', endpointHealthy: false, latencyMs: 100, attemptCount: 1, completedAt: new Date(now.getTime() - 2000) }, { workspaceId: f.workspace.id, serviceId: owned!._id, monitorId: monitor._id, scheduledAt: new Date(now.getTime() - 1000), idempotencyKey: 'metrics:run:2', status: 'completed', endpointHealthy: true, latencyMs: 300, attemptCount: 1, completedAt: new Date(now.getTime() - 1000) }]);
    const cookie = await f.cookie(); const base = `/api/workspaces/${f.workspace.id}/reliability/metrics`;
    const result = await request(app).get(base).set('Cookie', cookie).expect(200);
    expect(result.body.servicesByLifecycle).toEqual(expect.arrayContaining([{ _id: 'active', count: 1 }, { _id: 'deprecated', count: 1 }]));
    expect(result.body.servicesByCriticality).toEqual(expect.arrayContaining([{ _id: 'tier1', count: 1 }, { _id: 'tier3', count: 1 }]));
    expect(result.body.servicesWithoutOwners).toBe(1); expect(result.body.monitor).toMatchObject({ executions: 2, successRate: 0.5, failureDurationMs: 1000, insufficientData: false });
    expect(result.body.monitor.latencyMs).toEqual({ p50: 100, p95: 300, p99: 300 }); expect(result.body.complianceByService).toHaveLength(1); expect(result.body.highestRiskServices[0].serviceId).toBe(owned!.id);
    expect((await request(app).get(base).query({ from: new Date(now.getTime() - 91 * 86400_000).toISOString(), to: now.toISOString() }).set('Cookie', cookie)).status).toBe(400);
    const other = await request(app).get(`/api/workspaces/${f.other.id}/reliability/metrics`).set('Cookie', await f.cookie(f.outsider)).expect(200);
    expect(other.body.servicesByLifecycle).toEqual([]); expect(other.body.monitor).toMatchObject({ executions: 0, successRate: null, insufficientData: true });
    expect(await SloEvaluationModel.countDocuments({ workspaceId: f.other.id })).toBe(0); expect(ownerless).toBeTruthy();
  });

  it('groups overlapping incident and alert history by service and excludes open incidents from resolution means', async () => {
    const f = await fixture(); const now = new Date(); const from = new Date(now.getTime() - 3600_000);
    const [api, database] = await ServiceModel.create([
      { workspaceId: f.workspace.id, name: 'API', slug: 'api', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null },
      { workspaceId: f.workspace.id, name: 'Database', slug: 'database', lifecycle: 'retired', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: now },
    ]);
    const [resolved, open, overlap, foreign] = await IncidentModel.create([
      { workspaceId: f.workspace.id, incidentNumber: 'INC-100001', title: 'Resolved', severity: 'sev2', declaredBy: f.owner.id, declaredAt: new Date(now.getTime() - 1800_000), createdAt: new Date(now.getTime() - 1800_000), resolvedAt: new Date(now.getTime() - 1200_000) },
      { workspaceId: f.workspace.id, incidentNumber: 'INC-100002', title: 'Open', severity: 'sev3', declaredBy: f.owner.id, declaredAt: new Date(now.getTime() - 900_000), createdAt: new Date(now.getTime() - 900_000) },
      { workspaceId: f.workspace.id, incidentNumber: 'INC-100003', title: 'Overlap', severity: 'sev2', declaredBy: f.owner.id, declaredAt: new Date(now.getTime() - 600_000), createdAt: new Date(now.getTime() - 600_000), resolvedAt: new Date(now.getTime() - 300_000) },
      { workspaceId: f.other.id, incidentNumber: 'INC-200001', title: 'Foreign', severity: 'sev1', declaredBy: f.outsider.id, declaredAt: new Date(now.getTime() - 600_000), createdAt: new Date(now.getTime() - 600_000), resolvedAt: now },
    ]);
    await ServiceRelationshipModel.create([
      { workspaceId: f.workspace.id, serviceId: api!._id, targetType: 'incident', targetId: resolved!._id, createdBy: f.owner.id, archivedAt: null },
      { workspaceId: f.workspace.id, serviceId: api!._id, targetType: 'incident', targetId: open!._id, createdBy: f.owner.id, archivedAt: null },
      { workspaceId: f.workspace.id, serviceId: api!._id, targetType: 'incident', targetId: overlap!._id, createdBy: f.owner.id, archivedAt: null },
      { workspaceId: f.workspace.id, serviceId: database!._id, targetType: 'incident', targetId: overlap!._id, createdBy: f.owner.id, archivedAt: null },
      { workspaceId: f.other.id, serviceId: new mongoose.Types.ObjectId(), targetType: 'incident', targetId: foreign!._id, createdBy: f.outsider.id, archivedAt: null },
    ]);
    await ServiceRelationshipModel.updateMany({ workspaceId: f.workspace.id, serviceId: database!._id }, { $set: { archivedAt: now } });
    await AlertModel.create([{ workspaceId: f.workspace.id, fingerprint: 'metrics:api:1', title: 'API alert', severity: 'sev2', status: 'open', occurrenceCount: 1, firstReceivedAt: now, lastReceivedAt: now, serviceId: api!.id, correlationId: randomUUID(), createdBy: f.owner.id }, { workspaceId: f.workspace.id, fingerprint: 'metrics:db:1', title: 'DB alert', severity: 'sev2', status: 'resolved', occurrenceCount: 1, firstReceivedAt: now, lastReceivedAt: now, serviceId: database!.id, correlationId: randomUUID(), createdBy: f.owner.id }, { workspaceId: f.other.id, fingerprint: 'metrics:foreign:1', title: 'Foreign', severity: 'sev1', status: 'open', occurrenceCount: 1, firstReceivedAt: now, lastReceivedAt: now, serviceId: api!.id, correlationId: randomUUID(), createdBy: f.outsider.id }]);
    const result = await request(app).get(`/api/workspaces/${f.workspace.id}/reliability/metrics`).query({ from: from.toISOString(), to: new Date(now.getTime() + 1000).toISOString() }).set('Cookie', await f.cookie()).expect(200);
    expect(result.body.alertsByService).toEqual(expect.arrayContaining([{ _id: api!.id, count: 1 }, { _id: database!.id, count: 1 }]));
    expect(result.body.incidentsByService).toEqual(expect.arrayContaining([{ serviceId: api!.id, count: 3, meanResolutionMs: 450_000 }, { serviceId: database!.id, count: 1, meanResolutionMs: 300_000 }]));
    expect(JSON.stringify(result.body)).not.toContain(foreign!.id);
  });

  it('uses time-valid SLO versions and excludes disabled monitor intervals from historical metrics', async () => {
    const f = await fixture(); const base = new Date('2026-09-29T12:00:00.000Z');
    const service = await ServiceModel.create({ workspaceId: f.workspace.id, name: 'History', slug: 'history', lifecycle: 'active', criticality: 'tier1', ownerIds: [f.owner.id], projectIds: [], labels: {}, links: [], createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const archivedAt = new Date(base.getTime() + 20_000);
    const oldSlo = await ServiceLevelObjectiveModel.create({ workspaceId: f.workspace.id, serviceId: service._id, objectiveKey: randomUUID(), name: 'Historical availability', enabled: false, indicatorType: 'availability', objectiveTarget: 99, rollingWindowDays: 7, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [], version: 1, createdAt: new Date(base.getTime() - 60_000), updatedAt: archivedAt, archivedAt, createdBy: f.owner.id, updatedBy: f.owner.id });
    await SloEvaluationModel.create({ workspaceId: f.workspace.id, serviceId: service._id, sloId: oldSlo._id, objectiveKey: oldSlo.objectiveKey, sloVersion: 1, windowStart: new Date(base.getTime() - 86400_000), windowEnd: base, shortWindowStart: new Date(base.getTime() - 300_000), longWindowStart: new Date(base.getTime() - 3600_000), burnWindows: [], state: 'healthy', good: 100, total: 100, compliance: 1, remainingBudget: 1, consumption: 0, shortBurnRate: 0, longBurnRate: 0, breaching: false });
    const monitor = await SyntheticMonitorModel.create({ workspaceId: f.workspace.id, serviceId: service._id, name: 'Historical monitor', enabled: true, url: 'https://history.company.com', method: 'GET', intervalSeconds: 60, timeoutMs: 1000, maxRedirects: 0, expectedStatusMin: 200, expectedStatusMax: 299, monitoringTransitions: [{ enabled: true, at: new Date(base.getTime() - 60_000) }, { enabled: false, at: new Date(base.getTime() + 10_000) }, { enabled: true, at: new Date(base.getTime() + 20_000) }], nextRunAt: new Date(base.getTime() + 60_000), createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    await SyntheticMonitorRunModel.create([{ workspaceId: f.workspace.id, serviceId: service._id, monitorId: monitor._id, scheduledAt: base, idempotencyKey: 'history:failed', status: 'completed', endpointHealthy: false, latencyMs: 10, attemptCount: 1, completedAt: base }, { workspaceId: f.workspace.id, serviceId: service._id, monitorId: monitor._id, scheduledAt: new Date(base.getTime() + 30_000), idempotencyKey: 'history:healthy', status: 'completed', endpointHealthy: true, latencyMs: 10, attemptCount: 1, completedAt: new Date(base.getTime() + 30_000) }]);
    const historical = await request(app).get(`/api/workspaces/${f.workspace.id}/reliability/metrics`).query({ from: new Date(base.getTime() - 60_000).toISOString(), to: new Date(base.getTime() + 10_000).toISOString() }).set('Cookie', await f.cookie()).expect(200);
    expect(historical.body.complianceByService).toEqual(expect.arrayContaining([expect.objectContaining({ serviceId: service.id, compliance: 1 })]));
    const complete = await request(app).get(`/api/workspaces/${f.workspace.id}/reliability/metrics`).query({ from: new Date(base.getTime() - 60_000).toISOString(), to: new Date(base.getTime() + 40_000).toISOString() }).set('Cookie', await f.cookie()).expect(200);
    expect(complete.body.monitor.failureDurationMs).toBe(20_000);
  });
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
    await TaskModel.deleteOne({ _id: task._id });
    await AutomationRuleModel.updateOne(
      { _id: rule._id },
      { enabled: false, archivedAt: new Date() },
    );
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
  it('supports uppercase ObjectIds and maximum-length integration test names', async () => {
    const f = await fixture();
    const base = `/api/workspaces/${f.workspace.id.toUpperCase()}/automation`;
    const cookie = await f.cookie();
    const created = await request(app)
      .post(`${base}/integrations`)
      .set('Cookie', cookie)
      .send({
        name: 'A'.repeat(200),
        type: 'genericWebhook',
        status: 'active',
        endpoint: 'https://hooks.company.com/alerts',
        inboundEvents: [],
        outboundEvents: ['automation.manual'],
      });
    expect(created.status).toBe(201);
    const id = created.body.integration.id as string;
    let stored = await IntegrationModel.findById(id).select('+credentials');
    expect(decryptSecret(stored as NonNullable<typeof stored> & { credentials: string })).toBe(
      created.body.secret,
    );
    const rotated = await request(app)
      .post(`${base}/integrations/${id.toUpperCase()}/rotate`)
      .set('Cookie', cookie)
      .send({});
    expect(rotated.status).toBe(200);
    stored = await IntegrationModel.findById(id).select('+credentials');
    expect(decryptSecret(stored as NonNullable<typeof stored> & { credentials: string })).toBe(
      rotated.body.secret,
    );
    const tested = await request(app)
      .post(`${base}/integrations/${id}/test`)
      .set('Cookie', cookie)
      .send({});
    expect(tested.status).toBe(202);
    const run = await AutomationRunModel.findById(tested.body.run.id).select('+ruleSnapshot');
    expect(run!.ruleSnapshot.name).toHaveLength(200);
    expect(
      (await executeNext({
        resolve: async () => [{ address: '8.8.8.8', family: 4 }],
        send: async () => 204,
      }))!.status,
    ).toBe('succeeded');
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
