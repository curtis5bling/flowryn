/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';

import {
  publicSlugSchema,
  statusHistoryQuerySchema,
  subscriptionInputSchema,
} from '@flowryn/shared';
import { Router } from 'express';
import { Types } from 'mongoose';

import { InboundBucketModel } from '../automation/models.js';
import { encryptSecret } from '../automation/security.js';
import {
  StatusComponentModel,
  StatusEventModel,
  StatusGroupModel,
  StatusHistoryModel,
  StatusPageModel,
  PublicIncidentModel,
  PublicIncidentUpdateModel,
  MaintenanceModel,
  StatusSubscriberModel,
} from '../status/models.js';
import {
  addressHash,
  enqueueStatusEvent,
  overallStatus,
  publicComponent,
  publicIncident,
  publicPage,
  token,
  tokenHash,
  tokenMatches,
} from '../status/service.js';

const router = Router();
const limited = (limit: number, name: string) => async (request: any, response: any, next: any) => {
  try {
    const minute = Math.floor(Date.now() / 60_000);
    // Bucket by client and operation, not slug, so rotating slugs cannot bypass limits.
    const key = `status:${name}:${createHash('sha256').update(`${request.ip}:${minute}`).digest('hex')}`;
    const bucket = await InboundBucketModel.findOneAndUpdate(
      { _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((minute + 2) * 60_000) } },
      { upsert: true, new: true },
    );
    if ((bucket.count ?? 0) > limit)
      return response.status(429).json({ error: 'Too many requests' });
    next();
  } catch (error) {
    next(error);
  }
};
router.use(limited(120, 'general'));
router.use((_request, response, next) => {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
const findPage = async (slug: string, preview?: string) => {
  if (!publicSlugSchema.safeParse(slug).success) return null;
  const query = StatusPageModel.findOne({
    slug,
    enabled: true,
    archivedAt: null,
  });
  if (preview) query.select('+previewTokenHash +previewTokenExpiresAt');
  const page = await query;
  if (!page) return null;
  if (preview) {
    if (
      !tokenMatches(preview, page.previewTokenHash ?? '') ||
      !page.previewTokenExpiresAt ||
      page.previewTokenExpiresAt < new Date()
    )
      return null;
  } else if (!page.publishedAt || page.visibility === 'private-preview') return null;
  return page;
};
const snapshot = async (page: any) => {
  const [groups, components, activeIncidents, incidentHistory, maintenance] = await Promise.all([
    StatusGroupModel.find({
      workspaceId: page.workspaceId,
      statusPageId: page._id,
      enabled: true,
      archivedAt: null,
    })
      .sort({ order: 1 })
      .limit(100),
    StatusComponentModel.find({
      workspaceId: page.workspaceId,
      statusPageId: page._id,
      enabled: true,
      hidden: false,
      archivedAt: null,
    })
      .sort({ order: 1 })
      .limit(200),
    PublicIncidentModel.find({
      workspaceId: page.workspaceId,
      statusPageId: page._id,
      publishedAt: { $ne: null },
      archivedAt: null,
      status: { $ne: 'resolved' },
    })
      .sort({ publishedAt: -1 })
      .limit(100),
    PublicIncidentModel.find({
      workspaceId: page.workspaceId,
      statusPageId: page._id,
      publishedAt: { $ne: null },
      archivedAt: null,
      status: 'resolved',
    })
      .sort({ publishedAt: -1 })
      .limit(20),
    MaintenanceModel.find({
      workspaceId: page.workspaceId,
      statusPageId: page._id,
      status: { $in: ['scheduled', 'inProgress'] },
    })
      .sort({ scheduledStartAt: 1 })
      .limit(50),
  ]);
  const incidents = [...activeIncidents, ...incidentHistory];
  const componentIds = new Map(
    components.map((component) => [String(component._id), component.stableId]),
  );
  const groupIds = new Map(groups.map((group) => [String(group._id), group.stableId]));
  const incidentResults = await Promise.all(
    incidents.map(async (incident) =>
      publicIncident(
        incident,
        (
          await PublicIncidentUpdateModel.find({
            workspaceId: page.workspaceId,
            statusPageId: page._id,
            publicIncidentId: incident._id,
          })
            .sort({ publishedAt: -1, _id: -1 })
            .limit(100)
        ).reverse(),
        componentIds,
      ),
    ),
  );
  const lastUpdatedAt = [page, ...components, ...incidents, ...maintenance]
    .map((record) => record.updatedAt as Date)
    .reduce((latest, value) => (value > latest ? value : latest), page.updatedAt as Date);
  return {
    page: publicPage(page, lastUpdatedAt),
    subscriptionsAvailable: false,
    overallStatus: overallStatus(components.map((x) => x.status as any)),
    groups: groups.map((group) => ({
      id: group.stableId,
      name: group.name,
      description: group.description ?? '',
      slug: group.slug,
      order: group.order,
    })),
    components: components.map((component) => publicComponent(component, groupIds)),
    incidents: incidentResults,
    maintenance: maintenance.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      affectedComponentIds: item.affectedComponentIds
        .map(String)
        .map((id) => componentIds.get(id))
        .filter(Boolean),
      scheduledStartAt: item.scheduledStartAt!.toISOString(),
      scheduledEndAt: item.scheduledEndAt!.toISOString(),
      status: item.status,
    })),
  };
};
router.get('/:slug', async (request, response) => {
  const previewToken =
    typeof request.headers['x-status-preview-token'] === 'string'
      ? request.headers['x-status-preview-token']
      : undefined;
  const page = await findPage(request.params.slug, previewToken);
  if (!page) return response.status(404).json({ error: 'Status page not found' });
  const body = await snapshot(page);
  const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url')}"`;
  response.setHeader('ETag', etag);
  response.setHeader(
    'Cache-Control',
    previewToken ? 'private, no-store' : 'public, max-age=30, stale-while-revalidate=60',
  );
  if (request.headers['if-none-match'] === etag) return response.status(304).end();
  response.json(body);
});
router.get('/:slug/history', async (request, response) => {
  const page = await findPage(request.params.slug);
  if (!page || page.visibility === 'private-preview')
    return response.status(404).json({ error: 'Status page not found' });
  const parsed = statusHistoryQuerySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid history query' });
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - 30 * 86400_000);
  if (from > to || to.getTime() - from.getTime() > 90 * 86400_000)
    return response.status(400).json({ error: 'History range is limited to 90 days' });
  const publicComponents = await StatusComponentModel.find({
    workspaceId: page.workspaceId,
    statusPageId: page._id,
    enabled: true,
    hidden: false,
    archivedAt: null,
  }).select('stableId');
  const rows = await StatusHistoryModel.find({
    workspaceId: page.workspaceId,
    statusPageId: page._id,
    componentId: { $in: publicComponents.map((component) => component._id) },
    changedAt: { $gte: from, $lte: to },
  })
    .select('componentId fromStatus toStatus changedAt')
    .sort({ changedAt: -1 })
    .skip((parsed.data.page - 1) * parsed.data.limit)
    .limit(parsed.data.limit);
  const componentIds = new Map(
    publicComponents.map((component) => [String(component._id), component.stableId]),
  );
  response.setHeader('Cache-Control', 'public, max-age=60');
  response.json({
    items: rows
      .filter((row) => componentIds.has(String(row.componentId)))
      .map((row) => ({
        componentId: componentIds.get(String(row.componentId)),
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        changedAt: row.changedAt.toISOString(),
      })),
  });
});
router.get('/:slug/events', limited(10, 'events'), async (request, response) => {
  const page = await findPage(request.params.slug);
  if (!page || page.visibility === 'private-preview')
    return response.status(404).json({ error: 'Status page not found' });
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'private, no-cache, no-store');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  let cursor = new Date();
  let cursorId: Types.ObjectId | null = null;
  const lastId = request.headers['last-event-id'];
  if (typeof lastId === 'string') {
    const previous = await StatusEventModel.findOne({
      statusPageId: page._id,
      eventId: lastId,
    }).select('createdAt');
    if (previous?.createdAt) {
      cursor = previous.createdAt;
      cursorId = previous._id;
    }
  }
  response.write('event: ready\ndata: {}\n\n');
  let busy = false;
  const poll = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const stillPublic = await StatusPageModel.exists({
        _id: page._id,
        enabled: true,
        archivedAt: null,
        publishedAt: { $ne: null },
        visibility: { $in: ['public', 'unlisted'] },
      });
      if (!stillPublic) {
        clearInterval(poll);
        response.end();
        return;
      }
      const events = await StatusEventModel.find({
        statusPageId: page._id,
        targetSubscriberId: null,
        type: { $regex: /^(component\.|publicIncident\.|maintenance\.)/ },
        $or: [
          { createdAt: { $gt: cursor } },
          ...(cursorId ? [{ createdAt: cursor, _id: { $gt: cursorId } }] : []),
        ],
      })
        .select('eventId type createdAt')
        .sort({ createdAt: 1, _id: 1 })
        .limit(100);
      for (const event of events) {
        response.write(
          `id: ${event.eventId}\nevent: change\ndata: ${JSON.stringify({ type: event.type })}\n\n`,
        );
        cursor = event.createdAt!;
        cursorId = event._id;
      }
    } catch {
      clearInterval(poll);
      response.end();
    } finally {
      busy = false;
    }
  }, 5000);
  const lifetime = setTimeout(() => response.end(), 5 * 60_000);
  const close = () => {
    clearInterval(poll);
    clearTimeout(lifetime);
  };
  request.once('close', close);
  response.once('close', close);
});
router.post('/:slug/subscribe', limited(5, 'subscribe'), async (request, response) => {
  const page = await findPage(request.params.slug);
  const input = subscriptionInputSchema.safeParse(request.body);
  if (page && page.visibility !== 'private-preview' && input.success) {
    const selectedComponents = await StatusComponentModel.find({
      workspaceId: page.workspaceId,
      statusPageId: page._id,
      stableId: { $in: input.data.componentIds },
      enabled: true,
      hidden: false,
      archivedAt: null,
    }).select('_id');
    if (selectedComponents.length !== input.data.componentIds.length) {
      response
        .status(202)
        .json({ message: 'If eligible, verification instructions will be sent.' });
      return;
    }
    const hash = addressHash(page.id, input.data.address, input.data.channel);
    const current = await StatusSubscriberModel.findOne({
      statusPageId: page._id,
      channel: input.data.channel,
      addressHash: hash,
    });
    if (!current && (await StatusSubscriberModel.countDocuments({ statusPageId: page._id })) >= 10000) {
      response.status(202).json({ message: 'If eligible, verification instructions will be sent.' });
      return;
    }
    if (current?.verifiedAt && !current.unsubscribedAt) {
      response
        .status(202)
        .json({ message: 'If eligible, verification instructions will be sent.' });
      return;
    }
    // A page-scoped keyed hash gives concurrent first requests the same record/AAD identity.
    const subscriberId = current?._id ?? new Types.ObjectId(hash.slice(0, 24));
    const encrypted = encryptSecret(
      input.data.address,
      String(page.workspaceId),
      String(subscriberId),
    );
    const verification = token();
    const unsubscribe = token();
    const encryptedVerification = encryptSecret(verification, String(page.workspaceId), String(subscriberId));
    const encryptedUnsubscribe = encryptSecret(unsubscribe, String(page.workspaceId), String(subscriberId));
    let subscriber;
    try {
      subscriber = await StatusSubscriberModel.findOneAndUpdate(
        {
          statusPageId: page._id,
          channel: input.data.channel,
          addressHash: hash,
          ...(current
            ? { _id: current._id, verifiedAt: current.verifiedAt ?? null, unsubscribedAt: current.unsubscribedAt ?? null }
            : {}),
        },
        {
        $set: {
          workspaceId: page.workspaceId,
          ...input.data,
          componentIds: selectedComponents.map((component) => component._id),
          addressCiphertext: encrypted.credentials,
          keyVersion: encrypted.keyVersion,
          verificationTokenHash: tokenHash(verification),
          verificationTokenCiphertext: encryptedVerification.credentials,
          verificationKeyVersion: encryptedVerification.keyVersion,
          verificationExpiresAt: new Date(Date.now() + 86400_000),
          unsubscribeTokenHash: tokenHash(unsubscribe),
          unsubscribeTokenCiphertext: encryptedUnsubscribe.credentials,
          unsubscribeKeyVersion: encryptedUnsubscribe.keyVersion,
          verifiedAt: null,
          unsubscribedAt: null,
        },
        $setOnInsert: {
          _id: subscriberId,
        },
        },
        { upsert: !current, new: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    if (subscriber)
      await enqueueStatusEvent(String(page.workspaceId), page.id, 'subscription.verify', {}, undefined, subscriber.id);
  }
  response.status(202).json({ message: 'If eligible, verification instructions will be sent.' });
});
router.post('/:slug/verify', limited(10, 'verify'), async (request, response) => {
  const page = await findPage(request.params.slug);
  const value = typeof request.body?.token === 'string' ? request.body.token : '';
  if (page && value)
    await StatusSubscriberModel.updateOne(
      {
        statusPageId: page._id,
        verificationTokenHash: tokenHash(value),
        verificationExpiresAt: { $gt: new Date() },
        verifiedAt: null,
      },
      {
        $set: { verifiedAt: new Date() },
        $unset: { verificationTokenHash: 1, verificationTokenCiphertext: 1, verificationKeyVersion: 1, verificationExpiresAt: 1 },
      },
    );
  response.json({ message: 'Subscription request processed.' });
});
router.post('/:slug/resend', limited(5, 'resend'), async (request, response) => {
  const page = await findPage(request.params.slug);
  const input = subscriptionInputSchema.safeParse({
    ...request.body,
    componentIds: [],
    incidents: true,
    maintenance: true,
  });
  if (page && page.visibility !== 'private-preview' && input.success) {
    const subscriber = await StatusSubscriberModel.findOne({
      statusPageId: page._id,
      channel: input.data.channel,
      addressHash: addressHash(page.id, input.data.address, input.data.channel),
      verifiedAt: null,
      unsubscribedAt: null,
    });
    if (subscriber) {
      const verification = token();
      const encrypted = encryptSecret(verification, String(page.workspaceId), subscriber.id);
      subscriber.verificationTokenHash = tokenHash(verification);
      subscriber.verificationTokenCiphertext = encrypted.credentials;
      subscriber.verificationKeyVersion = encrypted.keyVersion;
      subscriber.verificationExpiresAt = new Date(Date.now() + 86400_000);
      await subscriber.save();
      await enqueueStatusEvent(String(page.workspaceId), page.id, 'subscription.verify', {}, undefined, subscriber.id);
    }
  }
  response.status(202).json({ message: 'If eligible, verification instructions will be sent.' });
});
router.post('/:slug/unsubscribe', limited(10, 'unsubscribe'), async (request, response) => {
  const page = publicSlugSchema.safeParse(request.params.slug).success
    ? await StatusPageModel.findOne({ slug: request.params.slug }).select('_id')
    : null;
  const value = typeof request.body?.token === 'string' ? request.body.token : '';
  if (page && value)
    await StatusSubscriberModel.updateOne(
      { statusPageId: page._id, unsubscribeTokenHash: tokenHash(value), unsubscribedAt: null },
      { $set: { unsubscribedAt: new Date() }, $unset: { unsubscribeTokenHash: 1, unsubscribeTokenCiphertext: 1, unsubscribeKeyVersion: 1 } },
    );
  response.json({ message: 'Unsubscribe request processed.' });
});

export default router;
