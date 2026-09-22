import { randomUUID } from 'node:crypto';

import {
  maintenanceInputSchema,
  maintenanceUpdateSchema,
  publicCorrectionInputSchema,
  publicIncidentInputSchema,
  publicUpdateInputSchema,
  statusComponentInputSchema,
  statusComponentStateSchema,
  statusGroupInputSchema,
  statusIdSchema,
  statusPageInputSchema,
} from '@flowryn/shared';
import { Router, type Request } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';

import { assertIncident, IncidentError } from '../incidents/service.js';
import { requireAuth, requireWorkspaceRole } from '../middleware/auth.js';
import { IncidentModel } from '../models/Incident.js';
import {
  StatusComponentModel,
  StatusDeliveryModel,
  StatusGroupModel,
  StatusHistoryModel,
  StatusPageModel,
  PublicIncidentModel,
  PublicIncidentUpdateModel,
  MaintenanceModel,
  StatusSubscriberModel,
} from '../status/models.js';
import {
  appendStatusHistory,
  enqueueStatusEvent,
  normalizePublicSlug,
  publicComponent,
  recordStatusActivity,
  token,
  tokenHash,
  validTimezone,
} from '../status/service.js';

const router = Router();
const base = '/:workspaceId/status-pages';
router.use(base, requireAuth, requireWorkspaceRole('owner', 'admin'));
for (const key of [
  'workspaceId',
  'pageId',
  'componentId',
  'groupId',
  'publicIncidentId',
  'maintenanceId',
  'deliveryId',
])
  router.param(key, (_request, _response, next, value) =>
    statusIdSchema.safeParse(value).success
      ? next()
      : next(new IncidentError(400, 'Invalid identifier')),
  );
const parse = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> => {
  const parsed = schema.safeParse(value);
  assertIncident(parsed.success, 400, 'Invalid status-page request');
  return parsed.data;
};
const scope = (request: Request) => ({
  workspaceId: String(request.params.workspaceId),
  statusPageId: String(request.params.pageId),
});
const actor = (request: Request) => request.auth!.userId;
const uniqueWrite = async <T>(write: Promise<T>, message: string) => {
  try { return await write; }
  catch (error) {
    if ((error as { code?: number }).code === 11000) throw new IncidentError(409, message);
    throw error;
  }
};
const reorderSchema = z.object({
  items: z.array(z.object({ id: statusIdSchema, order: z.number().int().min(0).max(10000) })).min(1).max(200),
}).superRefine((value, context) => {
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length || new Set(value.items.map((item) => item.order)).size !== value.items.length)
    context.addIssue({ code: 'custom', message: 'Reorder IDs and positions must be unique' });
});
const verifyPage = async (request: Request) => {
  const page = await StatusPageModel.findOne({
    workspaceId: request.params.workspaceId,
    _id: request.params.pageId,
    archivedAt: null,
  });
  assertIncident(page, 404, 'Status page not found');
  return page;
};

router.get(base, async (request, response) =>
  response.json({
    pages: await StatusPageModel.find({ workspaceId: request.params.workspaceId, archivedAt: null })
      .sort({ createdAt: -1 })
      .limit(100),
  }),
);
router.post(base, async (request, response) => {
  const input = parse(statusPageInputSchema, request.body);
  const slug = normalizePublicSlug(input.slug);
  assertIncident(validTimezone(input.timezone), 400, 'Invalid timezone');
  try {
    const page = await StatusPageModel.create({
      ...input,
      slug,
      workspaceId: request.params.workspaceId,
      createdBy: actor(request),
      updatedBy: actor(request),
      archivedAt: null,
    });
    await recordStatusActivity(
      request.params.workspaceId,
      actor(request),
      page.id,
      'statusPage.created',
    );
    response.status(201).json({ page });
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      throw new IncidentError(409, 'Public slug already exists');
    throw error;
  }
});
router.patch(`${base}/:pageId`, async (request, response) => {
  const page = await verifyPage(request);
  const input = parse(statusPageInputSchema.partial(), request.body);
  if (input.slug) input.slug = normalizePublicSlug(input.slug);
  if (input.timezone) assertIncident(validTimezone(input.timezone), 400, 'Invalid timezone');
  Object.assign(page, input, { updatedBy: actor(request) });
  page.version++;
  await uniqueWrite(page.save(), 'Public slug already exists');
  await recordStatusActivity(
    request.params.workspaceId,
    actor(request),
    page.id,
    'statusPage.updated',
  );
  response.json({ page });
});
router.post(`${base}/:pageId/publish`, async (request, response) => {
  const page = await verifyPage(request);
  page.publishedAt ??= new Date();
  page.updatedBy = new mongoose.Types.ObjectId(actor(request));
  await page.save();
  await recordStatusActivity(
    request.params.workspaceId,
    actor(request),
    page.id,
    'statusPage.published',
  );
  response.json({ page });
});
router.post(`${base}/:pageId/preview`, async (request, response) => {
  const page = await verifyPage(request);
  const value = token();
  page.previewTokenHash = tokenHash(value);
  page.previewTokenExpiresAt = new Date(Date.now() + 15 * 60_000);
  await page.save();
  response.json({ previewToken: value, expiresAt: page.previewTokenExpiresAt });
});
router.delete(`${base}/:pageId`, async (request, response) => {
  const page = await verifyPage(request);
  page.archivedAt = new Date();
  page.enabled = false;
  await page.save();
  await recordStatusActivity(
    request.params.workspaceId,
    actor(request),
    page.id,
    'statusPage.archived',
  );
  response.status(204).end();
});

