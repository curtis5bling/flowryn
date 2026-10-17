import { deploymentEventSchema, statusIdSchema } from '@flowryn/shared';
import { raw, Router, type ErrorRequestHandler } from 'express'; import mongoose from 'mongoose'; import { z } from 'zod';

import { InboundBucketModel, IntegrationModel, WebhookDeliveryModel } from '../automation/models.js'; import { decryptSecret, verifySignature } from '../automation/security.js'; import { ChangeDeploymentHistoryModel, ChangeReleaseModel, DeploymentEnvironmentModel } from '../change/models.js'; import { enqueueChangeWork } from '../change/service.js';
import { ProjectModel } from '../models/Project.js';
import { ServiceModel } from '../reliability/models.js';

const router = Router();
const transitions: Record<string, string[]> = { planned: ['ready', 'cancelled'], ready: ['deploying', 'cancelled'], deploying: ['completed', 'failed', 'cancelled'], completed: ['rolled_back'], failed: ['rolled_back'], cancelled: [], rolled_back: [] };
router.post('/:workspaceId/:integrationId', raw({ type: 'application/json', limit: '64kb', inflate: false }), async (request, response) => {
  const deny = () => response.status(401).json({ error: 'Webhook rejected' }); const { workspaceId, integrationId } = request.params;
  if (!statusIdSchema.safeParse(workspaceId).success || !statusIdSchema.safeParse(integrationId).success || !Buffer.isBuffer(request.body)) return void deny();
  const timestamp = request.get('x-flowryn-timestamp') ?? ''; const deliveryId = request.get('x-flowryn-delivery-id') ?? ''; const signature = request.get('x-flowryn-signature') ?? ''; if (!z.string().uuid().safeParse(deliveryId).success) return void deny();
  try { const integration = await IntegrationModel.findOne({ workspaceId, _id: integrationId, status: 'active', archivedAt: null, inboundEvents: 'deployment.received' }).select('+credentials'); if (!integration?.credentials || !verifySignature(decryptSecret(integration as typeof integration & { credentials: string }), timestamp, deliveryId, request.body, signature)) return void deny();
    const minute = Math.floor(Date.now() / 60000); const bucket = await InboundBucketModel.findOneAndUpdate({ _id: `change:${workspaceId}:${integrationId}:${minute}` }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((minute + 2) * 60000) } }, { upsert: true, new: true }); if ((bucket.count ?? 0) > 30) return void response.status(429).json({ error: 'Webhook rejected' });
    const parsed = deploymentEventSchema.safeParse(JSON.parse(request.body.toString('utf8'))); if (!parsed.success || parsed.data.workspaceId !== workspaceId) return void deny();
    const session = await mongoose.startSession(); let duplicate = false; let stale = false;
    try { await session.withTransaction(async () => { const existing = await WebhookDeliveryModel.findOne({ workspaceId, integrationId, direction: 'inbound', deliveryId }).session(session); if (existing) { duplicate = true; return; }
      const release = await ChangeReleaseModel.findOne({ workspaceId, externalId: parsed.data.releaseExternalId }).session(session); if (!release) throw new Error('Rejected');
      const environment = await DeploymentEnvironmentModel.findOneAndUpdate({ workspaceId, _id: release.environmentId, active: true }, { $inc: { __v: 1 } }, { new: true, session });
      const serviceIds = [...new Set(release.serviceIds.map(String))]; const services = await ServiceModel.updateMany({ workspaceId, _id: { $in: serviceIds }, archivedAt: null }, { $inc: { version: 1 } }, { session });
      const project = release.projectId ? await ProjectModel.findOneAndUpdate({ workspaceId, _id: release.projectId, status: 'active' }, { $inc: { __v: 1 } }, { new: true, session }) : true;
      if (!environment || !project || services.matchedCount !== serviceIds.length) throw new Error('Rejected');
      if (parsed.data.sequence <= release.sequence) stale = true;
      else { if (parsed.data.state !== release.state && !transitions[release.state]?.includes(parsed.data.state)) throw new Error('Rejected'); release.state = parsed.data.state; release.sequence = parsed.data.sequence; release.sourceRevision = parsed.data.sourceRevision; release.lastEventAt = new Date(parsed.data.occurredAt); release.revision += 1; if (parsed.data.state === 'completed') release.completedAt = new Date(parsed.data.occurredAt); await release.save({ session }); await ChangeDeploymentHistoryModel.create([{ workspaceId, releaseId: release._id, revision: release.revision, state: release.state, sourceRevision: release.sourceRevision, sequence: release.sequence, occurredAt: release.lastEventAt, eventId: parsed.data.eventId }], { session }); }
      await WebhookDeliveryModel.create([{ workspaceId, integrationId, direction: 'inbound', deliveryId, eventId: parsed.data.eventId, eventType: 'deployment.received', status: 'succeeded', statusCode: 202, cleanupAt: new Date(Date.now() + 90 * 86400_000) }], { session }); const integrationFence = await IntegrationModel.updateOne({ workspaceId, _id: integrationId, status: 'active', archivedAt: null, secretVersion: integration.secretVersion, inboundEvents: 'deployment.received' }, { $set: { lastDeliveryAt: new Date() } }, { session }); if (integrationFence.matchedCount !== 1) throw new Error('Rejected');
    }); } finally { await session.endSession(); }
    if (!duplicate && !stale) { const release = await ChangeReleaseModel.findOne({ workspaceId, externalId: parsed.data.releaseExternalId }).select('_id revision'); if (release) await Promise.all([enqueueChangeWork(workspaceId, 'risk', release._id, String(release.revision)), enqueueChangeWork(workspaceId, parsed.data.state === 'completed' ? 'post-health' : 'pre-health', release._id, String(release.revision)), ...(['completed', 'failed', 'rolled_back'].includes(parsed.data.state) ? [enqueueChangeWork(workspaceId, 'correlation', release._id, String(release.revision))] : [])]); }
    response.status(202).json({ accepted: true, duplicate, stale });
  } catch { deny(); }
});
const errors: ErrorRequestHandler = (_e, _q, response, next) => { void next; response.status(400).json({ error: 'Webhook rejected' }); }; router.use(errors); export default router;
