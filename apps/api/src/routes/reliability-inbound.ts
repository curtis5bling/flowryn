import { signedSliBatchSchema, statusIdSchema } from '@flowryn/shared';
import { raw, Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';

import { InboundBucketModel, IntegrationModel, WebhookDeliveryModel } from '../automation/models.js';
import { decryptSecret, verifySignature } from '../automation/security.js';
import { ingestSliBatch } from '../reliability/service.js';

const router = Router();
router.post('/:workspaceId/:integrationId', raw({ type: 'application/json', limit: '64kb', inflate: false }), async (request, response) => {
  const deny = () => response.status(401).json({ error: 'Webhook rejected' });
  const { workspaceId, integrationId } = request.params;
  if (!statusIdSchema.safeParse(workspaceId).success || !statusIdSchema.safeParse(integrationId).success || !Buffer.isBuffer(request.body)) return void deny();
  const timestamp = request.get('x-flowryn-timestamp') ?? ''; const deliveryId = request.get('x-flowryn-delivery-id') ?? ''; const signature = request.get('x-flowryn-signature') ?? '';
  if (!z.string().uuid().safeParse(deliveryId).success) return void deny();
  try {
    const minute = Math.floor(Date.now() / 60000);
    const bucket = await InboundBucketModel.findOneAndUpdate({ _id: `sli:${workspaceId}:${integrationId}:${minute}` }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((minute + 2) * 60000) } }, { upsert: true, new: true });
    if ((bucket.count ?? 0) > 30) return void response.status(429).json({ error: 'Webhook rejected' });
    const integration = await IntegrationModel.findOne({ workspaceId, _id: integrationId, status: 'active', archivedAt: null, inboundEvents: 'sli.received' }).select('+credentials');
    if (!integration?.credentials || !verifySignature(decryptSecret(integration as typeof integration & { credentials: string }), timestamp, deliveryId, request.body, signature)) return void deny();
    try { await WebhookDeliveryModel.create({ workspaceId, integrationId, direction: 'inbound', deliveryId, eventId: deliveryId, eventType: 'sli.received', status: 'pending' }); } catch (error) { if ((error as { code?: number }).code === 11000) return void deny(); throw error; }
    const parsed = signedSliBatchSchema.safeParse(JSON.parse(request.body.toString('utf8')));
    if (!parsed.success) return void deny();
    const result = await ingestSliBatch({ workspaceId, source: 'webhook', sourceId: integrationId, batch: { samples: parsed.data.samples } });
    await WebhookDeliveryModel.updateOne({ workspaceId, integrationId, direction: 'inbound', deliveryId, status: 'pending' }, { $set: { status: 'succeeded', statusCode: 202, cleanupAt: new Date(Date.now() + 90 * 86400_000) } });
    response.status(202).json(result);
  } catch { await WebhookDeliveryModel.updateOne({ workspaceId, integrationId, direction: 'inbound', deliveryId, status: 'pending' }, { $set: { status: 'failed', statusCode: 400, cleanupAt: new Date(Date.now() + 90 * 86400_000) } }); deny(); }
});
const errors: ErrorRequestHandler = (_error, _request, response, next) => { void next; response.status(400).json({ error: 'Webhook rejected' }); };
router.use(errors);
export default router;