router.get(`${base}/:pageId/components`, async (request, response) => {
  await verifyPage(request);
  response.json({
    groups: await StatusGroupModel.find({ ...scope(request), archivedAt: null }).sort({ order: 1 }),
    components: await StatusComponentModel.find({ ...scope(request), archivedAt: null }).sort({
      order: 1,
    }),
  });
});
router.post(`${base}/:pageId/groups`, async (request, response) => {
  await verifyPage(request);
  const input = parse(statusGroupInputSchema, request.body);
  const group = await uniqueWrite(StatusGroupModel.create({
    ...input,
    ...scope(request),
    stableId: randomUUID(),
    createdBy: actor(request),
    updatedBy: actor(request),
    archivedAt: null,
  }), 'Group slug or order already exists');
  response.status(201).json({ group });
});
router.patch(`${base}/:pageId/groups/:groupId`, async (request, response) => {
  await verifyPage(request);
  const input = parse(statusGroupInputSchema.partial(), request.body);
  const group = await uniqueWrite(StatusGroupModel.findOneAndUpdate(
    { ...scope(request), _id: request.params.groupId, archivedAt: null },
    { $set: { ...input, updatedBy: actor(request) } },
    { new: true, runValidators: true },
  ).exec(), 'Group slug or order already exists');
  assertIncident(group, 404, 'Component group not found');
  response.json({ group });
});
router.delete(`${base}/:pageId/groups/:groupId`, async (request, response) => {
  await verifyPage(request);
  assertIncident(
    !(await StatusComponentModel.exists({ ...scope(request), groupId: request.params.groupId, archivedAt: null })),
    409,
    'Move components before archiving this group',
  );
  const group = await StatusGroupModel.findOneAndUpdate(
    { ...scope(request), _id: request.params.groupId, archivedAt: null },
    { $set: { archivedAt: new Date(), enabled: false, updatedBy: actor(request) } },
  );
  assertIncident(group, 404, 'Component group not found');
  response.status(204).end();
});
router.put(`${base}/:pageId/groups/order`, async (request, response) => {
  await verifyPage(request);
  const { items } = parse(reorderSchema, request.body);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const count = await StatusGroupModel.countDocuments({ ...scope(request), _id: { $in: items.map((x) => x.id) }, archivedAt: null }).session(session);
      assertIncident(count === items.length, 400, 'Workspace page groups required');
      for (const item of items) await StatusGroupModel.updateOne({ ...scope(request), _id: item.id }, { $set: { order: item.order, updatedBy: actor(request) } }, { session });
    });
  } finally { await session.endSession(); }
  response.status(204).end();
});
router.post(`${base}/:pageId/components`, async (request, response) => {
  await verifyPage(request);
  const input = parse(statusComponentInputSchema, request.body);
  assertIncident(
    (await StatusComponentModel.countDocuments({ ...scope(request), archivedAt: null })) < 200,
    409,
    'A status page supports at most 200 active components',
  );
  if (input.groupId)
    assertIncident(
      await StatusGroupModel.exists({ ...scope(request), _id: input.groupId, archivedAt: null }),
      400,
      'Invalid component group',
    );
  const component = await uniqueWrite(StatusComponentModel.create({
    ...input,
    ...scope(request),
    stableId: randomUUID(),
    createdBy: actor(request),
    updatedBy: actor(request),
    archivedAt: null,
  }), 'Component slug or order already exists');
  await appendStatusHistory({
    ...scope(request),
    componentId: component.id,
    fromStatus: input.status,
    toStatus: input.status,
    source: 'manual',
    revision: 0,
    createdBy: actor(request),
  });
  await recordStatusActivity(request.params.workspaceId, actor(request), component.id, 'statusComponent.created');
  response.status(201).json({ component });
});
router.patch(`${base}/:pageId/components/:componentId`, async (request, response) => {
  await verifyPage(request);
  const input = parse(statusComponentInputSchema.omit({ status: true }).partial(), request.body);
  if (input.groupId)
    assertIncident(await StatusGroupModel.exists({ ...scope(request), _id: input.groupId, archivedAt: null }), 400, 'Invalid component group');
  const component = await uniqueWrite(StatusComponentModel.findOneAndUpdate(
    { ...scope(request), _id: request.params.componentId, archivedAt: null },
    { $set: { ...input, updatedBy: actor(request) } },
    { new: true, runValidators: true },
  ).exec(), 'Component slug or order already exists');
  assertIncident(component, 404, 'Component not found');
  await recordStatusActivity(request.params.workspaceId, actor(request), component.id, 'statusComponent.updated');
  response.json({ component });
});
router.delete(`${base}/:pageId/components/:componentId`, async (request, response) => {
  await verifyPage(request);
  assertIncident(
    !(await PublicIncidentModel.exists({ ...scope(request), affectedComponentIds: request.params.componentId, status: { $ne: 'resolved' }, archivedAt: null })),
    409,
    'Resolve affected public incidents before archiving this component',
  );
  const component = await StatusComponentModel.findOneAndUpdate(
    { ...scope(request), _id: request.params.componentId, archivedAt: null },
    { $set: { archivedAt: new Date(), enabled: false, hidden: true, updatedBy: actor(request) } },
  );
  assertIncident(component, 404, 'Component not found');
  await recordStatusActivity(request.params.workspaceId, actor(request), component.id, 'statusComponent.archived');
  response.status(204).end();
});
router.put(`${base}/:pageId/components/order`, async (request, response) => {
  await verifyPage(request);
  const { items } = parse(reorderSchema, request.body);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const count = await StatusComponentModel.countDocuments({ ...scope(request), _id: { $in: items.map((x) => x.id) }, archivedAt: null }).session(session);
      assertIncident(count === items.length, 400, 'Workspace page components required');
      for (const item of items) await StatusComponentModel.updateOne({ ...scope(request), _id: item.id }, { $set: { order: item.order, updatedBy: actor(request) } }, { session });
    });
  } finally { await session.endSession(); }
  response.status(204).end();
});
router.patch(`${base}/:pageId/components/:componentId/status`, async (request, response) => {
  await verifyPage(request);
  const status = parse(statusComponentStateSchema, request.body.status);
  const session = await mongoose.startSession();
  let component;
  try {
    await session.withTransaction(async () => {
      component = await StatusComponentModel.findOne({
        ...scope(request),
        _id: request.params.componentId,
        archivedAt: null,
      }).session(session);
      assertIncident(component, 404, 'Component not found');
      if (component.status !== status) {
        const old = component.status;
        component.status = status;
        component.statusRevision++;
        component.updatedBy = new mongoose.Types.ObjectId(actor(request));
        await component.save({ session });
        await appendStatusHistory(
          {
            ...scope(request),
            componentId: component.id,
            fromStatus: old,
            toStatus: status,
            source: 'manual',
            revision: component.statusRevision,
            createdBy: actor(request),
          },
          session,
        );
        await enqueueStatusEvent(
          request.params.workspaceId,
          request.params.pageId,
          'component.statusChanged',
          publicComponent(component),
          session,
        );
        await recordStatusActivity(
          request.params.workspaceId,
          actor(request),
          component.id,
          'statusComponent.statusChanged',
          session,
        );
      }
    });
  } finally {
    await session.endSession();
  }
  response.json({ component });
});

