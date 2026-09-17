import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { issueTokens } from './auth/tokens.js';
import { UserModel } from './models/User.js';
import { WorkspaceModel } from './models/Workspace.js';
import { WorkspaceMemberModel } from './models/WorkspaceMember.js';
import { StatusComponentModel, StatusPageModel, StatusSubscriberModel } from './status/models.js';
import { enqueueStatusEvent } from './status/service.js';
import { processStatusWork, type StatusDeliveryAdapter } from './status/worker.js';

const app = createApp();
let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  process.env.AUTOMATION_ENCRYPTION_KEYS = JSON.stringify({ '1': 'cd'.repeat(32) });
  process.env.AUTOMATION_KEY_VERSION = '1';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 180000);
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  delete process.env.AUTOMATION_ENCRYPTION_KEYS;
  delete process.env.AUTOMATION_KEY_VERSION;
});
const fixture = async () => {
  const [owner, member] = await UserModel.create([
    { name: 'Owner', email: 'owner@status.test', passwordHash: 'unused' },
    { name: 'Member', email: 'member@status.test', passwordHash: 'unused' },
  ]);
  const workspace = await WorkspaceModel.create({ name: 'Status workspace', createdBy: owner!.id });
  await WorkspaceMemberModel.create([
    { workspaceId: workspace.id, userId: owner!.id, role: 'owner' },
    { workspaceId: workspace.id, userId: member!.id, role: 'member' },
  ]);
  const cookie = async (user: typeof owner) => `accessToken=${(await issueTokens(user!.id)).accessToken}`;
  return { owner: owner!, member: member!, workspace, cookie };
};
const pageInput = { name: 'Acme status', slug: 'acme-status', description: 'Public health', visibility: 'public', enabled: true, timezone: 'UTC', branding: { primaryColor: '#123456' }, supportUrl: null };

describe('status page integration', () => {
  it('enforces administrator management and exposes only public allowlisted fields', async () => {
    const f = await fixture();
    const denied = await request(app).post(`/api/workspaces/${f.workspace.id}/status-pages`).set('Cookie', await f.cookie(f.member)).send(pageInput);
    expect(denied.status).toBe(403);
    const created = await request(app).post(`/api/workspaces/${f.workspace.id}/status-pages`).set('Cookie', await f.cookie(f.owner)).send(pageInput);
    expect(created.status).toBe(201);
    const pageId = created.body.page._id as string;
    expect((await request(app).get('/api/status/acme-status')).status).toBe(404);
    await request(app).post(`/api/workspaces/${f.workspace.id}/status-pages/${pageId}/publish`).set('Cookie', await f.cookie(f.owner)).expect(200);
    await request(app).post(`/api/workspaces/${f.workspace.id}/status-pages/${pageId}/components`).set('Cookie', await f.cookie(f.owner)).send({ name: 'API', description: 'Requests', slug: 'public-api', order: 1, groupId: null, status: 'operational', enabled: true, hidden: false }).expect(201);
    await request(app).post(`/api/workspaces/${f.workspace.id}/status-pages/${pageId}/components`).set('Cookie', await f.cookie(f.owner)).send({ name: 'Private', description: 'Hidden', slug: 'private-api', order: 2, groupId: null, status: 'majorOutage', enabled: true, hidden: true }).expect(201);
    const publicResult = await request(app).get('/api/status/acme-status').expect(200);
    expect(publicResult.body.components.map((item: { name: string }) => item.name)).toEqual(['API']);
    expect(JSON.stringify(publicResult.body)).not.toContain(f.workspace.id);
    expect(publicResult.body).not.toHaveProperty('workspaceId');
  });

  it('keeps subscription responses generic and consumes an encrypted verification token once', async () => {
    const f = await fixture();
    const page = await StatusPageModel.create({ ...pageInput, workspaceId: f.workspace.id, createdBy: f.owner.id, updatedBy: f.owner.id, publishedAt: new Date(), archivedAt: null });
    const body = { channel: 'webhook', address: 'https://hooks.example.net/status', componentIds: [], incidents: true, maintenance: true };
    const subscribed = await request(app).post('/api/status/acme-status/subscribe').send(body).expect(202);
    const unknown = await request(app).post('/api/status/unknown-status/subscribe').send(body).expect(202);
    expect(unknown.body).toEqual(subscribed.body);
    const sent: Parameters<StatusDeliveryAdapter['deliver']>[0][] = [];
    await processStatusWork(new Date(), 'test-worker', { deliver: async (message) => { sent.push(message); } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.verificationToken).toBeTruthy();
    await request(app).post('/api/status/acme-status/verify').send({ token: sent[0]!.verificationToken }).expect(200);
    await request(app).post('/api/status/acme-status/verify').send({ token: sent[0]!.verificationToken }).expect(200);
    const subscriber = await StatusSubscriberModel.findOne({ statusPageId: page._id }).select('+verificationTokenHash +verificationTokenCiphertext');
    expect(subscriber!.verifiedAt).toBeTruthy();
    expect(subscriber!.verificationTokenHash).toBeUndefined();
    expect(subscriber!.verificationTokenCiphertext).toBeUndefined();
    await enqueueStatusEvent(f.workspace.id, page.id, 'publicIncident.updated', {});
    await processStatusWork(new Date(), 'test-worker', { deliver: async (message) => { sent.push(message); } });
    expect(sent[1]!.unsubscribeToken).toBeTruthy();
    await request(app).post('/api/status/acme-status/unsubscribe').send({ token: sent[1]!.unsubscribeToken }).expect(200);
    await enqueueStatusEvent(f.workspace.id, page.id, 'publicIncident.updated', {});
    await processStatusWork(new Date(), 'test-worker', { deliver: async (message) => { sent.push(message); } });
    expect(sent).toHaveLength(2);
    await request(app).post('/api/status/acme-status/subscribe').send(body).expect(202);
    await processStatusWork(new Date(), 'test-worker', { deliver: async (message) => { sent.push(message); } });
    expect(sent[2]!.verificationToken).toBeTruthy();
  });

  it('does not overwrite a newer manual component status when maintenance completes', async () => {
    const f = await fixture();
    const page = await StatusPageModel.create({ ...pageInput, workspaceId: f.workspace.id, createdBy: f.owner.id, updatedBy: f.owner.id, publishedAt: new Date(), archivedAt: null });
    const component = await StatusComponentModel.create({ workspaceId: f.workspace.id, statusPageId: page._id, stableId: crypto.randomUUID(), name: 'API', description: '', slug: 'public-api', order: 1, status: 'operational', statusRevision: 0, enabled: true, hidden: false, createdBy: f.owner.id, updatedBy: f.owner.id, archivedAt: null });
    const start = new Date('2026-01-01T00:00:00.000Z');
    await request(app).post(`/api/workspaces/${f.workspace.id}/status-pages/${page.id}/maintenance`).set('Cookie', await f.cookie(f.owner)).send({ title: 'Deploy', description: 'Upgrade', affectedComponentIds: [component.id], scheduledStartAt: start.toISOString(), scheduledEndAt: new Date(start.getTime() + 60000).toISOString(), reminderMinutes: [] }).expect(201);
    await processStatusWork(start, 'test-worker');
    await StatusComponentModel.updateOne({ _id: component._id }, { $set: { status: 'degradedPerformance' }, $inc: { statusRevision: 1 } });
    await processStatusWork(new Date(start.getTime() + 60001), 'test-worker');
    expect((await StatusComponentModel.findById(component._id))!.status).toBe('degradedPerformance');
  });
});