router.get(`${base}/:pageId/incidents`, async (request, response) => {
  await verifyPage(request);
  response.json({ incidents: await PublicIncidentModel.find({ ...scope(request), archivedAt: null }).sort({ publishedAt: -1 }).limit(200) });
});
router.post(`${base}/:pageId/incidents/drafts`, async (request, response) => {
  await verifyPage(request);
  const input = parse(publicIncidentInputSchema.omit({ message: true }), request.body);
  if (input.internalIncidentId)
    assertIncident(await IncidentModel.exists({ workspaceId: request.params.workspaceId, _id: input.internalIncidentId, archivedAt: null }), 400, 'Workspace incident required');
  assertIncident((await StatusComponentModel.countDocuments({ ...scope(request), _id: { $in: input.affectedComponentIds }, archivedAt: null })) === input.affectedComponentIds.length, 400, 'Workspace page components required');
  const incident = await PublicIncidentModel.create({ ...input, ...scope(request), publishedAt: null, resolvedAt: null, createdBy: actor(request), updatedBy: actor(request), archivedAt: null });
  await recordStatusActivity(request.params.workspaceId, actor(request), incident.id, 'publicIncident.draftCreated');
  response.status(201).json({ incident });
});
router.post(`${base}/:pageId/incidents`, async (request, response) => {
  await verifyPage(request);
  const input = parse(publicIncidentInputSchema, request.body);
  if (input.internalIncidentId)
    assertIncident(
      await IncidentModel.exists({
        workspaceId: request.params.workspaceId,
        _id: input.internalIncidentId,
        archivedAt: null,
      }),
      400,
      'Workspace incident required',
    );
  assertIncident(
    (await StatusComponentModel.countDocuments({
      ...scope(request),
      _id: { $in: input.affectedComponentIds },
      archivedAt: null,
    })) === input.affectedComponentIds.length,
    400,
    'Workspace page components required',
  );
  const now = new Date();
  const incident = new PublicIncidentModel({
    ...input,
    ...scope(request),
    publishedAt: now,
    resolvedAt: input.status === 'resolved' ? now : null,
    createdBy: actor(request),
    updatedBy: actor(request),
    archivedAt: null,
  });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await incident.save({ session });
      await PublicIncidentUpdateModel.create(
        [
          {
            ...scope(request),
            publicIncidentId: incident.id,
            status: input.status,
            message: input.message,
            publishedAt: now,
            createdBy: actor(request),
          },
        ],
        { session },
      );
      await enqueueStatusEvent(
        request.params.workspaceId,
        request.params.pageId,
        'publicIncident.created',
        { incidentId: incident.id },
        session,
      );
      await recordStatusActivity(
        request.params.workspaceId,
        actor(request),
        incident.id,
        'publicIncident.published',
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  response.status(201).json({ incident });
});
router.post(`${base}/:pageId/incidents/:publicIncidentId/publish`, async (request, response) => {
  await verifyPage(request);
  const input = parse(publicUpdateInputSchema, request.body);
  const session = await mongoose.startSession();
  let incident;
  try {
    await session.withTransaction(async () => {
      incident = await PublicIncidentModel.findOne({ ...scope(request), _id: request.params.publicIncidentId, publishedAt: null, archivedAt: null }).session(session);
      assertIncident(incident, 404, 'Public incident draft not found');
      const now = new Date();
      incident.status = input.status;
      incident.publishedAt = now;
      incident.resolvedAt = input.status === 'resolved' ? now : null;
      incident.updatedBy = new mongoose.Types.ObjectId(actor(request));
      await incident.save({ session });
      const [update] = await PublicIncidentUpdateModel.create([{ ...scope(request), publicIncidentId: incident.id, ...input, publishedAt: now, createdBy: actor(request) }], { session });
      await enqueueStatusEvent(request.params.workspaceId, request.params.pageId, 'publicIncident.created', { publicIncidentId: incident.id, updateId: update!.id }, session);
      await recordStatusActivity(request.params.workspaceId, actor(request), incident.id, 'publicIncident.published', session);
    });
  } finally { await session.endSession(); }
  response.json({ incident });
});
router.patch(`${base}/:pageId/incidents/:publicIncidentId/link`, async (request, response) => {
  await verifyPage(request);
  const incidentId = request.body?.internalIncidentId === null ? null : parse(statusIdSchema, request.body?.internalIncidentId);
  if (incidentId) assertIncident(await IncidentModel.exists({ workspaceId: request.params.workspaceId, _id: incidentId, archivedAt: null }), 400, 'Workspace incident required');
  const incident = await PublicIncidentModel.findOneAndUpdate(
    { ...scope(request), _id: request.params.publicIncidentId, archivedAt: null },
    { $set: { internalIncidentId: incidentId, updatedBy: actor(request) } },
    { new: true },
  );
  assertIncident(incident, 404, 'Public incident not found');
  await recordStatusActivity(request.params.workspaceId, actor(request), incident.id, incidentId ? 'publicIncident.linked' : 'publicIncident.unlinked');
  response.json({ incident });
});
router.post(`${base}/:pageId/incidents/:publicIncidentId/updates`, async (request, response) => {
  await verifyPage(request);
  const input = parse(publicUpdateInputSchema, request.body);
  const session = await mongoose.startSession();
  let incident;
  let update;
  try {
    await session.withTransaction(async () => {
      incident = await PublicIncidentModel.findOne({
        ...scope(request),
        _id: request.params.publicIncidentId,
        publishedAt: { $type: 'date' },
        archivedAt: null,
      }).session(session);
      assertIncident(incident, 404, 'Public incident not found');
      incident.status = input.status;
      incident.updatedBy = new mongoose.Types.ObjectId(actor(request));
      incident.resolvedAt = input.status === 'resolved' ? (incident.resolvedAt ?? new Date()) : null;
      await incident.save({ session });
      [update] = await PublicIncidentUpdateModel.create(
        [
          {
            ...scope(request),
            publicIncidentId: incident.id,
            ...input,
            publishedAt: new Date(),
            createdBy: actor(request),
          },
        ],
        { session },
      );
      await enqueueStatusEvent(
        request.params.workspaceId,
        request.params.pageId,
        input.status === 'resolved' ? 'publicIncident.resolved' : 'publicIncident.updated',
        { incidentId: incident.id, updateId: update!.id },
        session,
      );
      await recordStatusActivity(
        request.params.workspaceId,
        actor(request),
        incident.id,
        'publicIncident.updated',
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  assertIncident(incident && update, 500, 'Public incident update failed');
  response.status(201).json({ update });
});
router.post(`${base}/:pageId/incidents/:publicIncidentId/corrections`, async (request, response) => {
  await verifyPage(request);
  const input = parse(publicCorrectionInputSchema, request.body);
  const session = await mongoose.startSession();
  let incident;
  let update;
  try {
    await session.withTransaction(async () => {
      incident = await PublicIncidentModel.findOne({
        ...scope(request),
        _id: request.params.publicIncidentId,
        publishedAt: { $type: 'date' },
        archivedAt: null,
      }).session(session);
      assertIncident(incident, 404, 'Public incident not found');
      assertIncident(input.status === incident.status, 400, 'Corrections cannot change incident state');
      assertIncident(
        await PublicIncidentUpdateModel.exists({
          ...scope(request),
          _id: input.correctionOf,
          publicIncidentId: incident._id,
        }).session(session),
        400,
        'Correction target not found',
      );
      [update] = await PublicIncidentUpdateModel.create(
        [{ ...scope(request), publicIncidentId: incident._id, ...input, publishedAt: new Date(), createdBy: actor(request) }],
        { session },
      );
      incident.updatedBy = new mongoose.Types.ObjectId(actor(request));
      await incident.save({ session, timestamps: true });
      await recordStatusActivity(request.params.workspaceId, actor(request), incident.id, 'publicIncident.corrected', session);
      await enqueueStatusEvent(request.params.workspaceId, request.params.pageId, 'publicIncident.updated', { incidentId: incident.id, updateId: update!.id }, session);
    });
  } finally {
    await session.endSession();
  }
  assertIncident(update, 500, 'Public incident correction failed');
  response.status(201).json({ update });
});
router.delete(`${base}/:pageId/incidents/:publicIncidentId`, async (request, response) => {
  await verifyPage(request);
  const incident = await PublicIncidentModel.findOneAndUpdate(
    { ...scope(request), _id: request.params.publicIncidentId, archivedAt: null },
    { $set: { archivedAt: new Date(), updatedBy: actor(request) } },
  );
  assertIncident(incident, 404, 'Public incident not found');
  await recordStatusActivity(request.params.workspaceId, actor(request), incident.id, 'publicIncident.archived');
  response.status(204).end();
});

router.get(`${base}/:pageId/maintenance`, async (request, response) => {
  await verifyPage(request);
  response.json({ maintenance: await MaintenanceModel.find(scope(request)).sort({ scheduledStartAt: -1 }).limit(200) });
});
router.post(`${base}/:pageId/maintenance`, async (request, response) => {
  const page = await verifyPage(request);
  const input = parse(maintenanceInputSchema, request.body);
  assertIncident(validTimezone(page.timezone), 400, 'Invalid page timezone');
  assertIncident(
    (await StatusComponentModel.countDocuments({
      ...scope(request),
      _id: { $in: input.affectedComponentIds },
      archivedAt: null,
    })) === input.affectedComponentIds.length,
    400,
    'Workspace page components required',
  );
  assertIncident(
    !(await MaintenanceModel.exists({
      ...scope(request),
      status: { $in: ['scheduled', 'inProgress'] },
      affectedComponentIds: { $in: input.affectedComponentIds },
      scheduledStartAt: { $lt: new Date(input.scheduledEndAt) },
      scheduledEndAt: { $gt: new Date(input.scheduledStartAt) },
    })),
    409,
    'Maintenance windows cannot overlap for the same component',
  );
  const session = await mongoose.startSession();
  const maintenance = new MaintenanceModel({
    ...scope(request),
    ...input,
    scheduledStartAt: new Date(input.scheduledStartAt),
    scheduledEndAt: new Date(input.scheduledEndAt),
    nextReminderAt: input.reminderMinutes.length
      ? new Date(new Date(input.scheduledStartAt).getTime() - Math.max(...input.reminderMinutes) * 60_000)
      : null,
    createdBy: actor(request),
    updatedBy: actor(request),
  });
  try {
    await session.withTransaction(async () => {
      const reserved = await StatusComponentModel.updateMany(
        {
          ...scope(request),
          _id: { $in: input.affectedComponentIds },
          archivedAt: null,
          maintenanceReservations: {
            $not: {
              $elemMatch: {
                startsAt: { $lt: new Date(input.scheduledEndAt) },
                endsAt: { $gt: new Date(input.scheduledStartAt) },
              },
            },
          },
        },
        {
          $push: {
            maintenanceReservations: {
              maintenanceId: maintenance._id,
              startsAt: new Date(input.scheduledStartAt),
              endsAt: new Date(input.scheduledEndAt),
            },
          },
        },
        { session },
      );
      assertIncident(
        reserved.modifiedCount === input.affectedComponentIds.length,
        409,
        'Maintenance windows cannot overlap for the same component',
      );
      await maintenance.save({ session });
      await enqueueStatusEvent(
        request.params.workspaceId,
        request.params.pageId,
        'maintenance.scheduled',
        { maintenanceId: maintenance.id },
        session,
      );
      await recordStatusActivity(
        request.params.workspaceId,
        actor(request),
        maintenance.id,
        'maintenance.scheduled',
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  response.status(201).json({ maintenance });
});
router.patch(`${base}/:pageId/maintenance/:maintenanceId`, async (request, response) => {
  await verifyPage(request);
  const input = parse(maintenanceUpdateSchema, request.body);
  const maintenance = await MaintenanceModel.findOne({ ...scope(request), _id: request.params.maintenanceId, status: 'scheduled' });
  assertIncident(maintenance, 404, 'Scheduled maintenance not found');
  // Moving a reserved window or changing its component set requires cancel-and-recreate so
  // overlap reservations remain atomic under concurrent writers.
  assertIncident(!input.scheduledStartAt && !input.scheduledEndAt && !input.affectedComponentIds, 409, 'Cancel and recreate to change the maintenance window or components');
  Object.assign(maintenance, input, { updatedBy: actor(request) });
  if (input.reminderMinutes)
    maintenance.nextReminderAt = input.reminderMinutes.length
      ? new Date(maintenance.scheduledStartAt!.getTime() - Math.max(...input.reminderMinutes) * 60_000)
      : null;
  await maintenance.save();
  await enqueueStatusEvent(request.params.workspaceId, request.params.pageId, 'maintenance.updated', { maintenanceId: maintenance.id });
  await recordStatusActivity(request.params.workspaceId, actor(request), maintenance.id, 'maintenance.updated');
  response.json({ maintenance });
});
router.post(`${base}/:pageId/maintenance/:maintenanceId/start`, async (request, response) => {
  await verifyPage(request);
  const now = new Date();
  const session = await mongoose.startSession();
  let maintenance;
  try {
    await session.withTransaction(async () => {
      maintenance = await MaintenanceModel.findOne({ ...scope(request), _id: request.params.maintenanceId, status: 'scheduled' }).session(session);
      assertIncident(maintenance, 404, 'Scheduled maintenance not found');
      assertIncident(!(await StatusComponentModel.exists({
        ...scope(request),
        _id: { $in: maintenance.affectedComponentIds },
        maintenanceReservations: { $elemMatch: { maintenanceId: { $ne: maintenance._id }, startsAt: { $lt: maintenance.scheduledEndAt }, endsAt: { $gt: now } } },
      }).session(session)), 409, 'Maintenance windows cannot overlap for the same component');
      await StatusComponentModel.updateMany(
        { ...scope(request), _id: { $in: maintenance.affectedComponentIds }, 'maintenanceReservations.maintenanceId': maintenance._id },
        { $set: { 'maintenanceReservations.$[reservation].startsAt': now } },
        { session, arrayFilters: [{ 'reservation.maintenanceId': maintenance._id }] },
      );
      maintenance.scheduledStartAt = now;
      maintenance.nextReminderAt = null;
      maintenance.updatedBy = new mongoose.Types.ObjectId(actor(request));
      await maintenance.save({ session });
      await recordStatusActivity(request.params.workspaceId, actor(request), maintenance.id, 'maintenance.started', session);
    });
  } finally { await session.endSession(); }
  response.status(202).json({ maintenance });
});
router.post(`${base}/:pageId/maintenance/:maintenanceId/complete`, async (request, response) => {
  await verifyPage(request);
  const maintenance = await MaintenanceModel.findOneAndUpdate(
    { ...scope(request), _id: request.params.maintenanceId, status: 'inProgress' },
    { $set: { scheduledEndAt: new Date(), updatedBy: actor(request) } },
    { new: true },
  );
  assertIncident(maintenance, 404, 'In-progress maintenance not found');
  await recordStatusActivity(request.params.workspaceId, actor(request), maintenance.id, 'maintenance.completed');
  response.status(202).json({ maintenance });
});
router.post(`${base}/:pageId/maintenance/:maintenanceId/cancel`, async (request, response) => {
  await verifyPage(request);
  const session = await mongoose.startSession();
  let maintenance;
  try {
    await session.withTransaction(async () => {
      maintenance = await MaintenanceModel.findOne({
        ...scope(request), _id: request.params.maintenanceId, status: { $in: ['scheduled', 'inProgress'] },
      }).session(session);
      assertIncident(maintenance, 404, 'Active maintenance not found');
      if (maintenance.status === 'inProgress') {
        for (const snapshot of maintenance.componentSnapshots as Array<{ componentId: mongoose.Types.ObjectId; status: string; revision: number }>) {
          const component = await StatusComponentModel.findOne({
            ...scope(request), _id: snapshot.componentId, status: 'maintenance', statusRevision: snapshot.revision + 1,
          }).session(session);
          if (!component) continue;
          component.status = parse(statusComponentStateSchema, snapshot.status);
          component.statusRevision++;
          component.updatedBy = new mongoose.Types.ObjectId(actor(request));
          await component.save({ session });
          await appendStatusHistory({ ...scope(request), componentId: component.id, fromStatus: 'maintenance', toStatus: snapshot.status, source: 'maintenance', sourceId: maintenance.id, revision: component.statusRevision, createdBy: actor(request) }, session);
        }
      }
      maintenance.status = 'cancelled';
      maintenance.cancelledAt = new Date();
      maintenance.updatedBy = new mongoose.Types.ObjectId(actor(request));
      await maintenance.save({ session });
      await StatusComponentModel.updateMany({ ...scope(request), _id: { $in: maintenance.affectedComponentIds } }, { $pull: { maintenanceReservations: { maintenanceId: maintenance._id } } }, { session });
      await enqueueStatusEvent(request.params.workspaceId, request.params.pageId, 'maintenance.cancelled', { maintenanceId: maintenance.id }, session);
      await recordStatusActivity(request.params.workspaceId, actor(request), maintenance.id, 'maintenance.cancelled', session);
    });
  } finally { await session.endSession(); }
  response.json({ maintenance });
});
router.get(`${base}/:pageId/subscribers`, async (request, response) => {
  await verifyPage(request);
  const [all, verified, active] = await Promise.all([
    StatusSubscriberModel.countDocuments(scope(request)),
    StatusSubscriberModel.countDocuments({ ...scope(request), verifiedAt: { $ne: null } }),
    StatusSubscriberModel.countDocuments({ ...scope(request), verifiedAt: { $ne: null }, unsubscribedAt: null }),
  ]);
  response.json({ counts: { all, verified, active } });
});
router.get(`${base}/:pageId/deliveries`, async (request, response) => {
  await verifyPage(request);
  const deliveries = await StatusDeliveryModel.find({ ...scope(request), status: { $in: ['failed', 'dead'] } })
    .select('eventId status attemptCount errorCode createdAt updatedAt')
    .sort({ updatedAt: -1 }).limit(100);
  response.json({ deliveries });
});
router.post(`${base}/:pageId/deliveries/:deliveryId/retry`, async (request, response) => {
  await verifyPage(request);
  const delivery = await StatusDeliveryModel.findOneAndUpdate(
    { ...scope(request), _id: request.params.deliveryId, status: { $in: ['failed', 'dead'] } },
    { $set: { status: 'pending', availableAt: new Date(), errorCode: null, attemptCount: 0 } },
    { new: true },
  );
  assertIncident(delivery, 404, 'Retryable delivery not found');
  response.json({ delivery });
});
router.get(`${base}/:pageId/metrics`, async (request, response) => {
  await verifyPage(request);
  const since = new Date(Date.now() - 365 * 86400_000);
  const [components, componentRecords, subscribers, deliveries, incidentMetrics, maintenanceMetrics] = await Promise.all([
    StatusComponentModel.aggregate([
      {
        $match: {
          workspaceId: new mongoose.Types.ObjectId(request.params.workspaceId),
          statusPageId: new mongoose.Types.ObjectId(request.params.pageId),
          archivedAt: null,
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    StatusComponentModel.find({ ...scope(request), createdAt: { $lte: new Date() }, $or: [{ archivedAt: null, enabled: true, hidden: false }, { archivedAt: { $gte: since } }] })
      .select('_id status createdAt archivedAt').limit(200),
    StatusSubscriberModel.countDocuments({
      ...scope(request),
      verifiedAt: { $ne: null },
      unsubscribedAt: null,
    }),
    StatusDeliveryModel.aggregate([
      {
        $match: {
          workspaceId: new mongoose.Types.ObjectId(request.params.workspaceId),
          statusPageId: new mongoose.Types.ObjectId(request.params.pageId),
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    PublicIncidentModel.aggregate([
      { $match: {
        workspaceId: new mongoose.Types.ObjectId(request.params.workspaceId),
        statusPageId: new mongoose.Types.ObjectId(request.params.pageId),
        publishedAt: { $gte: since },
        archivedAt: null,
      } },
      { $facet: {
        totals: [{ $group: { _id: null, count: { $sum: 1 } } }],
        durations: [
          { $match: { resolvedAt: { $ne: null } } },
          { $group: { _id: null, mean: { $avg: { $subtract: ['$resolvedAt', '$publishedAt'] } } } },
        ],
        months: [
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$publishedAt', timezone: 'UTC' } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        publication: [
          { $match: { internalIncidentId: { $ne: null } } },
          { $lookup: { from: IncidentModel.collection.name, localField: 'internalIncidentId', foreignField: '_id', as: 'internal' } },
          { $unwind: '$internal' },
          { $match: { $expr: { $eq: ['$internal.workspaceId', '$workspaceId'] } } },
          { $group: { _id: null, mean: { $avg: { $subtract: ['$publishedAt', '$internal.createdAt'] } } } },
        ],
      } },
    ]),
    MaintenanceModel.aggregate([
      { $match: {
        workspaceId: new mongoose.Types.ObjectId(request.params.workspaceId),
        statusPageId: new mongoose.Types.ObjectId(request.params.pageId),
        status: 'completed',
        startedAt: { $gte: since, $ne: null },
        completedAt: { $ne: null },
      } },
      { $group: { _id: null, mean: { $avg: { $subtract: ['$completedAt', '$startedAt'] } } } },
    ]),
  ]);
  const deliveryCounts = Object.fromEntries(deliveries.map((x) => [x._id, x.count]));
  const totalDeliveries = Object.values(deliveryCounts).reduce((sum: number, count) => sum + Number(count), 0);
  const now = Date.now();
  let recordedMs = 0;
  let operationalMs = 0;
  let recordedStatusTransitions = 0;
  const intervals = new Map(componentRecords.map((component) => [component.id, {
    component,
    cursor: Math.max(since.getTime(), component.createdAt!.getTime()),
    state: undefined as string | undefined,
  }]));
  const historyCursor = StatusHistoryModel.find({
    ...scope(request),
    componentId: { $in: componentRecords.map((component) => component._id) },
    changedAt: { $gte: since, $lte: new Date(now) },
  }).select('componentId fromStatus toStatus changedAt').sort({ componentId: 1, changedAt: 1 }).cursor({ batchSize: 500 });
  for await (const row of historyCursor) {
    const interval = intervals.get(String(row.componentId));
    if (!interval) continue;
    interval.state ??= row.fromStatus ?? interval.component.status ?? 'operational';
    const componentEnd = Math.min(now, interval.component.archivedAt?.getTime() ?? now);
    const end = Math.min(componentEnd, Math.max(interval.cursor, row.changedAt.getTime()));
    if (interval.state === 'operational') operationalMs += Math.max(0, end - interval.cursor);
    recordedMs += Math.max(0, end - interval.cursor);
    interval.cursor = end;
    interval.state = row.toStatus ?? interval.state;
    recordedStatusTransitions++;
  }
  for (const component of componentRecords) {
    const interval = intervals.get(component.id)!;
    const state = interval.state ?? component.status ?? 'operational';
    const componentEnd = Math.min(now, component.archivedAt?.getTime() ?? now);
    if (state === 'operational') operationalMs += Math.max(0, componentEnd - interval.cursor);
    recordedMs += Math.max(0, componentEnd - interval.cursor);
  }
  const incidentSummary = incidentMetrics[0] ?? { totals: [], durations: [], months: [], publication: [] };
  response.json({
    components: Object.fromEntries(components.map((x) => [x._id, x.count])),
    subscribers,
    deliveries: deliveryCounts,
    deliverySuccessRate: totalDeliveries ? (deliveryCounts.succeeded ?? 0) / totalDeliveries : null,
    publicIncidentsLast365Days: incidentSummary.totals[0]?.count ?? 0,
    publicIncidentsByMonth: incidentSummary.months.map((item: { _id: string; count: number }) => ({ month: item._id, count: item.count })),
    meanIncidentDurationMs: incidentSummary.durations[0]?.mean ?? null,
    meanMaintenanceDurationMs: maintenanceMetrics[0]?.mean ?? null,
    recordedAvailability: recordedMs ? operationalMs / recordedMs : null,
    meanInternalToPublicPublicationMs: incidentSummary.publication[0]?.mean ?? null,
    recordedStatusTransitions,
    availabilityNotice:
      'Availability reflects Flowryn recorded public status history, not independent external monitoring.',
  });
});

export default router;
